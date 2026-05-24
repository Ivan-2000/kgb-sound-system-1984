#include <napi.h>
#include <portaudio.h>
#include <pa_win_wasapi.h>
#include <string>
#include <cstring>

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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("paInit",      Napi::Function::New(env, PaInit));
  exports.Set("paTerminate", Napi::Function::New(env, PaTerminate));
  exports.Set("getDevices",  Napi::Function::New(env, GetDevices));
  return exports;
}

NODE_API_MODULE(portaudio_addon, Init)
