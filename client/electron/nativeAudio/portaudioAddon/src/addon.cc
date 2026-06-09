#include <napi.h>
#include <portaudio.h>
#include <pa_win_wasapi.h>
#include <opus.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <map>
#include <vector>

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
static Napi::ThreadSafeFunction g_pcmTsfn;
static std::atomic<bool> g_tsfnAlive{false};

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

// OpusEncJob carries one full Opus frame worth of PCM to the JS thread.
// malloc'd pcm is freed inside the TSFN lambda after opus_encode_float().
//
// Known follow-up: move opus_encode_float() to a dedicated worker thread (ring
// buffer SPSC RT→worker) to avoid holding the JS event loop during encoding.
// For A4 we encode on the JS thread for simplicity; xrun pressure from the
// encoder will surface in xrunCount/dropCount metrics added by A4.5.
struct OpusEncJob {
  int      channelIndex;
  uint32_t sequence;
  int64_t  timestampUs;  // Pa stream time in µs at the start of this frame
  float*   pcm;          // malloc'd copy, frameSize floats
  int      frameSize;
};

static Napi::ThreadSafeFunction g_opusTsfn;
static std::atomic<bool>        g_opusTsfnAlive{false};

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
static constexpr uint32_t SOFTMIX_RING_CAP = 8192u;
static float              g_softmixBuf[SOFTMIX_RING_CAP] = {};
static std::atomic<uint32_t> g_softmixRpos{0};
static std::atomic<uint32_t> g_softmixWpos{0};

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

// ─── A4b decoder helpers (JS thread only) ────────────────────────────────────

// Find existing or create new PeerDecState for 'key'.  Returns nullptr on OOM or
// decoder create failure.  Called only from the JS thread (no concurrent writes).
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

// Destroy all peer decoders.  Safe to call only after Pa_StopStream().
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

