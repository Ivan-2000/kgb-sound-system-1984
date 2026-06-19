#include <napi.h>
#include <portaudio.h>
#include <pa_win_wasapi.h>
#include <opus.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <vector>

#ifdef KGB_WITH_VST
#include "vst/vstHost.h"
#endif

#ifdef _WIN32
#include <windows.h>

// PortAudio on Windows returns device names via system ANSI codepage (CP_ACP)
// for some backends (MME, DirectSound). Detect and convert to UTF-8 so
// Napi::String::New receives a valid UTF-8 sequence on all locales.
static std::string ensureUtf8(const char* s) {
  if (!s || *s == '\0') return "";
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, nullptr, 0) > 0)
    return s;
  int wlen = MultiByteToWideChar(CP_ACP, 0, s, -1, nullptr, 0);
  if (wlen == 0) return s;
  std::wstring ws(wlen, L'\0');
  MultiByteToWideChar(CP_ACP, 0, s, -1, ws.data(), wlen);
  int ulen = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (ulen == 0) return s;
  std::string result(ulen, '\0');
  WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, result.data(), ulen, nullptr, nullptr);
  if (!result.empty() && result.back() == '\0') result.pop_back();
  return result;
}
#else
static std::string ensureUtf8(const char* s) { return s ? s : ""; }
#endif

// Tracks whether Pa_Initialize has been called.
// Managed by paInit() / paTerminate() — NOT by getDevices().
static bool g_paInitialized = false;

// ─── A3 stream state ──────────────────────────────────────────────────────────
// Single active stream model — Phase 1 needs only one capture device per
// participant. Multi-stream support is a Phase 2 concern.
struct PcmChunk {
  float* data;
  size_t frames;
  size_t channels;
};

static PaStream* g_stream = nullptr;
// Channel counts written from JS thread (before Pa_StartStream) and read from
// the RT callback. Atomic with release/acquire to avoid data race UB.
static std::atomic<int> g_streamInputChannels{0};
static std::atomic<int> g_streamOutputChannels{0};
static std::atomic<float> g_monitorGain{0.0f};
// Master output gain — scales the whole output bus (monitor + peers + softmix)
// just before the safety limiter. Default 1.0 (unity). Persists across
// open/close/reinit so the user's master fader setting is not lost on a device
// change; resets to unity only on a fresh utility process (engine respawn).
static std::atomic<float> g_masterGain{1.0f};
static Napi::ThreadSafeFunction g_pcmTsfn;
static std::atomic<bool> g_tsfnAlive{false};

// E5: stream generation, bumped on every openStream (under g_opusMx). The RT
// callback stamps every ring slot with the current generation; the worker
// thread discards any slot whose generation no longer matches — this is what
// makes a reinit (close→open) safe even if the OS reuses a freed encoder
// pointer (would otherwise re-introduce the §2.1 stale-PCM corruption via ABA).
static std::atomic<uint32_t> g_streamGen{0};

// ─── A4 Opus encoder state ───────────────────────────────────────────────────
// Max 64 input channels (covers even pro multichannel interfaces).
// Max Opus frame: 60ms × 48kHz = 2880 samples.
static const int MAX_INPUT_CH     = 64;
static const int MAX_OPUS_FRAME   = 2880;
static const int OPUS_MAX_PACKET  = 4000; // bytes, safe upper bound per RFC 6716

struct OpusChannelState {
  OpusEncoder* enc;
  int   frameSize;            // set from frameMs * sampleRate / 1000 on openStream
  float accumBuf[MAX_OPUS_FRAME]; // pre-allocated, written/read only from RT callback
  int   accumCount;           // samples accumulated so far (RT callback only)
  uint32_t sequence;          // monotonic counter, RT callback only
};

// Zeroed at module load.
static OpusChannelState g_opusCh[MAX_INPUT_CH];
static std::atomic<int>  g_opusNumCh{0}; // set (release) before Pa_StartStream

static Napi::ThreadSafeFunction g_opusTsfn;
static std::atomic<bool>        g_opusTsfnAlive{false};

// ─── E5: Opus worker thread (§9.A.1 / §1.5) ──────────────────────────────────
// The RT callback no longer mallocs or runs opus_encode/decode. Instead a single
// dedicated worker thread (one per process) owns all heavy codec work:
//   • encode:  RT writes raw PCM frames into a lock-free SPSC ring (g_encRing);
//              the worker pops them, calls opus_encode_float(), and ships the
//              encoded packet to JS via g_opusTsfn.
//   • PCM tap: RT writes raw input blocks into a second SPSC ring (g_pcmRing);
//              the worker pops them and ships to JS via g_pcmTsfn (recorder/VU).
//   • decode:  PushInboundOpus (JS thread) enqueues raw packets into
//              g_decodeQueue; the worker pops, runs the jitter buffer +
//              opus_decode_float(), and pushes PCM into the per-peer PeerRing
//              (consumed by the RT callback exactly as before).
// The RT thread is the SOLE producer of the two SPSC rings and never blocks.
// g_opusMx serialises the worker's codec usage against codec create/destroy
// (openStream/closeStream) and TSFN release — none of which run on the RT thread.

// Carries one ENCODED Opus packet from the worker thread back to the JS thread.
struct OpusOutJob {
  int          channelIndex;
  uint32_t     sequence;
  int64_t      timestampUs;       // Pa stream time in µs at the frame start
  int          len;
  unsigned char data[OPUS_MAX_PACKET];
};

// Lock-free SPSC encode ring: RT callback = sole producer, worker = sole consumer.
// Each slot holds one full Opus frame of PCM (no malloc on either side).
struct EncodeSlot {
  int      channelIndex;
  uint32_t sequence;
  int64_t  timestampUs;
  int      frameSize;
  uint32_t gen;                   // stream generation — worker drops stale slots
  float    pcm[MAX_OPUS_FRAME];
};
static const int ENC_RING_SLOTS = 128;   // power of two; handles a 64-ch burst ×2
static EncodeSlot           g_encRing[ENC_RING_SLOTS];
static std::atomic<uint32_t> g_encWpos{0};   // RT producer
static std::atomic<uint32_t> g_encRpos{0};   // worker consumer

// Lock-free SPSC PCM ring: RT callback = sole producer, worker = sole consumer.
// One slot per callback block. Slot is sized for the worst case (64 ch × 512
// frames) so the RT memcpy is always in-bounds.
struct PcmSlot {
  uint32_t frames;
  uint32_t channels;
  uint32_t gen;
  float    data[MAX_INPUT_CH * 512];
};
static const int PCM_RING_SLOTS = 8;     // power of two
static PcmSlot              g_pcmRing[PCM_RING_SLOTS];
static std::atomic<uint32_t> g_pcmWpos{0};   // RT producer
static std::atomic<uint32_t> g_pcmRpos{0};   // worker consumer

// Worker thread + synchronisation (all non-RT).
static std::thread             g_opusThread;
static std::atomic<bool>       g_opusThreadRun{false};
// g_opusMx guards codec lifecycle (encoder/decoder/peer create+destroy, pending
// gains) and TSFN use vs Release. Held by the worker during encode/decode and by
// the rare JS-thread ops (open/closeStream, setRemoteChannelGain) — NOT by the
// frequent PushInboundOpus / PushSoftmix / GetStats, so the JS event loop never
// blocks on codec work.
static std::mutex              g_opusMx;
// g_decodeQueueMx guards ONLY the inbound queue + condvar — held for the duration
// of a push/pop (microseconds), never across a decode. Keeping it separate from
// g_opusMx is what stops PushInboundOpus (JS thread) from stalling behind the
// worker's opus_decode_float (§1.5).
static std::mutex              g_decodeQueueMx;
static std::condition_variable g_opusCv;   // wakes worker for inbound packets / shutdown

// Inbound Opus packet handed from the JS thread (PushInboundOpus) to the worker.
// Allocated on the JS thread — std::string / std::vector are fine here (not RT).
struct InboundPkt {
  std::string          key;       // "peerId/channelId"
  uint32_t             sequence;
  std::vector<uint8_t> payload;
};
static std::deque<InboundPkt> g_decodeQueue;        // guarded by g_decodeQueueMx
static const size_t           DECODE_QUEUE_MAX = 2048;  // defensive backlog cap

// ─── A4.5 Stats counters (monotonic — UI diffs them) ─────────────────────────
// xrunCount: paInputOverflow + paOutputUnderflow events from PaStreamCallbackFlags.
// dropCount:  frames dropped when any TSFN NonBlockingCall returns napi_queue_full.
// opusTsfnFill: manual queue-depth tracker for the opus TSFN (queue size = 64).
static std::atomic<uint64_t> g_xrunCount{0};
static std::atomic<uint64_t> g_dropCount{0};
static std::atomic<int64_t>  g_opusTsfnFill{0};

// ─── A4b Opus decoder state ───────────────────────────────────────────────────
// One OpusDecoder* per (peerId, channelId) pair, created lazily on first packet.
// PeerDecState is heap-allocated; g_peerSlots holds atomic pointers so the RT
// callback can read them (acquire) while the JS thread writes (release).
// Cleanup happens in cleanupDecoderState() after Pa_StopStream() ensures the RT
// callback is no longer executing.

static const int MAX_PEERS         = 32;
static const int PEER_RING_CAP     = 1 << 16; // 65536 floats ≈ 1.36 s at 48 kHz
static const int JITTER_HOLD       = 2;        // min queued packets before forcing PLC
static const int JITTER_MAX        = 8;        // evict oldest when queue exceeds this
static const int DEC_FRAME_DEFAULT = 960;      // 20 ms @ 48 kHz, for PLC before first decode

// SPSC ring: JS thread is the sole producer (push), RT callback is the sole consumer.
struct PeerRing {
  float                 buf[PEER_RING_CAP];
  std::atomic<uint32_t> wpos{0};
  std::atomic<uint32_t> rpos{0};

  // Push n decoded samples.  Returns false and increments g_dropCount if the
  // ring is full (e.g. capture-only stream — rpos never advances, or consumer
  // fell behind).  Caller should not retry; the frame is lost.
  bool push(const float* src, int n) {
    const uint32_t w         = wpos.load(std::memory_order_relaxed);
    const uint32_t r         = rpos.load(std::memory_order_acquire);
    const uint32_t freeSlots = static_cast<uint32_t>(PEER_RING_CAP) - (w - r);
    if (static_cast<uint32_t>(n) > freeSlots) {
      g_dropCount.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    for (int i = 0; i < n; i++)
      buf[(w + i) & (PEER_RING_CAP - 1)] = src[i];
    wpos.store(w + static_cast<uint32_t>(n), std::memory_order_release);
    return true;
  }
};

struct PeerDecState {
  std::string                              key;           // "peerId/channelId"
  OpusDecoder*                             dec    = nullptr;
  int                                      fsize  = 0;   // learned on first decode; 0 → use default for PLC
  uint32_t                                 nextSeq = 0;
  bool                                     seqInit = false;
  std::map<uint32_t, std::vector<uint8_t>> jitter;
  PeerRing                                 ring;
  // M4: per-channel gain. Written from JS thread, read from RT callback — must be atomic.
  // Default 1.0 (unity). Mute is implemented as gain=0 by the JS caller.
  std::atomic<float>                       gain{1.0f};
  // M5: per-channel RMS level, leaky integrator: lvl = 0.9*lvl + 0.1*frameRms.
  // Written exclusively from PaCallback (RT), read from JS thread (GetStats) — atomic to prevent tearing.
  std::atomic<float>                       rmsLevel{0.0f};
  // §1.3: EWMA of ring fill level (samples). Written + read only from RT callback.
  // Used to detect ADC-clock/DAC-clock drift and compensate by ±1 sample/callback.
  std::atomic<float>                       fillEwma{0.0f};

