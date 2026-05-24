#include <napi.h>
#include <portaudio.h>
#include <pa_win_wasapi.h>
#include <string>
#include <cstring>

// Maps PaHostApiTypeId to the string kind defined in ADR-001 §3.3
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

// Builds a JS { kind, name } object for a host API
static Napi::Object makeHostApiObj(Napi::Env env, const char* kind, const char* name) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("kind", Napi::String::New(env, kind));
  o.Set("name", Napi::String::New(env, name ? name : kind));
  return o;
}

// getDevices() → Array<{ id, name, hostApis, inputChannels, outputChannels, defaultSampleRate }>
//
// Calls Pa_Initialize / Pa_Terminate on every invocation so main.js can call
// it at startup without keeping PortAudio alive for the whole session.
// Once the stream engine (A3) opens a persistent stream, this will be replaced
// by a stateful version that reuses the already-initialized PA context.
Napi::Value GetDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  PaError err = Pa_Initialize();
  if (err != paNoError) {
    Napi::Error::New(env, std::string("Pa_Initialize: ") + Pa_GetErrorText(err))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  int deviceCount = Pa_GetDeviceCount();
  if (deviceCount < 0) {
    Pa_Terminate();
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

    // Primary host API for this device
    const char* kind = hostApiKind(apiInfo->type);
    hostApis.Set(haIdx++, makeHostApiObj(env, kind, apiInfo->name));

    // WASAPI devices also support Exclusive mode as a distinct operating mode.
    // Expose it as a separate entry so the UI can offer the choice (ADR §3.3).
    if (apiInfo->type == paWASAPI) {
      hostApis.Set(haIdx++, makeHostApiObj(env, "WASAPI_EXCLUSIVE", "WASAPI Exclusive"));
    }

    Napi::Object device = Napi::Object::New(env);
    device.Set("id",                Napi::Number::New(env, i));
    device.Set("name",              Napi::String::New(env, dev->name ? dev->name : ""));
    device.Set("hostApis",          hostApis);
    device.Set("inputChannels",     Napi::Number::New(env, dev->maxInputChannels));
    device.Set("outputChannels",    Napi::Number::New(env, dev->maxOutputChannels));
    device.Set("defaultSampleRate", Napi::Number::New(env, dev->defaultSampleRate));

    result.Set(idx++, device);
  }

  Pa_Terminate();
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getDevices", Napi::Function::New(env, GetDevices));
  return exports;
}

NODE_API_MODULE(portaudio_addon, Init)
