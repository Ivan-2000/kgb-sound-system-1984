#include <napi.h>
#include <portaudio.h>
#include <pa_win_wasapi.h>
#include <opus.h>
#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <string>

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

  // ── Native monitoring ─────────────────────────────────────────────────────
  // Sum all input channels to mono, write to every output channel.
  if (out && outCh > 0) {
    if (in && inCh > 0 && gain > 0.0f) {
      const float invInCh = 1.0f / static_cast<float>(inCh);
      for (unsigned long f = 0; f < frames; f++) {
        float mono = 0.0f;
        for (int c = 0; c < inCh; c++) mono += in[f * inCh + c];
        mono *= invInCh * gain;
        for (int c = 0; c < outCh; c++) out[f * outCh + c] = mono;
      }
    } else {
      std::memset(out, 0, frames * static_cast<size_t>(outCh) * sizeof(float));
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
    g_opusTsfn = Napi::ThreadSafeFunction::New(env, onOpus, "kgb-opus", 64, 1);
    g_opusTsfnAlive.store(true, std::memory_order_relaxed);

    // Release after TSFN is live and all g_opusCh[] entries are set.
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
    Pa_StopStream(g_stream);
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
  cleanupOpusState();
  if (opusWasAlive) {
    g_opusTsfnFill.store(0, std::memory_order_relaxed);
    g_opusTsfn.Release();
  }

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
  return r;
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
  exports.Set("getStats",         Napi::Function::New(env, GetStats));
  return exports;
}

NODE_API_MODULE(portaudio_addon, Init)