  PeerDecState() = default;
  PeerDecState(const PeerDecState&) = delete;
  PeerDecState& operator=(const PeerDecState&) = delete;
};

// M4: gains set before the first packet arrives (no PeerDecState yet).
// Accessed only from the JS thread — no synchronisation needed.
static std::map<std::string, float> g_pendingGains;

// Zero-initialised at module load (nullptr for all slots).
static std::atomic<PeerDecState*> g_peerSlots[MAX_PEERS];

// ─── Softmix ring ─────────────────────────────────────────────────────────────
// Receives mono float32 PCM from the Web Audio → PortAudio bridge.
// AudioWorklet captures Tone.js master output and forwards it here via IPC.
// Ring capacity: 8192 samples ≈ 170 ms at 48 kHz (power-of-two for index masking).
// Producer: utility JS thread (PushSoftmix).  Consumer: RT callback (PaCallback).
// §1.1 target fill: ~5 ms ahead (256 samples at 48 kHz). EWMA tracks actual fill;
// rpos is adjusted by ±1 sample/callback to compensate AudioContext vs PA clock drift.
static constexpr uint32_t SOFTMIX_RING_CAP    = 8192u;
static constexpr uint32_t SOFTMIX_TARGET_FILL = 256u;   // §1.1: ~5 ms playout target
static float              g_softmixBuf[SOFTMIX_RING_CAP] = {};
static std::atomic<uint32_t> g_softmixRpos{0};
static std::atomic<uint32_t> g_softmixWpos{0};
static float              g_softmixFillEwma = 0.0f;     // §1.1: RT-only, no atomic needed

// ─── hostApiKind helpers ──────────────────────────────────────────────────────
static const char* hostApiKind(PaHostApiTypeId t) {
  switch (t) {
    case paMME:         return "MME";
    case paDirectSound: return "DirectSound";
    case paASIO:        return "ASIO";
    case paCoreAudio:   return "CoreAudio";
    case paOSS:         return "OSS";
    case paALSA:        return "ALSA";
    case paJACK:        return "JACK";
    case paWASAPI:      return "WASAPI";
    case paWDMKS:       return "WDMKS";
    default:            return "Unknown";
  }
}

static Napi::Object makeHostApiObj(Napi::Env env, const char* kind, const char* name) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("kind", Napi::String::New(env, kind));
  o.Set("name", Napi::String::New(env, name ? name : kind));
  return o;
}

// ─── paInit / paTerminate ─────────────────────────────────────────────────────

Napi::Value PaInit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_paInitialized) return env.Undefined();
  PaError err = Pa_Initialize();
  if (err != paNoError) {
    Napi::Error::New(env, std::string("Pa_Initialize: ") + Pa_GetErrorText(err))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_paInitialized = true;
  return env.Undefined();
}

Napi::Value PaTerminate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_paInitialized) return env.Undefined();
  Pa_Terminate();
  g_paInitialized = false;
  return env.Undefined();
}

// ─── getDevices ───────────────────────────────────────────────────────────────

Napi::Value GetDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_paInitialized) {
    Napi::Error::New(env, "PortAudio not initialized — call paInit() first")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  int deviceCount = Pa_GetDeviceCount();
  if (deviceCount < 0) {
    Napi::Error::New(env, std::string("Pa_GetDeviceCount: ") + Pa_GetErrorText(deviceCount))
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Array result = Napi::Array::New(env);
  uint32_t idx = 0;
  for (int i = 0; i < deviceCount; i++) {
    const PaDeviceInfo* dev = Pa_GetDeviceInfo(i);
    if (!dev) continue;
    const PaHostApiInfo* apiInfo = Pa_GetHostApiInfo(dev->hostApi);
    if (!apiInfo) continue;
    Napi::Array hostApis = Napi::Array::New(env);
    uint32_t haIdx = 0;
    const char* kind = hostApiKind(apiInfo->type);
    hostApis.Set(haIdx++, makeHostApiObj(env, kind, apiInfo->name));
    if (apiInfo->type == paWASAPI) {
      hostApis.Set(haIdx++, makeHostApiObj(env, "WASAPI_EXCLUSIVE", "WASAPI Exclusive"));
    }
    Napi::Object device = Napi::Object::New(env);
    device.Set("id",                Napi::Number::New(env, i));
    device.Set("name",              Napi::String::New(env, ensureUtf8(dev->name)));
    device.Set("hostApis",          hostApis);
    device.Set("inputChannels",     Napi::Number::New(env, dev->maxInputChannels));
    device.Set("outputChannels",    Napi::Number::New(env, dev->maxOutputChannels));
    device.Set("defaultSampleRate", Napi::Number::New(env, dev->defaultSampleRate));
    result.Set(idx++, device);
  }
  return result;
}

// ─── Opus cleanup helper ──────────────────────────────────────────────────────
// Must be called from the JS thread only (closeStream or openStream rollback).
// Sets enc = nullptr so any in-flight TSFN lambdas see nullptr and skip encoding.
static void cleanupOpusState() {
  for (int i = 0; i < MAX_INPUT_CH; i++) {
    if (g_opusCh[i].enc) {
      opus_encoder_destroy(g_opusCh[i].enc);
      g_opusCh[i].enc = nullptr;
    }
    g_opusCh[i].accumCount = 0;
    g_opusCh[i].sequence   = 0;
  }
  g_opusNumCh.store(0, std::memory_order_release);
}

// ─── A4b decoder helpers ──────────────────────────────────────────────────────
// findOrCreatePeer / decodeAndFlush run on the WORKER thread (E5) and must be
// called with g_opusMx held — that serialises them against cleanupDecoderState()
// and the g_pendingGains writers on the JS thread. The RT callback only ever
// READS g_peerSlots (acquire) and the per-peer PeerRing it consumes, so peer
// publication (release store) / RT acquire is the only cross-thread contract
// with the audio thread.

// Find existing or create new PeerDecState for 'key'.  Returns nullptr on OOM or
// decoder create failure.  Caller holds g_opusMx.
static PeerDecState* findOrCreatePeer(const std::string& key) {
  int freeSlot = -1;
  for (int i = 0; i < MAX_PEERS; i++) {
    PeerDecState* p = g_peerSlots[i].load(std::memory_order_acquire);
    if (p) {
      if (p->key == key) return p;
    } else if (freeSlot < 0) {
      freeSlot = i;
    }
  }
  if (freeSlot < 0) return nullptr;

  int err = OPUS_OK;
  PeerDecState* np = new PeerDecState();
  np->key = key;
  np->dec = opus_decoder_create(48000, 1, &err);
  if (err != OPUS_OK || !np->dec) { delete np; return nullptr; }

  // M4: apply any gain set before the first packet arrived.
  auto git = g_pendingGains.find(key);
  if (git != g_pendingGains.end()) {
    np->gain.store(git->second, std::memory_order_relaxed);
    g_pendingGains.erase(git);
  }

  g_peerSlots[freeSlot].store(np, std::memory_order_release);
  return np;
}

// Flush jitter buffer in sequence order; generate PLC frames for gaps.
static void decodeAndFlush(PeerDecState* peer) {
  float pcm[MAX_OPUS_FRAME];
  for (;;) {
    auto it = peer->jitter.find(peer->nextSeq);
    if (it != peer->jitter.end()) {
      const auto& pkt = it->second;
      int n = opus_decode_float(peer->dec, pkt.data(), static_cast<opus_int32>(pkt.size()),
                                pcm, MAX_OPUS_FRAME, 0);
      if (n > 0) {
        if (peer->fsize == 0) peer->fsize = n;
        peer->ring.push(pcm, n);
      } else {
        // Corrupted packet (e.g. truncated, bad header): run PLC to keep the
        // internal decoder state in sync with nextSeq, then still advance
        // nextSeq below so subsequent in-order packets play correctly.
        int fs   = peer->fsize > 0 ? peer->fsize : DEC_FRAME_DEFAULT;
        int plcN = opus_decode_float(peer->dec, nullptr, 0, pcm, fs, 0);
        if (plcN > 0) peer->ring.push(pcm, plcN);
      }
      peer->jitter.erase(it);
      peer->nextSeq++;
    } else {
      // Gap: force PLC only when STRICTLY MORE than JITTER_HOLD future packets
      // are buffered.  With JITTER_HOLD=2 and >=, a single missing packet would
      // trigger PLC the instant 2 future packets arrived, with zero hold window.
      // Using > gives a real buffer of JITTER_HOLD frames before concealing.
      if (!peer->jitter.empty() && static_cast<int>(peer->jitter.size()) > JITTER_HOLD) {
        int fs = peer->fsize > 0 ? peer->fsize : DEC_FRAME_DEFAULT;
        int n  = opus_decode_float(peer->dec, nullptr, 0, pcm, fs, 0);
        if (n > 0) peer->ring.push(pcm, n);
        peer->nextSeq++;
        continue;
      }
      break;
    }
  }
  // Evict excess: remove the packet with the largest signed distance from
  // nextSeq (i.e. the farthest future packet).  Using begin() (smallest uint32
  // key) is WRONG near a sequence rollover — post-wrap keys 0,1,2 are
  // numerically smaller than pre-wrap keys 0xFFFFFFFE,0xFFFFFFFF and would be
  // evicted first even though they are the next packets to play.
  // Linear scan over JITTER_MAX=8 entries is negligible cost.
  while (static_cast<int>(peer->jitter.size()) > JITTER_MAX) {
    auto   evict   = peer->jitter.begin();
    int32_t maxDist = static_cast<int32_t>(evict->first - peer->nextSeq);
    for (auto it = std::next(evict); it != peer->jitter.end(); ++it) {
      int32_t d = static_cast<int32_t>(it->first - peer->nextSeq);
      if (d > maxDist) { maxDist = d; evict = it; }
    }
    peer->jitter.erase(evict);
  }
}

// Destroy all peer decoders.  Caller holds g_opusMx and must have stopped the RT
// callback first (Pa_AbortStream/Pa_CloseStream) so peer rings are no longer read.
static void cleanupDecoderState() {
  for (int i = 0; i < MAX_PEERS; i++) {
    PeerDecState* p = g_peerSlots[i].exchange(nullptr, std::memory_order_acq_rel);
    if (p) {
      if (p->dec) { opus_decoder_destroy(p->dec); p->dec = nullptr; }
      delete p;
    }
  }
  g_pendingGains.clear();
}

// ─── E5: worker-thread drains ────────────────────────────────────────────────

// Marshal one encoded Opus packet to the JS thread via g_opusTsfn. Re-acquires
// g_opusMx (callers must NOT hold it) so a concurrent closeStream Release()
// cannot finalise the TSFN mid-call.
static void opusDeliverEncoded(int ch, uint32_t seq, int64_t ts,
                               const unsigned char* data, int len) {
  std::lock_guard<std::mutex> lk(g_opusMx);
  if (!g_opusTsfnAlive.load(std::memory_order_acquire)) return;
  OpusOutJob* job = new (std::nothrow) OpusOutJob();
  if (!job) { g_dropCount.fetch_add(1, std::memory_order_relaxed); return; }
  job->channelIndex = ch;
  job->sequence     = seq;
  job->timestampUs  = ts;
  job->len          = len;
  std::memcpy(job->data, data, static_cast<size_t>(len));
  napi_status s = g_opusTsfn.NonBlockingCall(job,
    [](Napi::Env env, Napi::Function jsCb, OpusOutJob* j) {
      g_opusTsfnFill.fetch_sub(1, std::memory_order_relaxed);
      try {
        Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, static_cast<size_t>(j->len));
        std::memcpy(ab.Data(), j->data, static_cast<size_t>(j->len));
        jsCb.Call({
          ab,
          Napi::Number::New(env, j->channelIndex),
          Napi::Number::New(env, static_cast<double>(j->sequence)),
          Napi::BigInt::New(env, j->timestampUs),
        });
      } catch (...) {}
      delete j;
    });
  if (s == napi_ok) {
    g_opusTsfnFill.fetch_add(1, std::memory_order_relaxed);
  } else {
    delete job;
    g_dropCount.fetch_add(1, std::memory_order_relaxed);
  }
}

