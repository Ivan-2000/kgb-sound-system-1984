#include <napi.h>
#include <portaudio.h>
#include <pa_win_wasapi.h>
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
  // MultiByteToWideChar returns 0 on invalid sequences when MB_ERR_INVALID_CHARS
  // is set — use that as a validity probe.
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, nullptr, 0) > 0)
    return s;  // already valid UTF-8
  // Convert ANSI → UTF-16 → UTF-8
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
// A3 stream sessions rely on a single persistent PA context for their lifetime.
static bool g_paInitialized = false;

// === A3 stream state ===
// Single active stream model — Phase 1 needs only one capture device per
// participant. Multi-stream support is a Phase 2 concern.
struct PcmChunk {
  float* data;
  size_t frames;
  size_t channels;
};

static PaStream* g_stream = nullptr;
// Channel counts are written from the JS thread before Pa_StartStream and read
// from the audio thread inside PaCallback. Atomic with release/acquire to
// avoid the data race UB (Pa_StartStream itself usually fences via syscalls,
// but we don't want to rely on that).
static std::atomic<int> g_streamInputChannels{0};
static std::atomic<int> g_streamOutputChannels{0};
static std::atomic<float> g_monitorGain{0.0f};
static Napi::ThreadSafeFunction g_pcmTsfn;
static std::atomic<bool> g_tsfnAlive{false};

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

// paInit() — must be called once at application startup before getDevices()
// or any stream operations. Idempotent: safe to call when already initialized.
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

// paTerminate() — call on application quit (app.before-quit).
// Idempotent: safe to call when not initialized.
Napi::Value PaTerminate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_paInitialized) return env.Undefined();
  Pa_Terminate();
  g_paInitialized = false;
  return env.Undefined();
}

// getDevices() — requires paInit() to have been called first.
// Returns Array<{ id, name, hostApis, inputChannels, outputChannels, defaultSampleRate }>
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

    // WASAPI devices support Exclusive mode as a distinct operating mode.
    // Expose it as a separate entry so the UI can offer the choice (ADR §3.3).
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

// PortAudio RT callback. Runs on the audio thread — must not block.
// Two responsibilities:
//   1. Native monitoring: copy input → output × g_monitorGain in-place.
//   2. Ship PCM up to JS via ThreadSafeFunction (non-blocking enqueue).
//
// Note on RT-safety: malloc/new here is technically not RT-safe and can spike
// under load. The ADR (§6.1 R8) flags this as a follow-up — a preallocated
// SPSC ring will replace malloc once Opus encoder lands in A4. For A3 the
// goal is a working capture path; xrun-free latency tuning is A6's job.
static int PaCallback(const void* input, void* output, unsigned long frames,
                      const PaStreamCallbackTimeInfo* /*time*/,
                      PaStreamCallbackFlags /*flags*/, void* /*userData*/) {
  const float* in = static_cast<const float*>(input);
  float* out = static_cast<float*>(output);
  const int inCh = g_streamInputChannels.load(std::memory_order_acquire);
  const int outCh = g_streamOutputChannels.load(std::memory_order_acquire);
  const float gain = g_monitorGain.load(std::memory_order_relaxed);

  // Native monitoring path: input → output × gain, no JS round-trip.
  if (out && outCh > 0) {
    if (in && gain > 0.0f) {
      for (unsigned long f = 0; f < frames; f++) {
        for (int c = 0; c < outCh; c++) {
          const float s = (c < inCh) ? in[f * inCh + c] : in[f * inCh + (inCh - 1)];
          out[f * outCh + c] = s * gain;
        }
      }
    } else {
      std::memset(out, 0, frames * outCh * sizeof(float));
    }
  }

  // Ship the captured PCM frame to the JS side via TSFN.
  if (in && inCh > 0 && g_tsfnAlive.load(std::memory_order_acquire)) {
    const size_t bytes = static_cast<size_t>(frames) * inCh * sizeof(float);
    float* copy = static_cast<float*>(std::malloc(bytes));
    if (copy) {
      std::memcpy(copy, in, bytes);
      PcmChunk* chunk = new PcmChunk{copy, frames, static_cast<size_t>(inCh)};
      napi_status status = g_pcmTsfn.NonBlockingCall(chunk,
        [](Napi::Env env, Napi::Function jsCb, PcmChunk* c) {
          // Allocate a V8-managed ArrayBuffer and memcpy our heap copy into
          // it. We used to wrap the heap buffer directly via the external-
          // data overload of Napi::ArrayBuffer::New — but that calls
          // napi_create_external_arraybuffer, which is deprecated under
          // modern V8 (pointer-compression sandbox) and throws at creation
          // time inside the TSFN callback. The thrown exception surfaces as
          // "DEP0168: Uncaught Node-API callback exception".
          //
          // V8-managed ArrayBuffers are cloneable across MessagePortMain and
          // contextBridge; the extra ~2 KB memcpy per frame is negligible
          // (~375 KB/s at 187 fps).
          //
          // The JS callback may throw at any time (e.g. structured-clone
          // failure on postMessage). If that exception unwinds through
          // NAPI we get DEP0168 and leak `c`. Catch everything here and
          // ensure the chunk + its heap data are released exactly once.
          const size_t bytes = c->frames * c->channels * sizeof(float);
          try {
            Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, bytes);
            std::memcpy(ab.Data(), c->data, bytes);
            jsCb.Call({
              ab,
              Napi::Number::New(env, static_cast<double>(c->frames)),
              Napi::Number::New(env, static_cast<double>(c->channels)),
            });
          } catch (...) {
            // Frame dropped — do not let the exception escape back to NAPI.
          }
          std::free(c->data);
          delete c;
        });
      if (status != napi_ok) {
        // Queue full or TSFN closing — drop the frame.
        std::free(copy);
        delete chunk;
      }
    }
  }

  return paContinue;
}