// ─── PortAudio RT callback ────────────────────────────────────────────────────
// Runs on the audio thread — must not block.
//
// Responsibilities:
//   1. A4.5 stats: count xruns from PaStreamCallbackFlags.
//   2. Native monitoring: copy input → output × g_monitorGain.
//   3. PCM TSFN: ship raw PCM to the JS thread (existing A3 path).
//   4. A4 Opus: accumulate per-channel PCM; when a full Opus frame is ready,
//      push it to the JS thread (g_opusTsfn) for encoding.
//
// RT-safety note: the existing code already does malloc/new in the RT callback
// to carry PCM to the TSFN (see comment in the PCM block below). The Opus path
// follows the same pattern. A future improvement (encoder worker thread) will
// replace both malloc calls with a preallocated SPSC ring — tracked as a
// follow-up, not a blocker for A4.
static int PaCallback(const void* input, void* output, unsigned long frames,
                      const PaStreamCallbackTimeInfo* timeInfo,
                      PaStreamCallbackFlags flags, void* /*userData*/) {
  const float* in  = static_cast<const float*>(input);
  float*       out = static_cast<float*>(output);
  const int inCh  = g_streamInputChannels.load(std::memory_order_acquire);
  const int outCh = g_streamOutputChannels.load(std::memory_order_acquire);
  const float gain = g_monitorGain.load(std::memory_order_relaxed);

  // ── A4.5: xrun tracking ───────────────────────────────────────────────────
  if (flags & paInputOverflow)    g_xrunCount.fetch_add(1, std::memory_order_relaxed);
  if (flags & paOutputUnderflow)  g_xrunCount.fetch_add(1, std::memory_order_relaxed);

  // ── Native monitoring + A4b peer mix ─────────────────────────────────────
  // Always zero the output buffer first, then additively blend monitor signal
  // and all inbound peer rings so neither path stomps on the other.
  if (out && outCh > 0) {
    std::memset(out, 0, frames * static_cast<size_t>(outCh) * sizeof(float));

    if (in && inCh > 0 && gain > 0.0f) {
      const float invInCh = 1.0f / static_cast<float>(inCh);
      for (unsigned long f = 0; f < frames; f++) {
        float mono = 0.0f;
        for (int c = 0; c < inCh; c++) mono += in[f * inCh + c];
        mono *= invInCh * gain;
        for (int c = 0; c < outCh; c++) out[f * outCh + c] = mono;
      }
    }

    // A4b + M4 + M5: mix one mono PCM ring per remote peer into every output channel,
    // scaled by the per-channel gain (M4). Simultaneously compute pre-gain RMS for
    // the leaky integrator (M5) so the VU meter reflects the actual decoded level.
    for (int s = 0; s < MAX_PEERS; s++) {
      PeerDecState* peer = g_peerSlots[s].load(std::memory_order_acquire);
      if (!peer) continue;
      const float peerGain = peer->gain.load(std::memory_order_relaxed);
      const uint32_t r     = peer->ring.rpos.load(std::memory_order_relaxed);
      const uint32_t w     = peer->ring.wpos.load(std::memory_order_acquire);
      const uint32_t avail = w - r; // unsigned subtraction handles wrap correctly
      const uint32_t take  = avail < static_cast<uint32_t>(frames)
                               ? avail : static_cast<uint32_t>(frames);

      float sumSq = 0.0f;
      for (uint32_t f = 0; f < static_cast<uint32_t>(frames); f++) {
        float raw = 0.0f;
        if (f < take) {
          raw = peer->ring.buf[(r + f) & (PEER_RING_CAP - 1)];
          sumSq += raw * raw;
        }
        const float samp = raw * peerGain;
        for (int c = 0; c < outCh; c++) out[f * outCh + c] += samp;
      }

      // M5: leaky integrator — level = 0.9*level + 0.1*frameRms.
      // RMS over decoded samples only (pre-gain); 0 when ring was empty (underrun).
      const float frameRms = (take > 0)
          ? std::sqrt(sumSq / static_cast<float>(take))
          : 0.0f;
      const float curLev = peer->rmsLevel.load(std::memory_order_relaxed);
      peer->rmsLevel.store(0.9f * curLev + 0.1f * frameRms, std::memory_order_relaxed);

      peer->ring.rpos.store(r + take, std::memory_order_release);
    }

    // Softmix: Tone.js / Web Audio PCM routed through PortAudio output.
    // AudioWorklet captures the Tone.js master bus (stereo→mono) and sends it
    // here via IPC. Mixed additively so it blends with monitor and peer audio.
    {
      const uint32_t smr   = g_softmixRpos.load(std::memory_order_relaxed);
      const uint32_t smw   = g_softmixWpos.load(std::memory_order_acquire);
      const uint32_t avail = smw - smr; // unsigned wrap is intentional
      const uint32_t take  = avail < static_cast<uint32_t>(frames)
                               ? avail : static_cast<uint32_t>(frames);
      for (uint32_t f = 0; f < static_cast<uint32_t>(frames); f++) {
        const float samp = (f < take)
            ? g_softmixBuf[(smr + f) & (SOFTMIX_RING_CAP - 1u)]
            : 0.0f;
        for (int c = 0; c < outCh; c++)
          out[f * static_cast<unsigned long>(outCh) + static_cast<unsigned long>(c)] += samp;
      }
      if (take > 0)
        g_softmixRpos.store(smr + take, std::memory_order_release);
    }

    // Hard-clip the final mix to [-1, 1] to prevent DAC distortion when
    // several hot peers are active simultaneously (monitor + N peers can
    // easily exceed ±1 without this guard).
    for (unsigned long f = 0; f < frames; f++) {
      for (int c = 0; c < outCh; c++) {
        float& s = out[f * static_cast<unsigned long>(outCh) + static_cast<unsigned long>(c)];
        if      (s >  1.0f) s =  1.0f;
        else if (s < -1.0f) s = -1.0f;
      }
    }
  }

  // ── PCM TSFN (A3 path) ────────────────────────────────────────────────────
  // malloc/new here is technically not RT-safe; this is a known A3 limitation
  // (see ADR §6.1 R8). A preallocated ring will replace this in a follow-up.
  if (in && inCh > 0 && g_tsfnAlive.load(std::memory_order_acquire)) {
    const size_t bytes = static_cast<size_t>(frames) * inCh * sizeof(float);
    float* copy = static_cast<float*>(std::malloc(bytes));
    if (copy) {
      std::memcpy(copy, in, bytes);
      PcmChunk* chunk = new PcmChunk{copy, frames, static_cast<size_t>(inCh)};
      napi_status status = g_pcmTsfn.NonBlockingCall(chunk,
        [](Napi::Env env, Napi::Function jsCb, PcmChunk* c) {
          const size_t bytes = c->frames * c->channels * sizeof(float);
          try {
            Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, bytes);
            std::memcpy(ab.Data(), c->data, bytes);
            jsCb.Call({
              ab,
              Napi::Number::New(env, static_cast<double>(c->frames)),
              Napi::Number::New(env, static_cast<double>(c->channels)),
            });
          } catch (...) {}
          std::free(c->data);
          delete c;
        });
      if (status != napi_ok) {
        std::free(copy);
        delete chunk;
        g_dropCount.fetch_add(1, std::memory_order_relaxed);
      }
    }
  }

  // ── A4 Opus encoder ───────────────────────────────────────────────────────
  // Accumulate deinterleaved per-channel PCM in pre-allocated accumBuf (no
  // alloc in the hot path). When a full Opus frame is ready, malloc a copy and
  // ship to the JS thread (g_opusTsfn) for encoding.
  const int opusNumCh = g_opusNumCh.load(std::memory_order_acquire);
  if (in && inCh > 0 && opusNumCh > 0 && g_opusTsfnAlive.load(std::memory_order_acquire)) {
    const int64_t tsUs = timeInfo
        ? static_cast<int64_t>(timeInfo->currentTime * 1e6)
        : 0;

    for (int ch = 0; ch < inCh && ch < opusNumCh; ch++) {
      OpusChannelState& st = g_opusCh[ch];
      if (!st.enc) continue;

      for (unsigned long f = 0; f < frames; f++) {
        st.accumBuf[st.accumCount++] = in[f * inCh + ch];

        if (st.accumCount >= st.frameSize) {
          // Full Opus frame — ship to JS thread for encoding.
          const size_t pcmBytes = static_cast<size_t>(st.frameSize) * sizeof(float);
          float* pcmCopy = static_cast<float*>(std::malloc(pcmBytes));
          if (pcmCopy) {
            std::memcpy(pcmCopy, st.accumBuf, pcmBytes);
            OpusEncJob* job = new OpusEncJob{
              ch,
              st.sequence++,
              tsUs,
              pcmCopy,
              st.frameSize,
            };
            napi_status s = g_opusTsfn.NonBlockingCall(job,
              [](Napi::Env env, Napi::Function jsCb, OpusEncJob* j) {
                // Consumed from queue — decrement fill tracker immediately.
                g_opusTsfnFill.fetch_sub(1, std::memory_order_relaxed);

                // Encoder pointer may be null if closeStream() ran on the JS
                // thread between the NonBlockingCall and this lambda firing.
                // Both closeStream() and this lambda run on the same JS thread
                // so they never interleave, but the sequence can be:
                //   RT enqueues job → closeStream sets enc=nullptr → lambda runs
                OpusEncoder* enc = g_opusCh[j->channelIndex].enc;
                if (enc) {
                  unsigned char encoded[OPUS_MAX_PACKET];
                  int encodedLen = opus_encode_float(enc, j->pcm, j->frameSize,
                                                     encoded, OPUS_MAX_PACKET);
                  if (encodedLen > 0) {
                    try {
                      Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, encodedLen);
                      std::memcpy(ab.Data(), encoded, encodedLen);
                      jsCb.Call({
                        ab,
                        Napi::Number::New(env, j->channelIndex),
                        Napi::Number::New(env, static_cast<double>(j->sequence)),
                        Napi::BigInt::New(env, j->timestampUs),
                      });
                    } catch (...) {}
                  }
                }

                std::free(j->pcm);
                delete j;
              });

            if (s == napi_ok) {
              g_opusTsfnFill.fetch_add(1, std::memory_order_relaxed);
            } else {
              // Queue full (napi_queue_full) or TSFN closing — drop frame.
              std::free(pcmCopy);
              delete job;
              g_dropCount.fetch_add(1, std::memory_order_relaxed);
            }
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

  // A3.5c smoke-test affordance: abort() to verify crash isolation.
  if (opts.Get("crashMe").IsBoolean() && opts.Get("crashMe").As<Napi::Boolean>().Value()) {
    std::abort();
  }

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

  // Mark TSFNs dead before stopping the stream so callbacks stop enqueueing.
  const bool pcmWasAlive  = g_tsfnAlive.exchange(false, std::memory_order_acq_rel);
  const bool opusWasAlive = g_opusTsfnAlive.exchange(false, std::memory_order_acq_rel);

  if (g_stream) {
    PaError stopErr = Pa_StopStream(g_stream);
    if (stopErr != paNoError)
      std::fprintf(stderr, "[addon] Pa_StopStream: %s — forcing close\n",
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

  if (pcmWasAlive) {
    g_pcmTsfn.Release();
  }

  // Destroy encoders BEFORE releasing opus TSFN. Any pending lambdas in the
  // TSFN queue will see enc=nullptr and skip encoding without crashing.
  // (JS thread is single-threaded: closeStream and TSFN lambdas cannot interleave.)
  //
  // g_opusTsfnFill is NOT reset here: pending lambdas still run after Release()
  // and each does fetch_sub(1). Resetting to 0 before they drain would push the
  // counter negative. The counter reaches 0 naturally once all lambdas complete.
  cleanupOpusState();
  if (opusWasAlive) {
    g_opusTsfn.Release();
  }

  // A4b: destroy all peer decoders (Pa_StopStream above guarantees the RT
  // callback is no longer running, so peer rings are no longer accessed).
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

// ─── A4b: PushInboundOpus ─────────────────────────────────────────────────────
// JS-thread entry point for inbound Opus packets from remote peers.
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

  const std::string key = peerId + "/" + channelId;
  PeerDecState* peer = findOrCreatePeer(key);
  if (!peer) return env.Undefined(); // too many peers or decoder create failed

  // Initialise sequence tracking on first packet from this peer.
  if (!peer->seqInit) {
    peer->nextSeq = sequence;
    peer->seqInit = true;
  }

  // Drop late arrivals.  Signed int32 subtraction handles the common uint32
  // wrap-around case correctly up to a distance of 2^31-1 in either direction.
  // Sequences more than 2^31 steps ahead of nextSeq are mis-classified as late
  // (negative signed distance) and silently dropped; at 20 ms/frame this
  // threshold is ~497 days of continuous streaming — well outside normal use.
  if (static_cast<int32_t>(sequence - peer->nextSeq) < 0)
    return env.Undefined();

  // Buffer packet in jitter heap.
  const uint8_t* data = static_cast<const uint8_t*>(payload.Data());
  const size_t   len  = payload.ByteLength();
  // Empty payload (zero-length ArrayBuffer or detached buffer where Data()→null)
  // would store an empty vector, then opus_decode_float(dec, ptr, 0, ...) returns
  // OPUS_INVALID_PACKET and nextSeq would advance over a silent slot — silently
  // desynchronising the decoder.  Drop it here; the jitter PLC path will conceal.
  if (len == 0) return env.Undefined();
  peer->jitter.emplace(sequence, std::vector<uint8_t>(data, data + len));

  decodeAndFlush(peer);
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

// ─── Module init ──────────────────────────────────────────────────────────────
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("paInit",           Napi::Function::New(env, PaInit));
  exports.Set("paTerminate",      Napi::Function::New(env, PaTerminate));
  exports.Set("getDevices",       Napi::Function::New(env, GetDevices));
  exports.Set("openStream",       Napi::Function::New(env, OpenStream));
  exports.Set("closeStream",      Napi::Function::New(env, CloseStream));
  exports.Set("isStreamActive",   Napi::Function::New(env, IsStreamActive));
  exports.Set("setMonitorGain",   Napi::Function::New(env, SetMonitorGain));
  exports.Set("getStreamLatency", Napi::Function::New(env, GetStreamLatency));
  exports.Set("getStats",              Napi::Function::New(env, GetStats));
  exports.Set("pushInboundOpus",       Napi::Function::New(env, PushInboundOpus));
  exports.Set("setRemoteChannelGain",  Napi::Function::New(env, SetRemoteChannelGain));
  exports.Set("pushSoftmix",           Napi::Function::New(env, PushSoftmix));
  return exports;
}

NODE_API_MODULE(portaudio_addon, Init)