// Drain the encode ring: pop each PCM frame, encode it (under g_opusMx so the
// encoder can't be destroyed mid-encode), and deliver. Stale frames (generation
// mismatch) or frames whose encoder is gone are skipped. Returns true if any
// slot was processed.
static bool drainEncodeRing() {
  bool did = false;
  for (;;) {
    const uint32_t r = g_encRpos.load(std::memory_order_relaxed);
    const uint32_t w = g_encWpos.load(std::memory_order_acquire);
    if (r == w) break;
    EncodeSlot& slot = g_encRing[r & (ENC_RING_SLOTS - 1)];
    const int      ch  = slot.channelIndex;
    const uint32_t seq = slot.sequence;
    const int64_t  ts  = slot.timestampUs;
    const int      fsz = slot.frameSize;

    int encodedLen = 0;
    unsigned char encoded[OPUS_MAX_PACKET];
    {
      std::lock_guard<std::mutex> lk(g_opusMx);
      OpusEncoder* enc = (ch >= 0 && ch < MAX_INPUT_CH) ? g_opusCh[ch].enc : nullptr;
      if (enc && slot.gen == g_streamGen.load(std::memory_order_relaxed) &&
          fsz > 0 && fsz <= MAX_OPUS_FRAME) {
        encodedLen = opus_encode_float(enc, slot.pcm, fsz, encoded, OPUS_MAX_PACKET);
      }
    }
    // Free the slot only after the encode has read slot.pcm. The SPSC contract
    // (RT cannot reuse slot r until rpos advances past it) guarantees slot.pcm
    // was stable throughout the encode above.
    g_encRpos.store(r + 1, std::memory_order_release);
    if (encodedLen > 0) opusDeliverEncoded(ch, seq, ts, encoded, encodedLen);
    did = true;
  }
  return did;
}

// Drain the PCM ring: pop each raw input block and ship it to the JS thread via
// g_pcmTsfn (recorder / VU). Stale generations are skipped. malloc here is on the
// worker thread, never the RT thread.
static bool drainPcmRing() {
  bool did = false;
  for (;;) {
    const uint32_t r = g_pcmRpos.load(std::memory_order_relaxed);
    const uint32_t w = g_pcmWpos.load(std::memory_order_acquire);
    if (r == w) break;
    PcmSlot& slot = g_pcmRing[r & (PCM_RING_SLOTS - 1)];
    const uint32_t frames   = slot.frames;
    const uint32_t channels = slot.channels;
    const size_t   count    = static_cast<size_t>(frames) * channels;
    {
      std::lock_guard<std::mutex> lk(g_opusMx);
      if (count > 0 &&
          slot.gen == g_streamGen.load(std::memory_order_relaxed) &&
          g_tsfnAlive.load(std::memory_order_acquire)) {
        const size_t bytes = count * sizeof(float);
        float* copy = static_cast<float*>(std::malloc(bytes));
        if (copy) {
          std::memcpy(copy, slot.data, bytes);   // slot.data stable: rpos not advanced
          PcmChunk* chunk = new (std::nothrow) PcmChunk{copy, frames, channels};
          if (!chunk) {
            std::free(copy);
            g_dropCount.fetch_add(1, std::memory_order_relaxed);
          } else {
            napi_status s = g_pcmTsfn.NonBlockingCall(chunk,
              [](Napi::Env env, Napi::Function jsCb, PcmChunk* c) {
                const size_t b = c->frames * c->channels * sizeof(float);
                try {
                  Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, b);
                  std::memcpy(ab.Data(), c->data, b);
                  jsCb.Call({
                    ab,
                    Napi::Number::New(env, static_cast<double>(c->frames)),
                    Napi::Number::New(env, static_cast<double>(c->channels)),
                  });
                } catch (...) {}
                std::free(c->data);
                delete c;
              });
            if (s != napi_ok) {
              std::free(copy);
              delete chunk;
              g_dropCount.fetch_add(1, std::memory_order_relaxed);
            }
          }
        }
      }
    }
    g_pcmRpos.store(r + 1, std::memory_order_release);
    did = true;
  }
  return did;
}

// Drain the inbound decode queue: pop each packet (under g_decodeQueueMx), then
// run the jitter buffer + opus_decode_float() under g_opusMx (off the JS thread,
// §1.5), pushing PCM into the peer ring. The two locks are taken in separate
// scopes — never simultaneously — so neither the JS producer nor closeStream is
// blocked by a decode.
static bool drainDecodeQueue() {
  bool did = false;
  for (;;) {
    InboundPkt pkt;
    {
      std::lock_guard<std::mutex> qlk(g_decodeQueueMx);
      if (g_decodeQueue.empty()) break;
      pkt = std::move(g_decodeQueue.front());
      g_decodeQueue.pop_front();
    }
    {
      std::lock_guard<std::mutex> lk(g_opusMx);
      // If the stream was torn down between pop and here, do NOT create a peer —
      // it would leak into the next stream. closeStream sets outputChannels=0
      // (release) before its g_opusMx cleanup, so this load (acquire) sees 0.
      if (g_streamOutputChannels.load(std::memory_order_acquire) != 0) {
        PeerDecState* peer = findOrCreatePeer(pkt.key);
        if (peer) {
          if (!peer->seqInit) { peer->nextSeq = pkt.sequence; peer->seqInit = true; }
          // Drop late arrivals (signed wrap-aware), then jitter-buffer + flush.
          if (static_cast<int32_t>(pkt.sequence - peer->nextSeq) >= 0 && !pkt.payload.empty()) {
            peer->jitter.emplace(pkt.sequence, std::move(pkt.payload));
            decodeAndFlush(peer);
          }
        }
      }
    }
    did = true;
  }
  return did;
}

// Worker entry point. One thread per process; created in Init, joined via the
// env cleanup hook. Drains the three queues; idles on a 1 ms timed wait so the
// RT-produced rings (which cannot safely notify a condvar) are still picked up
// promptly, while inbound packets wake it immediately.
static void opusWorkerMain() {
  while (g_opusThreadRun.load(std::memory_order_acquire)) {
    bool did = false;
    did |= drainEncodeRing();
    did |= drainPcmRing();
    did |= drainDecodeQueue();
    if (!did) {
      // Wait on the queue mutex (the condvar's predicate touches g_decodeQueue).
      // The 1 ms timeout backstops the RT-produced rings, which cannot notify.
      std::unique_lock<std::mutex> qlk(g_decodeQueueMx);
      g_opusCv.wait_for(qlk, std::chrono::milliseconds(1), [] {
        return !g_opusThreadRun.load(std::memory_order_relaxed) ||
               !g_decodeQueue.empty();
      });
    }
  }
}

#ifdef KGB_WITH_VST
// ─── VST insert chain (input side) ────────────────────────────────────────────
// Global (all-channels) chain — legacy V1 path kept for backward compat.
// V6 per-channel chains run AFTER this in PaCallback and take precedence on each
// individual channel. Use setInsertChain([]) to leave the global path empty.
static const int MAX_VST_CHAIN = 16;
static std::atomic<int> g_vstChainSlots[MAX_VST_CHAIN];
static std::atomic<int> g_vstChainCount{0};
// Preallocated de-interleave-free scratch: both global and per-channel chains
// process the input copy in-place. Sized in OpenStream to maxBuffer(512) ×
// inputChannels; never realloc'd from the RT thread.
static float* g_vstScratch = nullptr;
static std::atomic<unsigned long> g_vstScratchCap{0};  // capacity in floats

// V6: per-channel insert chains. Indexed by physical input channel [0, MAX_INPUT_CH).
// Persists across stream restarts; cleared only by setChannelChain(ch, []).
// Applied per-channel after the global chain so each mixer strip has its own VST.
static std::atomic<int> g_chanChainSlots[MAX_INPUT_CH][MAX_VST_CHAIN];
static std::atomic<int> g_chanChainCounts[MAX_INPUT_CH];  // 0 = no chain
// Bug #3: pre-computed count of non-empty per-channel chains.
// Written by SetChannelChain (JS thread), read by PaCallback (RT).
// Lets the RT callback skip the entire per-channel loop in O(1) when no
// per-channel chains exist, instead of scanning g_chanChainCounts[] per callback.
static std::atomic<int> g_totalChanChains{0};

// Mono scratch for de-interleave → per-channel process → re-interleave (V6).
// Allocated in openStream (512 floats), freed in closeStream.
static float* g_monoScratch = nullptr;

// Bug #4 (I3-fix): VSTi synthesis output chain.
// Instrument slots that generate audio from MIDI events (noteOn/noteOff) must be
// called by the RT callback every block — g_trackChains is JS-thread-only and
// PaCallback never reads it, so synth audio was silently discarded.
// JS calls setSynthChain(slotIds[]) to populate this table; PaCallback runs each
// slot with silence as input, accumulates stereo output, and mixes it into out[].
static const int MAX_SYNTH_SLOTS = 8;
static std::atomic<int> g_synthSlots[MAX_SYNTH_SLOTS];
static std::atomic<int> g_synthCount{0};
// Per-slot stereo scratch (2 × 512 floats) — silence in, synth audio out.
static float* g_synthScratch = nullptr;
// Accumulated stereo output summed across all synth slots.
static float* g_synthMixBuf  = nullptr;
#endif