// openStream(opts: { deviceId, hostApiKind, sampleRate, bufferSize, inputChannels },
//            onPcm: (buf: ArrayBuffer, frames: number, channels: number) => void)
//   → { inputLatency, outputLatency, sampleRate, inputChannels, outputChannels, bufferSize }
//
// hostApiKind selects the WASAPI mode (Exclusive vs Shared); for other APIs
// the value is informational since the device index already pins the host API.
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
    Napi::TypeError::New(env, "openStream(opts: object, onPcm: function)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  const int deviceId      = opts.Get("deviceId").As<Napi::Number>().Int32Value();
  const std::string apiKind = opts.Get("hostApiKind").As<Napi::String>().Utf8Value();
  const double sampleRate = opts.Get("sampleRate").As<Napi::Number>().DoubleValue();
  const int bufferSize    = opts.Get("bufferSize").As<Napi::Number>().Int32Value();
  const int inputChannels = opts.Get("inputChannels").As<Napi::Number>().Int32Value();

  const PaDeviceInfo* devInfo = Pa_GetDeviceInfo(deviceId);
  if (!devInfo) {
    Napi::Error::New(env, "Invalid device id").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (inputChannels < 1 || inputChannels > devInfo->maxInputChannels) {
    Napi::Error::New(env, "inputChannels out of range for device")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (bufferSize != 64 && bufferSize != 128 && bufferSize != 256 && bufferSize != 512) {
    Napi::Error::New(env, "bufferSize must be one of 64 / 128 / 256 / 512")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Output mirrors input for monitoring. Cap at stereo: WASAPI Shared is
  // pinned to whatever Windows configured for the device (almost always
  // stereo), and opening with more channels than the shared-mode format
  // expects fails with paInvalidChannelCount. Devices with 1 output (rare)
  // get mono monitor. Devices with no outputs get capture-only.
  int outputChannels = std::min(devInfo->maxOutputChannels, 2);
  if (outputChannels < 0) outputChannels = 0;

  PaStreamParameters inputParams = {};
  inputParams.device                    = deviceId;
  inputParams.channelCount              = inputChannels;
  inputParams.sampleFormat              = paFloat32;
  inputParams.suggestedLatency          = devInfo->defaultLowInputLatency;
  inputParams.hostApiSpecificStreamInfo = nullptr;

  PaStreamParameters outputParams = {};
  PaWasapiStreamInfo wasapiInfo = {};
  const bool wasapiExclusive = (apiKind == "WASAPI_EXCLUSIVE");
  if (wasapiExclusive) {
    wasapiInfo.size         = sizeof(PaWasapiStreamInfo);
    wasapiInfo.hostApiType  = paWASAPI;
    wasapiInfo.version      = 1;
    wasapiInfo.flags        = paWinWasapiExclusive;
    inputParams.hostApiSpecificStreamInfo = &wasapiInfo;
  }

  PaStreamParameters* outputPtr = nullptr;
  if (outputChannels > 0) {
    outputParams.device                    = deviceId;
    outputParams.channelCount              = outputChannels;
    outputParams.sampleFormat              = paFloat32;
    outputParams.suggestedLatency          = devInfo->defaultLowOutputLatency;
    outputParams.hostApiSpecificStreamInfo = wasapiExclusive ? &wasapiInfo : nullptr;
    outputPtr = &outputParams;
  }

  // Publish channel counts with release semantics so the audio thread sees
  // them once Pa_StartStream's first callback fires.
  g_streamInputChannels.store(inputChannels, std::memory_order_release);
  g_streamOutputChannels.store(outputChannels, std::memory_order_release);
  g_monitorGain.store(0.0f, std::memory_order_relaxed);

  // TSFN must exist before Pa_StartStream — the very first callback may fire
  // immediately and try to enqueue PCM.
  Napi::Function onPcm = info[1].As<Napi::Function>();
  g_pcmTsfn = Napi::ThreadSafeFunction::New(env, onPcm, "kgb-pcm", /*queueSize*/ 64, /*initialThreadCount*/ 1);
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

// closeStream() — idempotent. Stops & closes the PA stream and releases the
// TSFN so any in-flight queued callbacks are drained on the JS thread.
Napi::Value CloseStream(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Mark the TSFN dead before stopping the stream so the audio callback
  // stops enqueueing new frames as soon as possible.
  const bool wasAlive = g_tsfnAlive.exchange(false, std::memory_order_acq_rel);

  if (g_stream) {
    Pa_StopStream(g_stream);
    Pa_CloseStream(g_stream);
    g_stream = nullptr;
  }
  g_streamInputChannels.store(0, std::memory_order_release);
  g_streamOutputChannels.store(0, std::memory_order_release);
  g_monitorGain.store(0.0f, std::memory_order_relaxed);

  if (wasAlive) {
    g_pcmTsfn.Release();
  }
  return env.Undefined();
}

// isStreamActive() → boolean. True only when the stream is open AND PortAudio
// reports it as actively running (Pa_IsStreamActive == 1).
Napi::Value IsStreamActive(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_stream) return Napi::Boolean::New(env, false);
  const int active = Pa_IsStreamActive(g_stream);
  return Napi::Boolean::New(env, active == 1);
}

// setMonitorGain(gain: number).
// Per A3 spec: 0.0 = off, 1.0 = unity. Linear amplitude, capped at +12 dB
// (4.0) to prevent runaway feedback if the user wires monitor into the same
// physical channel as the input.
Napi::Value SetMonitorGain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "setMonitorGain(gain: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  float gain = static_cast<float>(info[0].As<Napi::Number>().DoubleValue());
  if (!(gain >= 0.0f)) gain = 0.0f;  // also catches NaN
  if (gain > 4.0f)     gain = 4.0f;
  g_monitorGain.store(gain, std::memory_order_relaxed);
  return env.Undefined();
}

// getStreamLatency() → { inputLatency, outputLatency, sampleRate } (seconds).
// All zero when no stream is open.
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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("paInit",           Napi::Function::New(env, PaInit));
  exports.Set("paTerminate",      Napi::Function::New(env, PaTerminate));
  exports.Set("getDevices",       Napi::Function::New(env, GetDevices));
  exports.Set("openStream",       Napi::Function::New(env, OpenStream));
  exports.Set("closeStream",      Napi::Function::New(env, CloseStream));
  exports.Set("isStreamActive",   Napi::Function::New(env, IsStreamActive));
  exports.Set("setMonitorGain",   Napi::Function::New(env, SetMonitorGain));
  exports.Set("getStreamLatency", Napi::Function::New(env, GetStreamLatency));
  return exports;
}

NODE_API_MODULE(portaudio_addon, Init)
