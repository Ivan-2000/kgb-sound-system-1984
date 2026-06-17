// VST3 host glue for KGB Sound System 85 (E1 / V1–V3).
//
// Thin C++ facade over the Steinberg VST3 SDK hosting helpers
// (VST3::Hosting::Module). addon.cc talks only to this header so the napi layer
// never sees SDK types. Everything here is compiled only when KGB_WITH_VST=1.
//
// Threading: probe()/scan()/loadPlugin()/unloadPlugin() run on the utility JS
// thread. The RT audio callback only ever touches the lock-free slot table via
// processSlot() (added in V1-skeleton). See vstHost.cc for the memory model.
#pragma once

#ifdef KGB_WITH_VST

#include <cstdint>
#include <string>
#include <vector>

namespace kgb {
namespace vst {

// One instantiable class inside a .vst3 module (usually one Audio Module Class).
struct ClassDesc {
  std::string name;
  std::string vendor;
  std::string version;
  std::string category;     // raw SDK category, e.g. "Audio Module Class"
  std::string type;         // normalized: "effect" | "instrument" | "other"
  std::string subCategories; // e.g. "Fx|Reverb" or "Instrument|Synth"
  std::string uid;          // 32-char hex of the class UID (stable identity)
};

// Result of loading a single module and enumerating its factory.
struct ProbeResult {
  bool ok = false;
  std::string error;
  std::string path;
  std::string moduleName;
  std::string factoryVendor;
  std::vector<ClassDesc> classes;
};

// V1 spike: load a .vst3, enumerate its factory classes, unload. Proves the SDK
// compiles+links+runs under MinGW on a real plugin.
ProbeResult probe(const std::string& path);

// V2: standard VST3 module search paths for the current OS (the SDK's own list).
std::vector<std::string> defaultSearchPaths();

}  // namespace vst
}  // namespace kgb

#endif  // KGB_WITH_VST