// ─── PortAudio RT callback ────────────────────────────────────────────────────
// Runs on the audio thread — must not block and must not allocate.
//
// Responsibilities:
//   1. A4.5 stats: count xruns from PaStreamCallbackFlags.
//   2. Native monitoring + peer/softmix mix into the output buffer.
//   3. PCM tap: copy the raw input block into the lock-free PCM ring (g_pcmRing);
//      the worker thread ships it to the JS recorder/VU.
//   4. A4 Opus: accumulate per-channel PCM; when a full Opus frame is ready,
//      copy it into the lock-free encode ring (g_encRing); the worker thread
//      encodes and ships it.
//
// E5 (§9.A.1): the RT callback no longer mallocs or runs opus_encode/decode.
// Both former malloc sites are replaced by bounded copies into preallocated SPSC
// rings consumed by the dedicated worker thread (opusWorkerMain).
static int PaCallback(const void* input, void* output, unsigned long frames,
                      const PaStreamCallbackTimeInfo* timeInfo,
                      PaStreamCallbackFlags flags, void* /*userData*/) {
  const float* in  = static_cast<const float*>(input);
  float*       out = static_cast<float*>(output);
  const uint32_t streamGen = g_streamGen.load(std::memory_order_relaxed);
  const int inCh  = g_streamInputChannels.load(std::memory_order_acquire);
  const int outCh = g_streamOutputChannels.load(std::memory_order_acquire);
  const float gain = g_monitorGain.load(std::memory_order_relaxed);

  // ── A4.5: xrun tracking ───────────────────────────────────────────────────
  if (flags & paInputOverflow)    g_xrunCount.fetch_add(1, std::memory_order_relaxed);
  if (flags & paOutputUnderflow)  g_xrunCount.fetch_add(1, std::memory_order_relaxed);

  // ── VST insert chain (before monitor / PCM / Opus) ────────────────────────
  // Process the captured input through the configured chain into scratch, then
  // route the processed signal downstream via procIn. Empty chain → procIn == in
  // (no copy, no cost). Guarded so an undersized scratch never overruns.
  //
  // Bug #3: pre-load the two chain-presence flags once; beginRtBlock/endRtBlock
  // wrap the entire VST section so the generation bump and g_rtInChain writes
  // happen once per callback instead of once per processChain() call.
  const float* procIn = in;
// Bug #4: hasSynth is visible to both the VST block and the output loop below.
#ifdef KGB_WITH_VST
  const int  g_synthCount_snap = g_synthCount.load(std::memory_order_acquire);
  const bool hasSynth = g_synthCount_snap > 0 && g_synthScratch && g_synthMixBuf
                        && out && outCh > 0 && frames <= 512UL;
#else
  constexpr bool hasSynth = false;
#endif
#ifdef KGB_WITH_VST
  {
    const int  vstGlobalCount = g_vstChainCount.load(std::memory_order_acquire);
    // Bug #3: O(1) check via pre-computed counter instead of O(inCh) acquire loop.
    const bool anyChanChain   = g_totalChanChains.load(std::memory_order_relaxed) > 0;
    const bool vstActive      = (vstGlobalCount > 0 || anyChanChain) && in && inCh > 0;
    // Bug #4: include synth in the RT block so MIDI rings are drained.
    const bool rtNeeded       = vstActive || hasSynth;
    if (rtNeeded) kgb::vst::beginRtBlock();

    // ── Global insert chain ───────────────────────────────────────────────
    {
      const unsigned long need = frames * static_cast<unsigned long>(inCh);
      if (in && inCh > 0 && vstGlobalCount > 0 && g_vstScratch &&
          need <= g_vstScratchCap.load(std::memory_order_relaxed)) {
        int ids[MAX_VST_CHAIN];
        int n = vstGlobalCount < MAX_VST_CHAIN ? vstGlobalCount : MAX_VST_CHAIN;
        for (int i = 0; i < n; i++) ids[i] = g_vstChainSlots[i].load(std::memory_order_relaxed);
        std::memcpy(g_vstScratch, in, need * sizeof(float));
        kgb::vst::processChain(ids, n, g_vstScratch, inCh, static_cast<int>(frames));
        procIn = g_vstScratch;
      }
    }

    // ── V6: per-channel chains ────────────────────────────────────────────
    // For each physical input channel with a chain: de-interleave → process mono
    // → re-interleave. Runs after the global chain so both can coexist.
    // All downstream paths (monitor/PCM/Opus) already use procIn, so they see the
    // post-chain signal automatically (V8).
    if (anyChanChain && g_monoScratch && in && inCh > 0) {
      // Ensure we have a writable interleaved copy in g_vstScratch.
      if (procIn == in) {
        const unsigned long need = frames * static_cast<unsigned long>(inCh);
        if (g_vstScratch && need <= g_vstScratchCap.load(std::memory_order_relaxed)) {
          std::memcpy(g_vstScratch, in, need * sizeof(float));
          procIn = g_vstScratch;
        }
      }
      // procIn == g_vstScratch only when need ≤ g_vstScratchCap = 512 × inCh,
      // i.e. frames ≤ 512, which is also g_monoScratch's allocation size.
      if (procIn == g_vstScratch && frames <= 512UL) {
        for (int ch = 0; ch < inCh && ch < MAX_INPUT_CH; ch++) {
          int n = g_chanChainCounts[ch].load(std::memory_order_acquire);
          if (n <= 0) continue;
          int ids[MAX_VST_CHAIN];
          const int take = (n < MAX_VST_CHAIN) ? n : MAX_VST_CHAIN;
          for (int k = 0; k < take; k++)
            ids[k] = g_chanChainSlots[ch][k].load(std::memory_order_relaxed);
          // De-interleave channel ch into mono scratch
          for (unsigned long f = 0; f < frames; f++)
            g_monoScratch[f] = g_vstScratch[f * static_cast<unsigned long>(inCh)
                                              + static_cast<unsigned long>(ch)];
          kgb::vst::processChain(ids, take, g_monoScratch, 1, static_cast<int>(frames));
          // Re-interleave back
          for (unsigned long f = 0; f < frames; f++)
            g_vstScratch[f * static_cast<unsigned long>(inCh)
                          + static_cast<unsigned long>(ch)] = g_monoScratch[f];
        }
      }
    }

    // Bug #4: VSTi synthesis output — run each instrument slot with silence as
    // input, accumulate stereo output into g_synthMixBuf, then mix it into out[]
    // in the merged output pass below. This is what makes Piano Roll MIDI audible.
    if (hasSynth) {
      std::memset(g_synthMixBuf, 0, frames * 2UL * sizeof(float));
      for (int s = 0; s < g_synthCount_snap; s++) {
        const int sid = g_synthSlots[s].load(std::memory_order_relaxed);
        if (sid < 0 || sid >= kgb::vst::kMaxSlots) continue;
        // Silence = VSTi generates audio purely from its MIDI ring events.
        std::memset(g_synthScratch, 0, frames * 2UL * sizeof(float));
        kgb::vst::processChain(&sid, 1, g_synthScratch, 2, static_cast<int>(frames));
        for (unsigned long f = 0; f < frames * 2UL; f++)
          g_synthMixBuf[f] += g_synthScratch[f];
      }
    }

    if (rtNeeded) kgb::vst::endRtBlock(static_cast<int>(frames));
  }
#endif

  // ── §9.A.5: merged output pass ───────────────────────────────────────────
  // Monitor + all peer rings + softmix summed per-frame in ONE loop instead
  // of N_peers+3 separate passes. Drift compensation is computed outside the
  // frame loop; only rpos advances and RMS updates happen after the loop.
  if (out && outCh > 0) {
    // ── Pre-compute per-peer state (outside the hot frame loop) ────────────
    struct PeerMix {
      PeerDecState* peer   = nullptr;
      float         gain   = 0.0f;
      uint32_t      r      = 0;
      uint32_t      take   = 0;
      uint32_t      consume= 0;
      float         sumSq  = 0.0f;
    };
    PeerMix pm[MAX_PEERS] = {};

    for (int s = 0; s < MAX_PEERS; s++) {
      PeerDecState* peer = g_peerSlots[s].load(std::memory_order_acquire);
      if (!peer) continue;
      const uint32_t r     = peer->ring.rpos.load(std::memory_order_relaxed);
      const uint32_t avail = peer->ring.wpos.load(std::memory_order_acquire) - r;
      const uint32_t take  = avail < static_cast<uint32_t>(frames)
                               ? avail : static_cast<uint32_t>(frames);
      // §1.3: drift EWMA and consume, computed before the frame loop.
      const float alpha   = 1.0f / 64.0f;
      const float curEwma = peer->fillEwma.load(std::memory_order_relaxed);
      const float newEwma = curEwma + alpha * (static_cast<float>(avail) - curEwma);
      peer->fillEwma.store(newEwma, std::memory_order_relaxed);
      const float target  = static_cast<float>(DEC_FRAME_DEFAULT * 2);
      uint32_t consume = take;
      if (newEwma > target + static_cast<float>(frames) && take + 1u <= avail)
        consume = take + 1u;
      else if (newEwma < target * 0.5f && consume > 0u)
        consume = take - 1u;
      pm[s] = {peer, peer->gain.load(std::memory_order_relaxed), r, take, consume, 0.0f};
    }

    // ── Pre-compute softmix state ──────────────────────────────────────────
    const uint32_t smr   = g_softmixRpos.load(std::memory_order_relaxed);
    const uint32_t smAvail = g_softmixWpos.load(std::memory_order_acquire) - smr;
    const uint32_t smTake = smAvail < static_cast<uint32_t>(frames)
                              ? smAvail : static_cast<uint32_t>(frames);
    // §1.1: softmix EWMA drift before the frame loop.
    const float smAlpha = 1.0f / 64.0f;
    g_softmixFillEwma += smAlpha * (static_cast<float>(smAvail) - g_softmixFillEwma);
    uint32_t smConsume = smTake;
    if (g_softmixFillEwma > static_cast<float>(SOFTMIX_TARGET_FILL + frames) && smTake + 1u <= smAvail)
      smConsume = smTake + 1u;
    else if (g_softmixFillEwma < static_cast<float>(SOFTMIX_TARGET_FILL) * 0.5f && smConsume > 0u)
      smConsume = smTake - 1u;

    // ── Single merged frame loop ───────────────────────────────────────────
    const bool hasMonitor = (in && inCh > 0 && gain > 0.0f);
    const float invInCh   = hasMonitor ? 1.0f / static_cast<float>(inCh) : 0.0f;
    const float masterGain = g_masterGain.load(std::memory_order_relaxed);
    float peak = 0.0f;

    for (unsigned long f = 0; f < frames; f++) {
      float acc = 0.0f;

      // Monitor
      if (hasMonitor) {
        float mono = 0.0f;
        for (int c = 0; c < inCh; c++) mono += procIn[f * static_cast<unsigned long>(inCh) + static_cast<unsigned long>(c)];
        acc += mono * invInCh * gain;
      }

      // All peers (A4b + M4 + M5 sumSq accumulation)
      for (int s = 0; s < MAX_PEERS; s++) {
        if (!pm[s].peer) continue;
        float raw = 0.0f;
        if (static_cast<uint32_t>(f) < pm[s].take)
          raw = pm[s].peer->ring.buf[(pm[s].r + static_cast<uint32_t>(f)) & (PEER_RING_CAP - 1)];
        pm[s].sumSq += raw * raw;
        acc += raw * pm[s].gain;
      }

      // Softmix (§1.1)
      if (static_cast<uint32_t>(f) < smTake)
        acc += g_softmixBuf[(smr + static_cast<uint32_t>(f)) & (SOFTMIX_RING_CAP - 1u)];

      // Bug #4: VSTi synthesis — sum stereo output to mono and add to bus.
      // g_synthMixBuf is stereo-interleaved [L0,R0,L1,R1,...]; we average L+R so
      // the instrument sits at the same level regardless of mono/stereo output.
#ifdef KGB_WITH_VST
      if (hasSynth) {
        const float sL = g_synthMixBuf[f * 2UL];
        const float sR = g_synthMixBuf[f * 2UL + 1UL];
        acc += (sL + sR) * 0.5f;
      }
#endif

      // Master fader — scales the whole bus before the safety limiter.
      acc *= masterGain;

      // Write + track peak for §2.2 limiter
      const float absAcc = acc < 0.0f ? -acc : acc;
      if (absAcc > peak) peak = absAcc;
      for (int c = 0; c < outCh; c++)
        out[f * static_cast<unsigned long>(outCh) + static_cast<unsigned long>(c)] = acc;
    }

    // ── Post-loop: advance rpos + update RMS for all peers ─────────────────
    for (int s = 0; s < MAX_PEERS; s++) {
      if (!pm[s].peer) continue;
      const float frameRms = (pm[s].take > 0)
          ? std::sqrt(pm[s].sumSq / static_cast<float>(pm[s].take))
          : 0.0f;
      const float curLev = pm[s].peer->rmsLevel.load(std::memory_order_relaxed);
      pm[s].peer->rmsLevel.store(0.9f * curLev + 0.1f * frameRms, std::memory_order_relaxed);
      pm[s].peer->ring.rpos.store(pm[s].r + pm[s].consume, std::memory_order_release);
    }
    if (smConsume > 0u)
      g_softmixRpos.store(smr + smConsume, std::memory_order_release);

    // §2.2: soft peak limiter — second pass only when output exceeds ±1.0.
    if (peak > 1.0f) {
      const float inv = 1.0f / peak;
      for (unsigned long f = 0; f < frames; f++)
        for (int c = 0; c < outCh; c++)
          out[f * static_cast<unsigned long>(outCh) + static_cast<unsigned long>(c)] *= inv;
    }
  }

  // ── PCM ring (RT → worker → onPcm TSFN) ───────────────────────────────────
  // E5 (§9.A.1): bounded copy into a preallocated SPSC ring; no malloc here. The
  // worker thread (drainPcmRing) does the malloc + TSFN marshalling.
  if (in && inCh > 0 && g_tsfnAlive.load(std::memory_order_acquire)) {
    const uint32_t need = static_cast<uint32_t>(frames) * static_cast<uint32_t>(inCh);
    if (need <= static_cast<uint32_t>(MAX_INPUT_CH) * 512u) {
      const uint32_t w = g_pcmWpos.load(std::memory_order_relaxed);
      const uint32_t r = g_pcmRpos.load(std::memory_order_acquire);
      if (w - r < static_cast<uint32_t>(PCM_RING_SLOTS)) {
        PcmSlot& slot = g_pcmRing[w & (PCM_RING_SLOTS - 1)];
        slot.frames   = static_cast<uint32_t>(frames);
        slot.channels = static_cast<uint32_t>(inCh);
        slot.gen      = streamGen;
        std::memcpy(slot.data, procIn, static_cast<size_t>(need) * sizeof(float));
        g_pcmWpos.store(w + 1, std::memory_order_release);
      } else {
        g_dropCount.fetch_add(1, std::memory_order_relaxed);  // worker fell behind
      }
    }
  }

  // ── A4 Opus encoder (RT → worker via encode ring) ─────────────────────────
  // Accumulate deinterleaved per-channel PCM in pre-allocated accumBuf, then copy
  // each full frame into the SPSC encode ring. No malloc, no opus_encode here —
  // the worker thread (drainEncodeRing) does the encoding (§1.5, §9.A.1).
  const int opusNumCh = g_opusNumCh.load(std::memory_order_acquire);
  if (in && inCh > 0 && opusNumCh > 0) {
    const int64_t tsUs = timeInfo
        ? static_cast<int64_t>(timeInfo->currentTime * 1e6)
        : 0;

    for (int ch = 0; ch < inCh && ch < opusNumCh; ch++) {
      OpusChannelState& st = g_opusCh[ch];
      if (!st.enc) continue;

      for (unsigned long f = 0; f < frames; f++) {
        st.accumBuf[st.accumCount++] = procIn[f * inCh + ch];

        if (st.accumCount >= st.frameSize) {
          // Full Opus frame — copy into the encode ring for the worker thread.
          // Advance sequence per frame boundary even on drop, so the receiver
          // sees a gap (→ PLC) rather than a silent time discontinuity.
          const uint32_t seq = st.sequence++;
          const uint32_t w   = g_encWpos.load(std::memory_order_relaxed);
          const uint32_t r   = g_encRpos.load(std::memory_order_acquire);
          if (w - r < static_cast<uint32_t>(ENC_RING_SLOTS)) {
            EncodeSlot& slot = g_encRing[w & (ENC_RING_SLOTS - 1)];
            slot.channelIndex = ch;
            slot.sequence     = seq;
            slot.timestampUs  = tsUs;
            slot.frameSize    = st.frameSize;
            slot.gen          = streamGen;
            std::memcpy(slot.pcm, st.accumBuf,
                        static_cast<size_t>(st.frameSize) * sizeof(float));
            g_encWpos.store(w + 1, std::memory_order_release);
          } else {
            g_dropCount.fetch_add(1, std::memory_order_relaxed);  // worker fell behind
          }
          st.accumCount = 0;
        }
      }
    }
  }

  return paContinue;
}

