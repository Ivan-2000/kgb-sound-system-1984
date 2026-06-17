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

// V3: one automatable parameter exposed by a plugin's edit controller.
struct ParamDesc {
  uint32_t id = 0;            // ParamID (stable across sessions for a given plugin)
  std::string title;
  std::string units;
  double defaultNormalized = 0.0;
  int32_t stepCount = 0;      // 0 = continuous, >0 = discrete (e.g. 1 = on/off)
  int32_t flags = 0;          // raw Vst::ParameterInfo flags
};

// V3: result of loading a plugin into a runtime slot.
struct LoadResult {
  bool ok = false;
  std::string error;
  int slotId = -1;
  std::string name;
  std::string vendor;
  std::string type;            // "effect" | "instrument" | "other"
  std::string uid;
  int numInputChannels = 0;    // main audio input bus channel count
  int numOutputChannels = 0;   // main audio output bus channel count
  std::vector<ParamDesc> params;
};

// V1 spike: load a .vst3, enumerate its factory classes, unload. Proves the SDK
// compiles+links+runs under MinGW on a real plugin.
ProbeResult probe(const std::string& path);

// V2: enumerate every plugin class found under `paths` (recursively). When
// `paths` is empty the OS default VST3 search paths are used.
std::vector<ClassDesc> scan(const std::vector<std::string>& paths);

// V2: standard VST3 module search paths for the current OS (the SDK's own list).
std::vector<std::string> defaultSearchPaths();

// Maximum simultaneous loaded plugin instances across all insert chains.
static constexpr int kMaxSlots = 64;

// V3: load `classUid` (32-char hex; empty = first audio-module class in the
// module) from the .vst3 at `path` into `slotId` (0..kMaxSlots-1; -1 = first
// free). Sets up 32-bit realtime processing at `sampleRate`/`maxBlockSize` and
// activates the plugin. Runs on the JS thread; never call from the RT callback.
LoadResult loadPlugin(const std::string& path, const std::string& classUid,
                      double sampleRate, int maxBlockSize, int slotId);

// V3: deactivate + free the plugin in `slotId`. Safe to call when the slot is
// empty. Must run on the JS thread while the slot is not being processed.
bool unloadPlugin(int slotId);

// V3: parameter get/set, normalized [0,1]. JS-thread only.
bool setParamNormalized(int slotId, uint32_t paramId, double valueNormalized);
double getParamNormalized(int slotId, uint32_t paramId);

// RT-safe: process the ordered insert chain `slotIds[0..count)` over interleaved
// float audio in place. `numFrames` must be <= the maxBlockSize the slots were
// loaded with. Empty chain (count == 0) is a no-op passthrough. Only touches the
// lock-free slot table; never allocates or locks. Call from the audio callback.
void processChain(const int* slotIds, int count,
                  float* interleaved, int numChannels, int numFrames);

// Unload everything and drop the shared host context. JS-thread only.
void shutdown();

}  // namespace vst
}  // namespace kgb

#endif  // KGB_WITH_VST
