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
  std::string path;         // module path (set by scan(); empty for probe())
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

// V4 spike: open the plugin's own editor (IPlugView) in a native OS window
// (Windows: a top-level HWND). Returns false if the plugin is headless (no
// editor view) or the platform view type is unsupported. JS-thread only.
// NOTE: an interactive editor needs a Win32 message pump; see runEditorPump().
bool openEditor(int slotId);
void closeEditor(int slotId);
bool hasEditor(int slotId);

// V4 spike helper: pump the editor window's Win32 messages for `ms`
// milliseconds (blocking). Stand-in for the utility event-loop integration that
// V4 proper will wire — proves the editor renders and is interactive.
void runEditorPump(int ms);

// V4: drain all pending Win32 messages once, non-blocking. Call on a timer from
// the utility's Node loop (same thread that opened the editor) to keep the
// editor responsive without blocking IPC.
void pumpEditorMessages();

// RT block management — call beginRtBlock() before the FIRST processChain() call
// in a PaCallback, and endRtBlock(numFrames) after the LAST. Consolidates the
// per-callback generation bump and g_rtInChain flag to a single pair of atomic
// ops per audio callback instead of one pair per processChain() invocation.
// Bug #3: reduces LOCK XADD pressure on ASIO/WASAPI RT thread.
void beginRtBlock();
void endRtBlock(int numFrames);

// RT-safe: process the ordered insert chain `slotIds[0..count)` over interleaved
// float audio in place. `numFrames` must be <= the maxBlockSize the slots were
// loaded with. Empty chain (count == 0) is a no-op passthrough. Only touches the
// lock-free slot table; never allocates or locks. Call from the audio callback.
// Must be called between beginRtBlock() and endRtBlock().
void processChain(const int* slotIds, int count,
                  float* interleaved, int numChannels, int numFrames);

// V9: binary preset state — project save/load. JS-thread only.
// getPluginState writes IComponent::getState() output to `out`; returns false if
// the slot is empty or the plugin returns an error.
// setPluginState feeds `data` back via IComponent::setState(); returns false on error.
bool getPluginState(int slotId, std::vector<uint8_t>& out);
bool setPluginState(int slotId, const std::vector<uint8_t>& data);

// I3: queue a MIDI Note On/Off event to be delivered to the VSTi at the start
// of the next RT process block. Lock-free (SPSC: JS thread → RT).
// pitch = MIDI note 0-127, velocity = 0-127 (noteOn), channel = 0-15.
bool noteOn(int slotId, int channel, int pitch, int velocity);
bool noteOff(int slotId, int channel, int pitch);

// PDC: return IAudioProcessor::getLatencySamples() for the plugin in `slotId`.
// Returns 0 if the slot is empty, inactive, or the plugin reports no latency.
// JS-thread only (no RT-callback safety concerns — reads the slot pointer under
// a brief acquire load; processChain never writes g_slots).
int32_t getPluginLatencySamples(int slotId);

// I1: per-track VST insert chain (I1/E4). Stores ordered slotIds for a logical
// track ID. During live playback the RT callback does not intercept Tone.js
// audio; this call registers the chain for use by the offline mixdown (E4 T3).
// trackId is an arbitrary integer handle (JS assigns). JS-thread only.
bool setTrackChain(int trackId, const int* slotIds, int count);
// Retrieve the chain for a given trackId (copy into slotIds/count). Returns false if empty.
bool getTrackChain(int trackId, int* slotIds, int& count, int maxSlots);

// Unload everything and drop the shared host context. JS-thread only.
void shutdown();

}  // namespace vst
}  // namespace kgb

#endif  // KGB_WITH_VST