// ─── openStream ───────────────────────────────────────────────────────────────
// openStream(opts, onPcm [, onOpus])
//
//   opts: {
//     inputDeviceId:       number  — required; or use back-compat deviceId
//     outputDeviceId?:     number  — output-side device; omit for capture-only
//     inputHostApiKind?:   string
//     outputHostApiKind?:  string
//     deviceId?:           number  — back-compat: covers both sides
//     hostApiKind?:        string  — back-compat fallback
//     sampleRate:          number
//     bufferSize:          64|128|256|512
//     inputChannels:       number
//     outputChannels?:     number
//     monitor?:            boolean
//     monitorGain?:        number
//     crashMe?:            boolean  — smoke-test affordance, never in production
//     opus?: {             — A4: present → Opus encoding enabled
//       bitrate?:     number   (default 64000 bps)
//       complexity?:  number   (default 5, range 0-10)
//       frameMs?:     10|20    (default 20)
//     }
//   }
//   onPcm:  (buf: ArrayBuffer, frames: number, channels: number) => void
//   onOpus: (payload: ArrayBuffer, channelIndex: number, sequence: number,
//            timestampUs: bigint) => void   — optional, enables Opus encoding
//   → { inputLatency, outputLatency, sampleRate, inputChannels, outputChannels, bufferSize }
Napi::Value OpenStream(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_paInitialized) {
    Napi::Error::New(env, "PortAudio not initialized — call paInit() first")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (g_stream) {
    Napi::Error::New(env, "Stream already open — call closeStream() first")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "openStream(opts: object, onPcm: function [, onOpus: function])")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object opts = info[0].As<Napi::Object>();

  // Resolve device IDs
  const bool hasInputDeviceId  = opts.Get("inputDeviceId").IsNumber();
  const bool hasOutputDeviceId = opts.Get("outputDeviceId").IsNumber();
  const bool hasDeviceId       = opts.Get("deviceId").IsNumber();

  if (!hasInputDeviceId && !hasDeviceId) {
    Napi::Error::New(env, "opts must include inputDeviceId or deviceId")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const int inputDeviceId = hasInputDeviceId
      ? opts.Get("inputDeviceId").As<Napi::Number>().Int32Value()
      : opts.Get("deviceId").As<Napi::Number>().Int32Value();

  const bool useOutputDevice = hasOutputDeviceId || (!hasInputDeviceId && hasDeviceId);
  const int outputDeviceId = hasOutputDeviceId
      ? opts.Get("outputDeviceId").As<Napi::Number>().Int32Value()
      : ((!hasInputDeviceId && hasDeviceId)
             ? opts.Get("deviceId").As<Napi::Number>().Int32Value()
             : -1);

  // Resolve Host API kind per side
  const std::string inputApiKind = [&]() -> std::string {
    Napi::Value v = opts.Get("inputHostApiKind");
    if (v.IsString()) return v.As<Napi::String>().Utf8Value();
    v = opts.Get("hostApiKind");
    if (v.IsString()) return v.As<Napi::String>().Utf8Value();
    return "WASAPI_SHARED";
  }();
  const std::string outputApiKind = [&]() -> std::string {
    Napi::Value v = opts.Get("outputHostApiKind");
    if (v.IsString()) return v.As<Napi::String>().Utf8Value();
    v = opts.Get("hostApiKind");
    if (v.IsString()) return v.As<Napi::String>().Utf8Value();
    return "WASAPI_SHARED";
  }();

  const double sampleRate  = opts.Get("sampleRate").As<Napi::Number>().DoubleValue();
  const int    bufferSize  = opts.Get("bufferSize").As<Napi::Number>().Int32Value();
  const int    inputChannels = opts.Get("inputChannels").As<Napi::Number>().Int32Value();

  const PaDeviceInfo* inDevInfo = Pa_GetDeviceInfo(inputDeviceId);
  if (!inDevInfo) {
    Napi::Error::New(env, "Invalid inputDeviceId").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (inputChannels < 1 || inputChannels > inDevInfo->maxInputChannels) {
    Napi::Error::New(env, "inputChannels out of range for input device")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (bufferSize != 64 && bufferSize != 128 && bufferSize != 256 && bufferSize != 512) {
    Napi::Error::New(env, "bufferSize must be one of 64 / 128 / 256 / 512")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const PaDeviceInfo* outDevInfo = (useOutputDevice && outputDeviceId >= 0)
      ? Pa_GetDeviceInfo(outputDeviceId) : nullptr;
  if (useOutputDevice && outputDeviceId >= 0 && !outDevInfo) {
    Napi::Error::New(env, "Invalid outputDeviceId").ThrowAsJavaScriptException();
    return env.Null();
  }

  int outputChannels = 0;
  if (outDevInfo) {
    if (opts.Get("outputChannels").IsNumber()) {
      outputChannels = opts.Get("outputChannels").As<Napi::Number>().Int32Value();
      if (outputChannels < 1 || outputChannels > outDevInfo->maxOutputChannels) {
        Napi::Error::New(env, "outputChannels out of range for output device")
            .ThrowAsJavaScriptException();
        return env.Null();
      }
    } else {
      outputChannels = std::min(outDevInfo->maxOutputChannels, 2);
      if (outputChannels < 0) outputChannels = 0;
    }
  }

  // Build PaStreamParameters
  PaStreamParameters inputParams = {};
  inputParams.device           = inputDeviceId;
  inputParams.channelCount     = inputChannels;
  inputParams.sampleFormat     = paFloat32;
  inputParams.suggestedLatency = inDevInfo->defaultLowInputLatency;

  PaWasapiStreamInfo inputWasapiInfo = {};
  if (inputApiKind == "WASAPI_EXCLUSIVE") {
    inputWasapiInfo.size        = sizeof(PaWasapiStreamInfo);
    inputWasapiInfo.hostApiType = paWASAPI;
    inputWasapiInfo.version     = 1;
    inputWasapiInfo.flags       = paWinWasapiExclusive;
    inputParams.hostApiSpecificStreamInfo = &inputWasapiInfo;
  }

  PaStreamParameters  outputParams = {};
  PaStreamParameters* outputPtr    = nullptr;
  PaWasapiStreamInfo  outputWasapiInfo = {};

  if (outDevInfo && outputChannels > 0) {
    outputParams.device           = outputDeviceId;
    outputParams.channelCount     = outputChannels;
    outputParams.sampleFormat     = paFloat32;
    outputParams.suggestedLatency = outDevInfo->defaultLowOutputLatency;
    if (outputApiKind == "WASAPI_EXCLUSIVE") {
      outputWasapiInfo.size        = sizeof(PaWasapiStreamInfo);
      outputWasapiInfo.hostApiType = paWASAPI;
      outputWasapiInfo.version     = 1;
      outputWasapiInfo.flags       = paWinWasapiExclusive;
      outputParams.hostApiSpecificStreamInfo = &outputWasapiInfo;
    }
    outputPtr = &outputParams;
  }

  g_streamInputChannels.store(inputChannels, std::memory_order_release);
  g_streamOutputChannels.store(outputChannels, std::memory_order_release);

  // E5: bump the stream generation under g_opusMx so the worker thread (which
  // reads g_streamGen while holding the same mutex) is guaranteed to observe the
  // new value and therefore discard any stale frames left in the rings from a
  // previous stream — including across a reinit that reuses an encoder pointer.
  {
    std::lock_guard<std::mutex> lk(g_opusMx);
    g_streamGen.fetch_add(1, std::memory_order_relaxed);
  }

#ifdef KGB_WITH_VST
  // Preallocate the VST insert-chain scratch for the worst case (largest buffer
  // size × input channels), so the RT callback never allocates. Freed in
  // closeStream. The actual frames per callback is <= bufferSize.
  {
    const unsigned long cap = 512ul * static_cast<unsigned long>(inputChannels);
    std::free(g_vstScratch);
    g_vstScratch = static_cast<float*>(std::malloc(cap * sizeof(float)));
    g_vstScratchCap.store(g_vstScratch ? cap : 0, std::memory_order_release);
  }
  // V6: mono scratch for per-channel processing (max bufferSize = 512 samples).
  std::free(g_monoScratch);
  g_monoScratch = static_cast<float*>(std::malloc(512 * sizeof(float)));
  // Bug #4: stereo scratch + accumulation buffer for VSTi synthesis output.
  std::free(g_synthScratch);
  g_synthScratch = static_cast<float*>(std::calloc(512 * 2, sizeof(float)));
  std::free(g_synthMixBuf);
  g_synthMixBuf  = static_cast<float*>(std::calloc(512 * 2, sizeof(float)));
#endif

  float initialGain = 0.0f;
  if (opts.Get("monitorGain").IsNumber()) {
    initialGain = static_cast<float>(opts.Get("monitorGain").As<Napi::Number>().DoubleValue());
    if (!(initialGain >= 0.0f)) initialGain = 0.0f;
    if (initialGain > 4.0f)    initialGain = 4.0f;
  }
  if (opts.Get("monitor").IsBoolean() && !opts.Get("monitor").As<Napi::Boolean>().Value())
    initialGain = 0.0f;
  g_monitorGain.store(initialGain, std::memory_order_relaxed);

  // ── A4: Opus encoder setup (before Pa_OpenStream so RT callback is safe) ──
  const bool hasOpusCb = (info.Length() >= 3 && info[2].IsFunction());
  if (hasOpusCb) {
    int bitrate    = 64000;
    int complexity = 5;
    int frameMs    = 20;

    if (opts.Get("opus").IsObject()) {
      Napi::Object opusOpts = opts.Get("opus").As<Napi::Object>();
      if (opusOpts.Get("bitrate").IsNumber())
        bitrate    = opusOpts.Get("bitrate").As<Napi::Number>().Int32Value();
      if (opusOpts.Get("complexity").IsNumber())
        complexity = opusOpts.Get("complexity").As<Napi::Number>().Int32Value();
      if (opusOpts.Get("frameMs").IsNumber())
        frameMs    = opusOpts.Get("frameMs").As<Napi::Number>().Int32Value();
    }

    const int frameSize = frameMs * static_cast<int>(sampleRate) / 1000;
    // Opus requires frame sizes that correspond to: 2.5/5/10/20/40/60 ms.
    // At 48kHz these are: 120/240/480/960/1920/2880 samples.
    const bool validFrame = (frameSize == 120  || frameSize == 240 ||
                             frameSize == 480  || frameSize == 960 ||
                             frameSize == 1920 || frameSize == 2880);
    if (!validFrame || frameSize > MAX_OPUS_FRAME || frameSize < 1) {
      Napi::Error::New(env, "opus.frameMs must yield a valid Opus frame size "
                            "(try 10 or 20 ms at 48000 Hz)")
          .ThrowAsJavaScriptException();
      return env.Null();
    }

    complexity = std::max(0, std::min(10, complexity));
    if (bitrate < 500) bitrate = 500;
    if (bitrate > 512000) bitrate = 512000;

    // E5: create the encoders + opus TSFN under g_opusMx so the worker thread
    // (which validates and uses g_opusCh[].enc under the same mutex) never sees a
    // half-constructed encoder table or races create/destroy.
    std::lock_guard<std::mutex> lk(g_opusMx);
    const int numOpusCh = std::min(inputChannels, MAX_INPUT_CH);
    for (int ch = 0; ch < numOpusCh; ch++) {
      int opusErr = OPUS_OK;
      // Mono encoder per channel: network transport will be per-channel Opus packets.
      g_opusCh[ch].enc = opus_encoder_create(
          static_cast<opus_int32>(sampleRate), 1, OPUS_APPLICATION_AUDIO, &opusErr);
      if (opusErr != OPUS_OK || !g_opusCh[ch].enc) {
        cleanupOpusState();
        Napi::Error::New(env,
            std::string("opus_encoder_create ch") + std::to_string(ch) + ": " +
            opus_strerror(opusErr))
            .ThrowAsJavaScriptException();
        return env.Null();
      }
      opus_encoder_ctl(g_opusCh[ch].enc, OPUS_SET_BITRATE(bitrate));
      opus_encoder_ctl(g_opusCh[ch].enc, OPUS_SET_COMPLEXITY(complexity));
      g_opusCh[ch].frameSize   = frameSize;
      g_opusCh[ch].accumCount  = 0;
      g_opusCh[ch].sequence    = 0;
    }

    Napi::Function onOpus = info[2].As<Napi::Function>();
    // Do NOT reset g_opusTsfnFill here.  On a synchronous close→open / reinit
    // (no event-loop yield between them — the common case), the old TSFN's
    // pending lambdas have NOT yet drained when we reach this point.  Resetting
    // to 0 before they drain would then drive the counter negative as each old
    // lambda fires its fetch_sub(1), corrupting bufferFillPct in getStats().
    // The correct approach: let the old lambdas drain naturally (they converge
    // to 0); the new RT path only enqueues to the new TSFN after g_opusNumCh
    // is stored with release below, so the counter remains self-consistent.
    g_opusTsfn = Napi::ThreadSafeFunction::New(env, onOpus, "kgb-opus", 64, 1);
    // Release semantics: all g_opusCh[] and g_opusTsfn writes above become
    // visible to the RT callback once it loads g_opusNumCh with acquire.
    g_opusTsfnAlive.store(true, std::memory_order_release);
    g_opusNumCh.store(numOpusCh, std::memory_order_release);
  }

  // PCM TSFN — must exist before Pa_StartStream.
  Napi::Function onPcm = info[1].As<Napi::Function>();
  g_pcmTsfn = Napi::ThreadSafeFunction::New(env, onPcm, "kgb-pcm", 64, 1);
  g_tsfnAlive.store(true, std::memory_order_release);

  PaError err = Pa_OpenStream(
      &g_stream,
      &inputParams,
      outputPtr,
      sampleRate,
      static_cast<unsigned long>(bufferSize),
      paNoFlag,
      &PaCallback,
      nullptr);
  if (err != paNoError) {
    std::lock_guard<std::mutex> lk(g_opusMx);  // serialise codec/TSFN teardown vs worker
    g_tsfnAlive.store(false, std::memory_order_release);
    g_pcmTsfn.Release();
    if (hasOpusCb) {
      g_opusTsfnAlive.store(false, std::memory_order_release);
      cleanupOpusState();
      g_opusTsfn.Release();
    }
    g_stream = nullptr;
    Napi::Error::New(env, std::string("Pa_OpenStream: ") + Pa_GetErrorText(err))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  err = Pa_StartStream(g_stream);
  if (err != paNoError) {
    Pa_CloseStream(g_stream);
    g_stream = nullptr;
    std::lock_guard<std::mutex> lk(g_opusMx);  // serialise codec/TSFN teardown vs worker
    g_tsfnAlive.store(false, std::memory_order_release);
    g_pcmTsfn.Release();
    if (hasOpusCb) {
      g_opusTsfnAlive.store(false, std::memory_order_release);
      cleanupOpusState();
      g_opusTsfn.Release();
    }
    Napi::Error::New(env, std::string("Pa_StartStream: ") + Pa_GetErrorText(err))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const PaStreamInfo* sInfo = Pa_GetStreamInfo(g_stream);
  Napi::Object result = Napi::Object::New(env);
  result.Set("inputLatency",   Napi::Number::New(env, sInfo ? sInfo->inputLatency  : 0.0));
  result.Set("outputLatency",  Napi::Number::New(env, sInfo ? sInfo->outputLatency : 0.0));
  result.Set("sampleRate",     Napi::Number::New(env, sInfo ? sInfo->sampleRate    : sampleRate));
  result.Set("inputChannels",  Napi::Number::New(env, inputChannels));
  result.Set("outputChannels", Napi::Number::New(env, outputChannels));
  result.Set("bufferSize",     Napi::Number::New(env, bufferSize));
  return result;
}

// ─── closeStream ──────────────────────────────────────────────────────────────
// Idempotent. Stops & closes the PA stream, releases TSFNs, destroys encoders.
// Opus counters (xrunCount, dropCount) are monotonic — not reset here.
Napi::Value CloseStream(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Stop the RT callback FIRST so it can no longer write the SPSC rings or read
  // the per-peer rings, then tear down codec state that the worker shares.
  if (g_stream) {
    // §8.A.3: Pa_AbortStream terminates immediately without waiting for buffers
    // to drain — Pa_StopStream can block indefinitely with a hung ASIO driver,
    // freezing the synchronous utility dispatcher and all pending IPC requests.
    PaError stopErr = Pa_AbortStream(g_stream);
    if (stopErr != paNoError)
      std::fprintf(stderr, "[addon] Pa_AbortStream: %s — forcing close\n",
                   Pa_GetErrorText(stopErr));
    // Pa_CloseStream is called unconditionally: it stops the stream if still
    // active (e.g. ASIO driver hang) and frees resources.  cleanupDecoderState
    // below is safe because Pa_CloseStream guarantees the RT callback is not
    // running by the time it returns.
    Pa_CloseStream(g_stream);
    g_stream = nullptr;
  }
  g_streamInputChannels.store(0, std::memory_order_release);
  g_streamOutputChannels.store(0, std::memory_order_release);
  g_monitorGain.store(0.0f, std::memory_order_relaxed);

#ifdef KGB_WITH_VST
  // Free the insert-chain scratch. Pa_CloseStream above guarantees the RT
  // callback has stopped, so this cannot race the audio thread. Loaded plugins
  // and per-channel chain tables persist across stream restarts (V10).
  g_vstScratchCap.store(0, std::memory_order_release);
  std::free(g_vstScratch);
  g_vstScratch = nullptr;
  std::free(g_monoScratch);
  g_monoScratch = nullptr;
  // Bug #4: free synthesis scratch buffers.
  std::free(g_synthScratch);
  g_synthScratch = nullptr;
  std::free(g_synthMixBuf);
  g_synthMixBuf  = nullptr;
#endif

  // Discard any inbound packets queued for the worker — they belong to the
  // stream being torn down. (outputChannels is already 0 above, so even a packet
  // the worker popped just before this clear is skipped in drainDecodeQueue.)
  {
    std::lock_guard<std::mutex> qlk(g_decodeQueueMx);
    g_decodeQueue.clear();
  }

  // E5: coordinate codec/TSFN teardown with the worker thread. Under g_opusMx
  // the worker is either idle or about to re-check the alive flags; once we set
  // them false + Release here, the worker (next time it locks) skips all delivery
  // and codec use. The RT callback is already stopped (above), so destroying
  // peer decoders/encoders cannot race the audio thread.
  std::lock_guard<std::mutex> lk(g_opusMx);

  const bool pcmWasAlive  = g_tsfnAlive.exchange(false, std::memory_order_acq_rel);
  const bool opusWasAlive = g_opusTsfnAlive.exchange(false, std::memory_order_acq_rel);

  if (pcmWasAlive) {
    g_pcmTsfn.Release();
  }

  // Destroy encoders BEFORE releasing opus TSFN. The worker validates enc against
  // the current global under this same mutex, so after cleanupOpusState() it sees
  // nullptr and skips. Any pending TSFN lambdas (already enqueued) still run on
  // the JS event loop and only touch their own payload — they never re-encode.
  //
  // g_opusTsfnFill is NOT reset here: pending lambdas still run after Release()
  // and each does fetch_sub(1). Resetting to 0 before they drain would push the
  // counter negative. The counter reaches 0 naturally once all lambdas complete.
  cleanupOpusState();
  if (opusWasAlive) {
    g_opusTsfn.Release();
  }

  // A4b: destroy all peer decoders. RT is stopped (above) and the worker is
  // serialised by g_opusMx, so peer rings/decoders are no longer accessed.
  cleanupDecoderState();

  return env.Undefined();
}

// ─── isStreamActive ───────────────────────────────────────────────────────────
Napi::Value IsStreamActive(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_stream) return Napi::Boolean::New(env, false);
  return Napi::Boolean::New(env, Pa_IsStreamActive(g_stream) == 1);
}

// ─── setMonitorGain ───────────────────────────────────────────────────────────
Napi::Value SetMonitorGain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "setMonitorGain(gain: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  float gain = static_cast<float>(info[0].As<Napi::Number>().DoubleValue());
  if (!(gain >= 0.0f)) gain = 0.0f;
  if (gain > 4.0f)     gain = 4.0f;
  g_monitorGain.store(gain, std::memory_order_relaxed);
  return env.Undefined();
}

// ─── setMasterGain ────────────────────────────────────────────────────────────
// Scales the whole output bus (monitor + peers + softmix) before the limiter.
// gain ∈ [0, 4]; 0 = silence, 1 = unity. Persists across stream restarts.
Napi::Value SetMasterGain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "setMasterGain(gain: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  float gain = static_cast<float>(info[0].As<Napi::Number>().DoubleValue());
  if (!(gain >= 0.0f)) gain = 0.0f;
  if (gain > 4.0f)     gain = 4.0f;
  g_masterGain.store(gain, std::memory_order_relaxed);
  return env.Undefined();
}

// ─── getStreamLatency ─────────────────────────────────────────────────────────
Napi::Value GetStreamLatency(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object r = Napi::Object::New(env);
  if (!g_stream) {
    r.Set("inputLatency",  Napi::Number::New(env, 0.0));
    r.Set("outputLatency", Napi::Number::New(env, 0.0));
    r.Set("sampleRate",    Napi::Number::New(env, 0.0));
    return r;
  }
  const PaStreamInfo* si = Pa_GetStreamInfo(g_stream);
  r.Set("inputLatency",  Napi::Number::New(env, si ? si->inputLatency  : 0.0));
  r.Set("outputLatency", Napi::Number::New(env, si ? si->outputLatency : 0.0));
  r.Set("sampleRate",    Napi::Number::New(env, si ? si->sampleRate    : 0.0));
  return r;
}

// ─── E3: getStreamTime ────────────────────────────────────────────────────────
// Returns Pa_GetStreamTime(g_stream) — monotonic seconds since the stream was
// opened, on the same clock as PaStreamCallbackTimeInfo::currentTime.
// Used by the renderer to anchor AudioContext.currentTime against PortAudio
// time for clock-drift correction of recorded clip positions (§1.1 E3 pt.2).
// Returns 0.0 if no stream is open.
Napi::Value GetStreamTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const double t = g_stream ? Pa_GetStreamTime(g_stream) : 0.0;
  return Napi::Number::New(env, t);
}

// ─── A4.5: getStats ───────────────────────────────────────────────────────────
// Returns a monotonic snapshot of audio health metrics.
// Counters are never reset — the JS side diffs consecutive readings.
//
//   xrunCount:     paInputOverflow + paOutputUnderflow events since process start.
//   dropCount:     PCM or Opus frames dropped (TSFN queue full).
//   bufferFillPct: opus TSFN queue depth as percent of capacity (queue = 64 slots).
//   cpuLoad:       Pa_GetStreamCpuLoad(), 0..1 fraction of callback budget used.
Napi::Value GetStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  const double cpuLoad = g_stream ? Pa_GetStreamCpuLoad(g_stream) : 0.0;

  const int64_t fill    = g_opusTsfnFill.load(std::memory_order_relaxed);
  const double fillPct  = (static_cast<double>(fill) / 64.0) * 100.0;

  Napi::Object r = Napi::Object::New(env);
  r.Set("xrunCount",
        Napi::Number::New(env, static_cast<double>(g_xrunCount.load(std::memory_order_relaxed))));
  r.Set("dropCount",
        Napi::Number::New(env, static_cast<double>(g_dropCount.load(std::memory_order_relaxed))));
  r.Set("bufferFillPct", Napi::Number::New(env, fillPct));
  r.Set("cpuLoad",       Napi::Number::New(env, cpuLoad));

  // M5: per-channel RMS levels keyed by peerId.
  // Iterates g_peerSlots, parses "peerId/channelId" key, builds
  // remoteChannelLevels: { [peerId]: number[] } where index = channelIdx.
  Napi::Object remoteLevels = Napi::Object::New(env);
  for (int i = 0; i < MAX_PEERS; i++) {
    PeerDecState* p = g_peerSlots[i].load(std::memory_order_acquire);
    if (!p) continue;

    const std::string& key = p->key;
    const size_t sep = key.rfind('/');
    if (sep == std::string::npos || sep == 0) continue;

    const std::string peerId = key.substr(0, sep);
    const std::string chStr  = key.substr(sep + 1);
    int chIdx = 0;
    try { chIdx = std::stoi(chStr); } catch (...) { continue; }
    if (chIdx < 0 || chIdx > 63) continue;

    const float lvl = p->rmsLevel.load(std::memory_order_relaxed);

    // Get or create the per-peer level array.
    Napi::Array arr;
    Napi::Value existing = remoteLevels.Get(peerId);
    if (existing.IsArray()) {
      arr = existing.As<Napi::Array>();
    } else {
      arr = Napi::Array::New(env);
      remoteLevels.Set(peerId, arr);
    }
    // Zero-fill up to chIdx so the array has contiguous indices.
    while (arr.Length() <= static_cast<uint32_t>(chIdx)) {
      arr.Set(arr.Length(), Napi::Number::New(env, 0.0));
    }
    arr.Set(static_cast<uint32_t>(chIdx), Napi::Number::New(env, static_cast<double>(lvl)));
  }
  r.Set("remoteChannelLevels", remoteLevels);

  return r;
}

// ─── A4b / E5: PushInboundOpus ────────────────────────────────────────────────
// JS-thread entry point for inbound Opus packets from remote peers. The actual
// decoding (jitter buffer + opus_decode_float) runs on the worker thread (§1.5);
// this only copies the packet and hands it off.
// Signature: pushInboundOpus(peerId, channelId, sequence, timestampUs, payload)
//   peerId, channelId : string  — form the per-decoder key
//   sequence          : uint32  — monotonic counter from the remote encoder
//   timestampUs       : any     — accepted for API compat, not used in decoder path
//   payload           : ArrayBuffer — raw Opus bitstream
Napi::Value PushInboundOpus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 5 ||
      !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsNumber() || !info[4].IsArrayBuffer()) {
    Napi::TypeError::New(env,
        "pushInboundOpus(peerId, channelId, sequence, timestampUs, payload)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const std::string peerId    = info[0].As<Napi::String>().Utf8Value();
  const std::string channelId = info[1].As<Napi::String>().Utf8Value();
  const uint32_t    sequence  = info[2].As<Napi::Number>().Uint32Value();
  Napi::ArrayBuffer payload = info[4].As<Napi::ArrayBuffer>();

  // Guard: if the active stream has no output device (capture-only mode),
  // decoded PCM has nowhere to play back.  Skipping avoids filling peer rings
  // to no effect, saturating g_dropCount with misleading drop events, and
  // wasting CPU on decoding that will never be heard.
  if (g_streamOutputChannels.load(std::memory_order_acquire) == 0)
    return env.Undefined();

  // Empty payload (zero-length ArrayBuffer or detached buffer where Data()→null):
  // an empty packet would advance nextSeq over a silent slot in the decoder,
  // desynchronising it. Drop it here; the jitter PLC path conceals the gap.
  const uint8_t* data = static_cast<const uint8_t*>(payload.Data());
  const size_t   len  = payload.ByteLength();
  if (len == 0) return env.Undefined();

  // Hand the packet to the worker thread (off the JS event loop). ArrayBuffer
  // data must be read on the JS thread, so copy into the queue item here. Only
  // the lightweight queue mutex is taken — never blocks behind a decode.
  {
    std::lock_guard<std::mutex> qlk(g_decodeQueueMx);
    if (g_decodeQueue.size() >= DECODE_QUEUE_MAX) {
      // Worker overwhelmed (e.g. a stall): drop newest rather than grow unbounded.
      g_dropCount.fetch_add(1, std::memory_order_relaxed);
      return env.Undefined();
    }
    g_decodeQueue.push_back(InboundPkt{
        peerId + "/" + channelId, sequence,
        std::vector<uint8_t>(data, data + len)});
  }
  g_opusCv.notify_one();
  return env.Undefined();
}

// ─── M4: setRemoteChannelGain ─────────────────────────────────────────────────
// JS-thread entry point. Sets the output gain for a specific remote peer channel.
// Safe to call before any packet arrives — gain is stashed in g_pendingGains and
// applied when the PeerDecState is created by the first pushInboundOpus call.
//
// Signature: setRemoteChannelGain(peerId: string, channelId: string, gain: number)
//   gain: linear amplitude, clamped to [0, 4]. 0 = muted, 1 = unity, >1 = boost.
Napi::Value SetRemoteChannelGain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "setRemoteChannelGain(peerId, channelId, gain)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string peerId    = info[0].As<Napi::String>().Utf8Value();
  const std::string channelId = info[1].As<Napi::String>().Utf8Value();
  float gain = static_cast<float>(info[2].As<Napi::Number>().DoubleValue());
  if (!(gain >= 0.0f)) gain = 0.0f;
  if (gain > 4.0f)     gain = 4.0f;

  const std::string key = peerId + "/" + channelId;

  // E5: hold g_opusMx so the slot scan + pending-gain stash are atomic against
  // the worker's findOrCreatePeer (which also reads g_pendingGains and publishes
  // new peer slots). Without it, a gain set in the instant a peer is being
  // created could be lost (stashed in pending after the peer already drained it).
  std::lock_guard<std::mutex> lk(g_opusMx);

  // Fast path: PeerDecState already exists — update atomically.
  for (int i = 0; i < MAX_PEERS; i++) {
    PeerDecState* p = g_peerSlots[i].load(std::memory_order_acquire);
    if (p && p->key == key) {
      p->gain.store(gain, std::memory_order_relaxed);
      return env.Undefined();
    }
  }

  // Slow path: peer not yet created — stash for when the first packet arrives.
  g_pendingGains[key] = gain;
  return env.Undefined();
}

// ─── PushSoftmix ──────────────────────────────────────────────────────────────
// Called from the utility JS thread with a Float32Array of mono PCM samples
// captured by the AudioWorklet from the Tone.js master bus. Writes samples into
// the SPSC ring; excess samples are silently dropped when the ring is full
// (PortAudio underrun is already pending in that case).
Napi::Value PushSoftmix(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) return env.Undefined();
  Napi::Float32Array arr = info[0].As<Napi::Float32Array>();
  const float*   src = arr.Data();
  const uint32_t n   = static_cast<uint32_t>(arr.ElementLength());
  if (n == 0) return env.Undefined();

  const uint32_t w     = g_softmixWpos.load(std::memory_order_relaxed);
  const uint32_t r     = g_softmixRpos.load(std::memory_order_acquire);
  const uint32_t free_ = SOFTMIX_RING_CAP - (w - r);
  const uint32_t write = n < free_ ? n : free_;  // drop newest when ring full

  for (uint32_t i = 0; i < write; i++)
    g_softmixBuf[(w + i) & (SOFTMIX_RING_CAP - 1u)] = src[i];

  if (write > 0)
    g_softmixWpos.store(w + write, std::memory_order_release);

  return env.Undefined();
}

#ifdef KGB_WITH_VST
// ─── VST3 host bindings (V2 scan / V3 load+unload+params + chain) ─────────────
static Napi::Object classDescToObj(Napi::Env env, const kgb::vst::ClassDesc& c) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("name",          Napi::String::New(env, c.name));
  o.Set("vendor",        Napi::String::New(env, c.vendor));
  o.Set("version",       Napi::String::New(env, c.version));
  o.Set("category",      Napi::String::New(env, c.category));
  o.Set("type",          Napi::String::New(env, c.type));
  o.Set("subCategories", Napi::String::New(env, c.subCategories));
  o.Set("uid",           Napi::String::New(env, c.uid));
  o.Set("path",          Napi::String::New(env, c.path));
  return o;
}

// scanVst3(paths?: string[]) → ClassDesc[]   (empty/omitted → OS default paths)
static Napi::Value ScanVst3(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<std::string> paths;
  if (info.Length() >= 1 && info[0].IsArray()) {
    Napi::Array arr = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value v = arr.Get(i);
      if (v.IsString()) paths.push_back(v.As<Napi::String>().Utf8Value());
    }
  }
  auto classes = kgb::vst::scan(paths);
  Napi::Array out = Napi::Array::New(env, classes.size());
  for (uint32_t i = 0; i < classes.size(); i++) out.Set(i, classDescToObj(env, classes[i]));
  return out;
}

// defaultVst3Paths() → string[]
static Napi::Value DefaultVst3Paths(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto paths = kgb::vst::defaultSearchPaths();
  Napi::Array out = Napi::Array::New(env, paths.size());
  for (uint32_t i = 0; i < paths.size(); i++) out.Set(i, Napi::String::New(env, paths[i]));
  return out;
}

// loadPlugin(path, classUid, sampleRate, maxBlockSize, slotId) → LoadResult
static Napi::Value LoadPlugin(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5 || !info[0].IsString() || !info[1].IsString() ||
      !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
    Napi::TypeError::New(env,
        "loadPlugin(path:string, classUid:string, sampleRate:number, "
        "maxBlockSize:number, slotId:number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  auto r = kgb::vst::loadPlugin(
      info[0].As<Napi::String>().Utf8Value(),
      info[1].As<Napi::String>().Utf8Value(),
      info[2].As<Napi::Number>().DoubleValue(),
      info[3].As<Napi::Number>().Int32Value(),
      info[4].As<Napi::Number>().Int32Value());

  Napi::Object o = Napi::Object::New(env);
  o.Set("ok",    Napi::Boolean::New(env, r.ok));
  o.Set("error", Napi::String::New(env, r.error));
  o.Set("slotId", Napi::Number::New(env, r.slotId));
  o.Set("name",   Napi::String::New(env, r.name));
  o.Set("vendor", Napi::String::New(env, r.vendor));
  o.Set("type",   Napi::String::New(env, r.type));
  o.Set("uid",    Napi::String::New(env, r.uid));
  o.Set("numInputChannels",  Napi::Number::New(env, r.numInputChannels));
  o.Set("numOutputChannels", Napi::Number::New(env, r.numOutputChannels));
  Napi::Array params = Napi::Array::New(env, r.params.size());
  for (uint32_t i = 0; i < r.params.size(); i++) {
    const auto& p = r.params[i];
    Napi::Object po = Napi::Object::New(env);
    po.Set("id",                Napi::Number::New(env, p.id));
    po.Set("title",             Napi::String::New(env, p.title));
    po.Set("units",             Napi::String::New(env, p.units));
    po.Set("defaultNormalized", Napi::Number::New(env, p.defaultNormalized));
    po.Set("stepCount",         Napi::Number::New(env, p.stepCount));
    po.Set("flags",             Napi::Number::New(env, p.flags));
    params.Set(i, po);
  }
  o.Set("params", params);
  return o;
}

// unloadPlugin(slotId) → boolean
static Napi::Value UnloadPlugin(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "unloadPlugin(slotId:number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(env, kgb::vst::unloadPlugin(info[0].As<Napi::Number>().Int32Value()));
}

// setParam(slotId, paramId, valueNormalized) → boolean
static Napi::Value SetParam(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "setParam(slotId:number, paramId:number, value:number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(env, kgb::vst::setParamNormalized(
      info[0].As<Napi::Number>().Int32Value(),
      static_cast<uint32_t>(info[1].As<Napi::Number>().Int64Value()),
      info[2].As<Napi::Number>().DoubleValue()));
}

// getParam(slotId, paramId) → number (normalized)
static Napi::Value GetParam(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "getParam(slotId:number, paramId:number)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Number::New(env, kgb::vst::getParamNormalized(
      info[0].As<Napi::Number>().Int32Value(),
      static_cast<uint32_t>(info[1].As<Napi::Number>().Int64Value())));
}

// openEditor(slotId) → boolean   (V4: native plugin editor window)
static Napi::Value OpenEditor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "openEditor(slotId:number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(env, kgb::vst::openEditor(info[0].As<Napi::Number>().Int32Value()));
}

// closeEditor(slotId) → undefined
static Napi::Value CloseEditor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() >= 1 && info[0].IsNumber())
    kgb::vst::closeEditor(info[0].As<Napi::Number>().Int32Value());
  return env.Undefined();
}

// pumpEditor() → undefined   (drain editor window messages; call on a timer)
static Napi::Value PumpEditor(const Napi::CallbackInfo& info) {
  kgb::vst::pumpEditorMessages();
  return info.Env().Undefined();
}

// V6: setChannelChain(channelIdx:number, slotIds:number[]) → undefined
// Sets the insert chain for a single physical input channel. Empty array clears
// the chain for that channel (passthrough). Persists across stream restarts.
static Napi::Value SetChannelChain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "setChannelChain(channelIdx:number, slotIds:number[])")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  const int ch = info[0].As<Napi::Number>().Int32Value();
  if (ch < 0 || ch >= MAX_INPUT_CH) {
    Napi::RangeError::New(env, "channelIdx out of range [0, 63]")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Array arr = info[1].As<Napi::Array>();
  int n = 0;
  for (uint32_t i = 0; i < arr.Length() && n < MAX_VST_CHAIN; i++) {
    Napi::Value v = arr.Get(i);
    if (!v.IsNumber()) continue;
    g_chanChainSlots[ch][n].store(v.As<Napi::Number>().Int32Value(), std::memory_order_relaxed);
    n++;
  }
  // Bug #3: keep pre-computed total in sync before publishing the new count.
  // Load old count (JS-thread-only writes → no data race on the load).
  const int prevN = g_chanChainCounts[ch].load(std::memory_order_relaxed);
  // Publish count last (release) so RT never reads a stale slot id.
  g_chanChainCounts[ch].store(n, std::memory_order_release);
  // After the per-channel count is visible to RT, update the summary counter.
  // RT reads g_totalChanChains with relaxed then falls back to per-channel
  // acquire loads, so a brief gap between the two stores is safe.
  if ((prevN > 0) != (n > 0))
    g_totalChanChains.fetch_add(n > 0 ? 1 : -1, std::memory_order_relaxed);
  return env.Undefined();
}

// V9: getPluginState(slotId:number) → {ok:boolean, data?:ArrayBuffer, error?:string}
static Napi::Value GetPluginState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "getPluginState(slotId:number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::vector<uint8_t> data;
  const bool ok = kgb::vst::getPluginState(info[0].As<Napi::Number>().Int32Value(), data);
  Napi::Object r = Napi::Object::New(env);
  r.Set("ok", Napi::Boolean::New(env, ok));
  if (ok && !data.empty()) {
    Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, data.size());
    std::memcpy(ab.Data(), data.data(), data.size());
    r.Set("data", ab);
  } else {
    r.Set("data", env.Null());
    if (!ok) r.Set("error", Napi::String::New(env, "getPluginState failed"));
  }
  return r;
}

// V9: setPluginState(slotId:number, data:ArrayBuffer) → {ok:boolean, error?:string}
static Napi::Value SetPluginState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArrayBuffer()) {
    Napi::TypeError::New(env, "setPluginState(slotId:number, data:ArrayBuffer)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::ArrayBuffer ab = info[1].As<Napi::ArrayBuffer>();
  const std::vector<uint8_t> data(
      static_cast<const uint8_t*>(ab.Data()),
      static_cast<const uint8_t*>(ab.Data()) + ab.ByteLength());
  const bool ok = kgb::vst::setPluginState(info[0].As<Napi::Number>().Int32Value(), data);
  Napi::Object r = Napi::Object::New(env);
  r.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok) r.Set("error", Napi::String::New(env, "setPluginState failed"));
  return r;
}

// I3: noteOn(slotId, channel, pitch, velocity) → undefined
static Napi::Value VstNoteOn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "noteOn(slotId,channel,pitch,velocity)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  kgb::vst::noteOn(info[0].As<Napi::Number>().Int32Value(),
                   info[1].As<Napi::Number>().Int32Value(),
                   info[2].As<Napi::Number>().Int32Value(),
                   info[3].As<Napi::Number>().Int32Value());
  return env.Undefined();
}

// I3: noteOff(slotId, channel, pitch) → undefined
static Napi::Value VstNoteOff(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "noteOff(slotId,channel,pitch)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  kgb::vst::noteOff(info[0].As<Napi::Number>().Int32Value(),
                    info[1].As<Napi::Number>().Int32Value(),
                    info[2].As<Napi::Number>().Int32Value());
  return env.Undefined();
}

// I1: setTrackChain(trackId, slotIds[]) → undefined
// Registers the VST insert chain for a logical track ID.
// An empty/missing slotIds array clears the chain for that track.
static Napi::Value VstSetTrackChain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "setTrackChain(trackId,slotIds[])").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int trackId = info[0].As<Napi::Number>().Int32Value();
  std::vector<int> slots;
  if (info.Length() >= 2 && info[1].IsArray()) {
    Napi::Array arr = info[1].As<Napi::Array>();
    slots.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value v = arr.Get(i);
      if (v.IsNumber()) slots.push_back(v.As<Napi::Number>().Int32Value());
    }
  }
  kgb::vst::setTrackChain(trackId, slots.empty() ? nullptr : slots.data(),
                           static_cast<int>(slots.size()));
  return env.Undefined();
}

// vstGetLatency(slotId: number) → number
// PDC (Plugin Delay Compensation): returns IAudioProcessor::getLatencySamples()
// for the plugin in `slotId`. Returns 0 if the slot is empty or the plugin
// reports no latency. JS-thread only — acquires the slot pointer with acquire load
// (safe since the RT callback never writes to g_slots, only reads).
#ifdef KGB_WITH_VST
static Napi::Value VstGetLatency(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "vstGetLatency(slotId:number)").ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }
  const int slotId = info[0].As<Napi::Number>().Int32Value();
  if (slotId < 0 || slotId >= kgb::vst::kMaxSlots)
    return Napi::Number::New(env, 0);

  // g_slots lives in vstHost.cc; access it through the public slot table.
  // getLatencySamples() is declared on IAudioProcessor (VST3 SDK), and the
  // processor pointer is stored inside PluginSlot — we read it via the header.
  // We cannot touch PluginSlot directly from addon.cc (it's internal to
  // vstHost.cc), so we add a thin wrapper in vstHost.h / vstHost.cc.
  const int32_t latency = kgb::vst::getPluginLatencySamples(slotId);
  return Napi::Number::New(env, static_cast<double>(latency));
}
#endif  // KGB_WITH_VST

// Bug #4: setSynthChain(slotIds: number[]) → boolean
// Registers the VSTi instrument slots to call every RT callback for synthesis output.
// JS calls this whenever a track's instrument chain changes (load/unload/bypass).
// Lock-free: stores into g_synthSlots[] (relaxed) then publishes count (release).
static Napi::Value SetSynthChain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "setSynthChain(slotIds:number[])").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Array arr = info[0].As<Napi::Array>();
  int n = 0;
  for (uint32_t i = 0; i < arr.Length() && n < MAX_SYNTH_SLOTS; i++) {
    Napi::Value v = arr.Get(i);
    if (!v.IsNumber()) continue;
    g_synthSlots[n].store(v.As<Napi::Number>().Int32Value(), std::memory_order_relaxed);
    n++;
  }
  // Publish count last (release) so the RT callback never reads a stale slot id.
  g_synthCount.store(n, std::memory_order_release);
  return Napi::Boolean::New(env, true);
}

// setInsertChain(slotIds: number[]) → undefined
// Sets the ordered input-side global insert chain (all channels together).
// V6 per-channel chains (setChannelChain) are preferred for per-strip routing.
static Napi::Value SetInsertChain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "setInsertChain(slotIds:number[])").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Array arr = info[0].As<Napi::Array>();
  int n = 0;
  for (uint32_t i = 0; i < arr.Length() && n < MAX_VST_CHAIN; i++) {
    Napi::Value v = arr.Get(i);
    if (!v.IsNumber()) continue;
    g_vstChainSlots[n].store(v.As<Napi::Number>().Int32Value(), std::memory_order_relaxed);
    n++;
  }
  // Publish the count last (release) so the RT callback never reads a slot id
  // that hasn't been written yet.
  g_vstChainCount.store(n, std::memory_order_release);
  return env.Undefined();
}
#endif  // KGB_WITH_VST

// ─── Module init ──────────────────────────────────────────────────────────────
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // E5: start the single Opus worker thread (encode/decode/PCM off the RT and JS
  // threads). Joined on env teardown so a joinable global std::thread never trips
  // std::terminate at static-destruction time.
  g_opusThreadRun.store(true, std::memory_order_release);
  g_opusThread = std::thread(opusWorkerMain);
  env.AddCleanupHook([]() {
    g_opusThreadRun.store(false, std::memory_order_release);
    g_opusCv.notify_all();
    if (g_opusThread.joinable()) g_opusThread.join();
  });

  exports.Set("paInit",           Napi::Function::New(env, PaInit));
  exports.Set("paTerminate",      Napi::Function::New(env, PaTerminate));
  exports.Set("getDevices",       Napi::Function::New(env, GetDevices));
  exports.Set("openStream",       Napi::Function::New(env, OpenStream));
  exports.Set("closeStream",      Napi::Function::New(env, CloseStream));
  exports.Set("isStreamActive",   Napi::Function::New(env, IsStreamActive));
  exports.Set("setMonitorGain",   Napi::Function::New(env, SetMonitorGain));
  exports.Set("setMasterGain",    Napi::Function::New(env, SetMasterGain));
  exports.Set("getStreamLatency", Napi::Function::New(env, GetStreamLatency));
  exports.Set("getStreamTime",    Napi::Function::New(env, GetStreamTime));
  exports.Set("getStats",              Napi::Function::New(env, GetStats));
  exports.Set("pushInboundOpus",       Napi::Function::New(env, PushInboundOpus));
  exports.Set("setRemoteChannelGain",  Napi::Function::New(env, SetRemoteChannelGain));
  exports.Set("pushSoftmix",           Napi::Function::New(env, PushSoftmix));
#ifdef KGB_WITH_VST
  exports.Set("scanVst3",         Napi::Function::New(env, ScanVst3));
  exports.Set("defaultVst3Paths", Napi::Function::New(env, DefaultVst3Paths));
  exports.Set("loadPlugin",       Napi::Function::New(env, LoadPlugin));
  exports.Set("unloadPlugin",     Napi::Function::New(env, UnloadPlugin));
  exports.Set("setParam",         Napi::Function::New(env, SetParam));
  exports.Set("getParam",         Napi::Function::New(env, GetParam));
  exports.Set("openEditor",       Napi::Function::New(env, OpenEditor));
  exports.Set("closeEditor",      Napi::Function::New(env, CloseEditor));
  exports.Set("pumpEditor",       Napi::Function::New(env, PumpEditor));
  exports.Set("setInsertChain",   Napi::Function::New(env, SetInsertChain));
  exports.Set("setChannelChain",  Napi::Function::New(env, SetChannelChain));
  exports.Set("getPluginState",   Napi::Function::New(env, GetPluginState));
  exports.Set("setPluginState",   Napi::Function::New(env, SetPluginState));
  exports.Set("noteOn",           Napi::Function::New(env, VstNoteOn));
  exports.Set("noteOff",          Napi::Function::New(env, VstNoteOff));
  exports.Set("setTrackChain",    Napi::Function::New(env, VstSetTrackChain));
  exports.Set("setSynthChain",    Napi::Function::New(env, SetSynthChain));
  exports.Set("vstGetLatency",    Napi::Function::New(env, VstGetLatency));
  exports.Set("vstEnabled",       Napi::Boolean::New(env, true));
#else
  exports.Set("vstEnabled",       Napi::Boolean::New(env, false));
#endif
  return exports;
}

NODE_API_MODULE(portaudio_addon, Init)
