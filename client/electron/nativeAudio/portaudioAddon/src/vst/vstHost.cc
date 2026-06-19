// VST3 host glue — implementation. Compiled only when KGB_WITH_VST=1.
//
// Lives in the same utility process as PortAudio (ADR §6 variant A). The JS
// thread loads/unloads plugins and edits parameters; the RT audio callback only
// calls processChain(), which walks a lock-free slot table. A plugin crash takes
// down this utility process — main observes the non-zero exit, emits
// `audio:engine-crashed`, and lazily respawns (ipc.js / A3.5c). No special crash
// handling is needed here: that is the whole point of hosting in the utility.
#ifdef KGB_WITH_VST

#include "vst/vstHost.h"

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"

#include <atomic>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>    // SHGetKnownFolderPath, FOLDERID_*, CoTaskMemFree
#endif
#include <algorithm>   // std::find

using namespace Steinberg;

namespace kgb {
namespace vst {

namespace {

// ── Shared host context ──────────────────────────────────────────────────────
// One HostApplication for the whole process. Created lazily on first load,
// passed to every component/controller as its host context. Guarded by
// g_loadMutex (JS-thread only — never touched by the RT callback).
IPtr<Vst::HostApplication> g_hostContext;
std::mutex g_loadMutex;

Vst::HostApplication* hostContext() {
  if (!g_hostContext)
    g_hostContext = owned(new Vst::HostApplication());
  return g_hostContext;
}

std::string uidToHex(const VST3::UID& uid) {
  const Steinberg::TUID& d = uid.data();  // char[16]
  static const char* kHex = "0123456789ABCDEF";
  std::string out;
  out.reserve(32);
  for (size_t i = 0; i < sizeof(Steinberg::TUID); ++i) {
    out.push_back(kHex[(static_cast<uint8_t>(d[i]) >> 4) & 0xF]);
    out.push_back(kHex[static_cast<uint8_t>(d[i]) & 0xF]);
  }
  return out;
}

std::string classifyType(const std::string& category,
                         const VST3::Hosting::ClassInfo::SubCategories& subs) {
  if (category != kVstAudioEffectClass) return "other";
  for (const auto& s : subs)
    if (s == "Instrument") return "instrument";
  return "effect";
}

// ── One loaded plugin instance ───────────────────────────────────────────────
// Allocated and torn down on the JS thread. The RT callback reads it through an
// atomic slot pointer and calls processor->process() — every buffer it touches
// (HostProcessData, param/event lists) is pre-allocated here at load time, so
// the RT path never allocates.
constexpr int kParamRingSize = 256;  // power of two
constexpr int kMidiRingSize  = 128;  // power of two; enough for dense poly playback

struct ParamSet {
  Vst::ParamID id;
  double value;
};

// I3: compact MIDI event for the lock-free ring (JS thread → RT).
struct MidiEvt {
  uint8_t type;      // 0 = noteOn, 1 = noteOff
  uint8_t channel;   // 0-15
  uint8_t pitch;     // 0-127
  uint8_t velocity;  // 0-127 (noteOn only; noteOff always 0)
};

struct PluginSlot {
  VST3::Hosting::Module::Ptr module;
  IPtr<Vst::IComponent> component;
  IPtr<Vst::IAudioProcessor> processor;
  IPtr<Vst::IEditController> controller;
  IPtr<IPlugView> view;       // V4: editor view, when open
  void* editorHwnd = nullptr; // HWND of the host window holding the view
  bool controllerIsSeparate = false;
  // Only call terminate() on interfaces whose initialize() actually succeeded —
  // terminating after a failed init is undefined for some plugins.
  bool componentInitialized = false;
  bool controllerInitialized = false;

  Vst::HostProcessData processData;
  Vst::ParameterChanges inputParamChanges;
  Vst::ParameterChanges outputParamChanges;
  Vst::EventList eventList;
  Vst::ProcessContext processContext{};

  int maxBlock = 0;
  double sampleRate = 0.0;
  int numInCh = 0;
  int numOutCh = 0;

  std::atomic<bool> bypass{false};

  // SPSC ring: JS thread pushes parameter edits, RT thread drains them into
  // inputParamChanges before process(). Lock-free, no allocation on either side.
  ParamSet paramRing[kParamRingSize];
  std::atomic<uint32_t> paramWpos{0};
  std::atomic<uint32_t> paramRpos{0};

  // I3 SPSC ring: JS thread queues noteOn/noteOff, RT drains into eventList
  // before process(). Capacity covers dense chords; overflow drops silently.
  MidiEvt midiRing[kMidiRingSize];
  std::atomic<uint32_t> midiWpos{0};
  std::atomic<uint32_t> midiRpos{0};

  ~PluginSlot() {
    if (view) {
      view->setFrame(nullptr);
      view->removed();
      view = nullptr;
    }
#ifdef _WIN32
    if (editorHwnd) { DestroyWindow(static_cast<HWND>(editorHwnd)); editorHwnd = nullptr; }
#endif
    if (processor) processor->setProcessing(false);
    if (component) {
      component->setActive(false);
      if (componentInitialized) component->terminate();
    }
    if (controllerIsSeparate && controller && controllerInitialized)
      controller->terminate();
    processData.unprepare();
    // Drop interface refs before the module unloads its library.
    controller = nullptr;
    processor = nullptr;
    component = nullptr;
    module = nullptr;
  }
};

// ── Lock-free slot table ─────────────────────────────────────────────────────
// Published with release / read with acquire. unloadPlugin() stores null then
// waits for the RT thread to pass a buffer boundary before deleting (see below).
std::atomic<PluginSlot*> g_slots[kMaxSlots] = {};
// Bumped once per PaCallback via beginRtBlock(); lets unloadPlugin know a full
// RT callback has elapsed since it nulled a slot (so no in-flight callback
// still holds the pointer). Bug #3: was bumped per processChain() call —
// with N per-channel chains that was N+1 LOCK XADD ops per callback.
std::atomic<uint64_t> g_rtGeneration{0};
// Set true while inside the RT chain (beginRtBlock → endRtBlock); false otherwise.
std::atomic<bool> g_rtInChain{false};

// Bug #3: monotonic RT sample counter (RT thread only — no atomic needed).
// g_rtBlockStart is captured at beginRtBlock() and written to each slot's
// processContext before process(), so plugins see a steadily advancing
// projectTimeSamples instead of a stuck 0 that triggers expensive re-init.
static int64_t g_rtTotalSamples = 0;
static int64_t g_rtBlockStart   = 0;

// Pull every audio bus the component exposes active, so plugins that gate output
// on bus activation actually produce sound.
void activateAllAudioBuses(Vst::IComponent* component, bool state) {
  for (int dir = 0; dir <= 1; ++dir) {
    auto busDir = dir == 0 ? Vst::kInput : Vst::kOutput;
    int32 count = component->getBusCount(Vst::kAudio, busDir);
    for (int32 i = 0; i < count; ++i)
      component->activateBus(Vst::kAudio, busDir, i, state);
  }
}

int mainBusChannelCount(Vst::IComponent* component, Vst::BusDirection dir) {
  if (component->getBusCount(Vst::kAudio, dir) <= 0) return 0;
  Vst::BusInfo info{};
  if (component->getBusInfo(Vst::kAudio, dir, 0, info) != kResultOk) return 0;
  return info.channelCount;
}

}  // namespace

// ── Probe / scan (V1 spike + V2) ─────────────────────────────────────────────

ProbeResult probe(const std::string& path) {
  ProbeResult result;
  result.path = path;

  std::string error;
  auto module = VST3::Hosting::Module::create(path, error);
  if (!module) {
    result.ok = false;
    result.error = error.empty() ? "Module::create failed" : error;
    return result;
  }

  result.moduleName = module->getName();
  const auto& factory = module->getFactory();
  result.factoryVendor = factory.info().vendor();

  for (const auto& ci : factory.classInfos()) {
    ClassDesc d;
    d.name = ci.name();
    d.vendor = ci.vendor();
    d.version = ci.version();
    d.category = ci.category();
    d.subCategories = ci.subCategoriesString();
    d.type = classifyType(ci.category(), ci.subCategories());
    d.uid = uidToHex(ci.ID());
    result.classes.push_back(std::move(d));
  }

  result.ok = true;
  return result;  // module unloads here — probe is non-residential
}

std::vector<ClassDesc> scan(const std::vector<std::string>& paths) {
  namespace fs = std::filesystem;
  std::vector<ClassDesc> out;

  // Always start from the OS default paths so every installed plugin is found.
  // Any caller-supplied paths are appended as extra search roots (deduplicated).
  // This means passing extra directories from the UI adds to — not replaces —
  // the standard search locations.
  std::vector<std::string> roots = defaultSearchPaths();
  for (const auto& p : paths) {
    if (std::find(roots.begin(), roots.end(), p) == roots.end())
      roots.push_back(p);
  }
  std::vector<std::string> modules;

  for (const auto& root : roots) {
    std::error_code ec;
    fs::path p(root);
    if (!fs::exists(p, ec)) continue;
    if (fs::is_directory(p, ec)) {
      // .vst3 can be a bundle directory or a file; recursive_directory_iterator
      // descends into bundles too, so only collect top-level *.vst3 entries.
      for (fs::recursive_directory_iterator it(p, fs::directory_options::skip_permission_denied, ec), end;
           it != end; it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        if (it->path().extension() == ".vst3") {
          modules.push_back(it->path().string());
          it.disable_recursion_pending();  // do not descend into the bundle
        }
      }
    } else if (p.extension() == ".vst3") {
      modules.push_back(p.string());
    }
  }

  for (const auto& m : modules) {
    ProbeResult pr = probe(m);
    if (!pr.ok) continue;
    for (auto& c : pr.classes) {
      // Only surface real audio modules (effects + instruments), not the
      // companion edit-controller classes ("other").
      if (c.type == "effect" || c.type == "instrument") {
        c.path = m;
        out.push_back(std::move(c));
      }
    }
  }
  return out;
}

std::vector<std::string> defaultSearchPaths() {
  // Start with the SDK's own list (covers the three main standard directories:
  //   C:\Program Files\Common Files\VST3
  //   C:\Program Files (x86)\Common Files\VST3
  //   %USERPROFILE%\Documents\VST3
  std::vector<std::string> paths = VST3::Hosting::Module::getModulePaths();

#ifdef _WIN32
  namespace fs = std::filesystem;

  // Helper: append a KNOWNFOLDERID-derived path if not already present.
  auto addKnownFolder = [&](REFKNOWNFOLDERID fid, const wchar_t* suffix) {
    PWSTR w = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(fid, KF_FLAG_DEFAULT, nullptr, &w))) {
      std::string s = (fs::path(w) / suffix).string();
      CoTaskMemFree(w);
      if (!s.empty() && std::find(paths.begin(), paths.end(), s) == paths.end())
        paths.push_back(std::move(s));
    }
  };

  // Additional standard user-level VST3 directories the SDK may omit.
  addKnownFolder(FOLDERID_RoamingAppData, L"VST3");               // %APPDATA%\VST3
  addKnownFolder(FOLDERID_LocalAppData,   L"Programs\\Common\\VST3"); // %LOCALAPPDATA%\...

  // Registry-based paths.  The VST3 spec allows plugin installers to register
  // custom install directories under HKLM\SOFTWARE\VST3 and HKCU\SOFTWARE\VST3
  // as named REG_SZ / REG_EXPAND_SZ values.  Without this, plugins installed
  // outside the three standard directories are invisible to the scanner.
  auto readRegKey = [&](HKEY hive, LPCWSTR subKey) {
    HKEY hk = nullptr;
    REGSAM access = KEY_QUERY_VALUE | KEY_WOW64_64KEY;
    if (RegOpenKeyExW(hive, subKey, 0, access, &hk) != ERROR_SUCCESS) return;

    DWORD nVals = 0, maxNameLen = 0, maxDataLen = 0;
    if (RegQueryInfoKeyW(hk, nullptr, nullptr, nullptr, nullptr, nullptr,
                         nullptr, &nVals, &maxNameLen, &maxDataLen,
                         nullptr, nullptr) != ERROR_SUCCESS) {
      RegCloseKey(hk); return;
    }

    std::wstring nameBuf(maxNameLen + 1, L'\0');
    std::vector<BYTE> dataBuf(maxDataLen + sizeof(wchar_t));

    for (DWORD i = 0; i < nVals; ++i) {
      DWORD nameLen = static_cast<DWORD>(nameBuf.size());
      DWORD dataLen = static_cast<DWORD>(dataBuf.size());
      DWORD type = 0;
      std::fill(dataBuf.begin(), dataBuf.end(), 0);
      if (RegEnumValueW(hk, i, nameBuf.data(), &nameLen, nullptr,
                        &type, dataBuf.data(), &dataLen) != ERROR_SUCCESS)
        continue;
      if (type != REG_SZ && type != REG_EXPAND_SZ) continue;

      // Raw wchar_t string from registry.
      const wchar_t* raw = reinterpret_cast<const wchar_t*>(dataBuf.data());
      std::wstring expanded(MAX_PATH * 4, L'\0');
      DWORD expLen = ExpandEnvironmentStringsW(
          raw, expanded.data(), static_cast<DWORD>(expanded.size()));
      if (expLen > 1 && expLen <= static_cast<DWORD>(expanded.size()))
        expanded.resize(expLen - 1);   // expLen includes null terminator
      else
        expanded = raw;

      std::string s = fs::path(expanded).string();
      if (!s.empty() && std::find(paths.begin(), paths.end(), s) == paths.end())
        paths.push_back(std::move(s));
    }
    RegCloseKey(hk);
  };

  readRegKey(HKEY_LOCAL_MACHINE, L"SOFTWARE\\VST3");
  readRegKey(HKEY_CURRENT_USER,  L"SOFTWARE\\VST3");
#endif

  return paths;
}

// ── Load / unload (V3) ───────────────────────────────────────────────────────

LoadResult loadPlugin(const std::string& path, const std::string& classUid,
                      double sampleRate, int maxBlockSize, int slotId) {
  std::lock_guard<std::mutex> lock(g_loadMutex);
  LoadResult r;

  if (slotId < -1 || slotId >= kMaxSlots) { r.error = "slotId out of range"; return r; }
  if (sampleRate <= 0 || maxBlockSize <= 0) { r.error = "invalid sampleRate/blockSize"; return r; }

  // Pick a free slot if -1.
  if (slotId == -1) {
    for (int i = 0; i < kMaxSlots; ++i)
      if (!g_slots[i].load(std::memory_order_acquire)) { slotId = i; break; }
    if (slotId == -1) { r.error = "no free slot"; return r; }
  } else if (g_slots[slotId].load(std::memory_order_acquire)) {
    r.error = "slot occupied — unload first";
    return r;
  }

  std::string err;
  auto module = VST3::Hosting::Module::create(path, err);
  if (!module) { r.error = err.empty() ? "Module::create failed" : err; return r; }

  const auto& factory = module->getFactory();

  // Locate the requested class (or the first audio-module class). Copy it out
  // by value — `infos` is a local that outlives the search, but a value keeps
  // the chosen descriptor independent of it.
  VST3::Hosting::ClassInfo chosen;
  bool found = false;
  for (const auto& ci : factory.classInfos()) {
    if (ci.category() != kVstAudioEffectClass) continue;
    if (classUid.empty() || uidToHex(ci.ID()) == classUid) {
      chosen = ci;
      found = true;
      break;
    }
  }
  if (!found) { r.error = "audio module class not found in module"; return r; }

  auto slot = std::make_unique<PluginSlot>();
  slot->module = module;

  slot->component = factory.createInstance<Vst::IComponent>(chosen.ID());
  if (!slot->component) { r.error = "createInstance(IComponent) failed"; return r; }
  if (slot->component->initialize(hostContext()) != kResultOk) {
    r.error = "component->initialize failed"; return r;
  }
  slot->componentInitialized = true;

  slot->processor = FUnknownPtr<Vst::IAudioProcessor>(slot->component);
  if (!slot->processor) { r.error = "plugin has no IAudioProcessor"; return r; }
  if (slot->processor->canProcessSampleSize(Vst::kSample32) != kResultTrue) {
    r.error = "plugin cannot process 32-bit float"; return r;
  }

  // Controller: single-component plugins implement IEditController directly;
  // otherwise instantiate the controller class the component names.
  slot->controller = FUnknownPtr<Vst::IEditController>(slot->component);
  if (!slot->controller) {
    Steinberg::TUID cid;
    if (slot->component->getControllerClassId(cid) == kResultOk) {
      slot->controller = factory.createInstance<Vst::IEditController>(VST3::UID(cid));
      if (slot->controller) {
        slot->controllerIsSeparate = true;
        if (slot->controller->initialize(hostContext()) == kResultOk)
          slot->controllerInitialized = true;
        // (component↔controller IConnectionPoint wiring is added in E2 for
        // editor/parameter round-tripping; not required to process audio.)
      }
    }
  }

  // Bus arrangements: request stereo in/out on the main buses where present.
  slot->numInCh = mainBusChannelCount(slot->component, Vst::kInput);
  slot->numOutCh = mainBusChannelCount(slot->component, Vst::kOutput);
  {
    Vst::SpeakerArrangement in = Vst::SpeakerArr::kStereo;
    Vst::SpeakerArrangement out = Vst::SpeakerArr::kStereo;
    slot->processor->setBusArrangements(
        slot->numInCh > 0 ? &in : nullptr, slot->numInCh > 0 ? 1 : 0,
        slot->numOutCh > 0 ? &out : nullptr, slot->numOutCh > 0 ? 1 : 0);
    // Re-read in case the plugin adjusted the arrangement it accepted.
    slot->numInCh = mainBusChannelCount(slot->component, Vst::kInput);
    slot->numOutCh = mainBusChannelCount(slot->component, Vst::kOutput);
  }

  // Processing setup + buffer allocation (HostProcessData owns the buffers).
  Vst::ProcessSetup setup{Vst::kRealtime, Vst::kSample32,
                          static_cast<int32>(maxBlockSize),
                          static_cast<Vst::SampleRate>(sampleRate)};
  if (slot->processor->setupProcessing(setup) != kResultOk) {
    r.error = "setupProcessing failed"; return r;
  }
  slot->processData.prepare(*slot->component, maxBlockSize, Vst::kSample32);
  slot->processData.inputEvents = &slot->eventList;
  slot->processData.inputParameterChanges = &slot->inputParamChanges;
  slot->processData.outputParameterChanges = &slot->outputParamChanges;
  slot->processContext.sampleRate = sampleRate;
  slot->processContext.tempo = 120.0;
  slot->processData.processContext = &slot->processContext;
  slot->maxBlock = maxBlockSize;
  slot->sampleRate = sampleRate;

  activateAllAudioBuses(slot->component, true);
  if (slot->component->setActive(true) != kResultOk) {
    r.error = "component->setActive failed"; return r;
  }
  slot->processor->setProcessing(true);

  // Parameter descriptors (from the controller, if any).
  if (slot->controller) {
    int32 count = slot->controller->getParameterCount();
    r.params.reserve(count);
    for (int32 i = 0; i < count; ++i) {
      Vst::ParameterInfo pi{};
      if (slot->controller->getParameterInfo(i, pi) != kResultOk) continue;
      ParamDesc pd;
      pd.id = pi.id;
      pd.title = Vst::StringConvert::convert(pi.title);
      pd.units = Vst::StringConvert::convert(pi.units);
      pd.defaultNormalized = pi.defaultNormalizedValue;
      pd.stepCount = pi.stepCount;
      pd.flags = pi.flags;
      r.params.push_back(std::move(pd));
    }
  }

  // Descriptor for the caller.
  r.ok = true;
  r.slotId = slotId;
  r.name = chosen.name();
  r.vendor = chosen.vendor();
  r.type = classifyType(chosen.category(), chosen.subCategories());
  r.uid = uidToHex(chosen.ID());
  r.numInputChannels = slot->numInCh;
  r.numOutputChannels = slot->numOutCh;

  // Publish last — once stored, the RT callback may pick it up immediately.
  g_slots[slotId].store(slot.release(), std::memory_order_release);
  return r;
}

bool unloadPlugin(int slotId) {
  std::lock_guard<std::mutex> lock(g_loadMutex);
  if (slotId < 0 || slotId >= kMaxSlots) return false;

  PluginSlot* slot = g_slots[slotId].exchange(nullptr, std::memory_order_acq_rel);
  if (!slot) return true;  // already empty

  // Reclaim safely: the RT callback reads the slot pointer once per process()
  // and clears g_rtInChain when done. Wait until we observe the chain idle AND
  // a generation boundary has passed since we nulled the slot, so no in-flight
  // callback still holds `slot`. Bounded — if the stream is stopped the
  // generation never advances, so fall back to the timeout (safe: no RT reader).
  const uint64_t gen0 = g_rtGeneration.load(std::memory_order_acquire);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(100);
  while (std::chrono::steady_clock::now() < deadline) {
    const bool boundaryPassed = g_rtGeneration.load(std::memory_order_acquire) > gen0 + 1;
    const bool idle = !g_rtInChain.load(std::memory_order_acquire);
    if (boundaryPassed && idle) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  delete slot;  // ~PluginSlot deactivates + releases the plugin
  return true;
}

bool setParamNormalized(int slotId, uint32_t paramId, double valueNormalized) {
  if (slotId < 0 || slotId >= kMaxSlots) return false;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot) return false;

  if (valueNormalized < 0.0) valueNormalized = 0.0;
  if (valueNormalized > 1.0) valueNormalized = 1.0;

  // Update controller state (for editor + getParam reads)...
  if (slot->controller)
    slot->controller->setParamNormalized(paramId, valueNormalized);

  // ...and enqueue for the processor (drained in processChain before process()).
  const uint32_t w = slot->paramWpos.load(std::memory_order_relaxed);
  const uint32_t r = slot->paramRpos.load(std::memory_order_acquire);
  if (w - r >= kParamRingSize) return true;  // ring full — drop (rare)
  slot->paramRing[w & (kParamRingSize - 1)] = {paramId, valueNormalized};
  slot->paramWpos.store(w + 1, std::memory_order_release);
  return true;
}

double getParamNormalized(int slotId, uint32_t paramId) {
  if (slotId < 0 || slotId >= kMaxSlots) return 0.0;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot || !slot->controller) return 0.0;
  return slot->controller->getParamNormalized(paramId);
}

// ── RT processing ────────────────────────────────────────────────────────────

void processChain(const int* slotIds, int count,
                  float* interleaved, int numChannels, int numFrames) {
  // Bug #3: generation bump and g_rtInChain management moved to
  // beginRtBlock() / endRtBlock() — called once per PaCallback, not once
  // per processChain() invocation. This removes N extra LOCK XADD ops per
  // callback when N per-channel chains are active.
  if (count <= 0 || !interleaved || numChannels <= 0 || numFrames <= 0) return;

  for (int s = 0; s < count; ++s) {
    const int id = slotIds[s];
    if (id < 0 || id >= kMaxSlots) continue;
    PluginSlot* slot = g_slots[id].load(std::memory_order_acquire);
    if (!slot) continue;
    if (slot->bypass.load(std::memory_order_relaxed)) continue;
    if (numFrames > slot->maxBlock) continue;  // never overrun pre-alloc buffers

    Vst::HostProcessData& pd = slot->processData;
    if (pd.numInputs <= 0 || pd.numOutputs <= 0) continue;

    const int inCh = pd.inputs[0].numChannels;
    const int outCh = pd.outputs[0].numChannels;

    // Drain queued parameter edits into this block's input changes.
    slot->inputParamChanges.clearQueue();
    {
      uint32_t r = slot->paramRpos.load(std::memory_order_relaxed);
      const uint32_t w = slot->paramWpos.load(std::memory_order_acquire);
      for (; r != w; ++r) {
        const ParamSet& ps = slot->paramRing[r & (kParamRingSize - 1)];
        int32 idx = 0;
        if (auto* q = slot->inputParamChanges.addParameterData(ps.id, idx))
          q->addPoint(0, ps.value, idx);
      }
      slot->paramRpos.store(w, std::memory_order_release);
    }

    // I3: drain MIDI events into the event list for this block.
    // eventList was cleared at the end of the previous block (see below).
    {
      uint32_t mr = slot->midiRpos.load(std::memory_order_relaxed);
      const uint32_t mw = slot->midiWpos.load(std::memory_order_acquire);
      for (; mr != mw; ++mr) {
        const MidiEvt& me = slot->midiRing[mr & (kMidiRingSize - 1)];
        Vst::Event e{};
        e.sampleOffset = 0;
        e.ppqPosition  = 0;
        e.flags        = Vst::Event::kIsLive;
        if (me.type == 0) {
          e.type = Vst::Event::kNoteOnEvent;
          e.noteOn.channel  = me.channel;
          e.noteOn.pitch    = me.pitch;
          e.noteOn.velocity = me.velocity / 127.0f;
          e.noteOn.length   = 0;
          e.noteOn.tuning   = 0.0f;
          e.noteOn.noteId   = -1;
        } else {
          e.type = Vst::Event::kNoteOffEvent;
          e.noteOff.channel  = me.channel;
          e.noteOff.pitch    = me.pitch;
          e.noteOff.velocity = 0.0f;
          e.noteOff.noteId   = -1;
          e.noteOff.tuning   = 0.0f;
        }
        slot->eventList.addEvent(e);
      }
      slot->midiRpos.store(mw, std::memory_order_release);
    }

    // De-interleave stream audio into the plugin's input channel buffers.
    for (int c = 0; c < inCh; ++c) {
      float* dst = pd.inputs[0].channelBuffers32[c];
      if (!dst) continue;
      const int src = c < numChannels ? c : numChannels - 1;  // dup last if fewer
      for (int f = 0; f < numFrames; ++f)
        dst[f] = interleaved[f * numChannels + src];
    }

    pd.numSamples = numFrames;
    pd.symbolicSampleSize = Vst::kSample32;
    pd.processMode = Vst::kRealtime;

    // Bug #3: advance the plugin's time cursor so it sees a monotonically
    // increasing projectTimeSamples instead of a stuck 0.  A stuck value
    // causes many plugins (reverbs, synths, modulators) to detect a time
    // discontinuity and re-initialize their internal state every block,
    // producing clicks and high CPU load.
    slot->processContext.projectTimeSamples  = g_rtBlockStart;
    slot->processContext.continousTimeSamples = static_cast<double>(g_rtBlockStart);
    slot->processContext.state = Vst::ProcessContext::kPlaying
                               | Vst::ProcessContext::kContTimeValid
                               | Vst::ProcessContext::kTempoValid;

    if (slot->processor->process(pd) != kResultOk) continue;

    // Re-interleave the plugin output back over the stream buffer.
    for (int c = 0; c < numChannels; ++c) {
      const int sc = c < outCh ? c : outCh - 1;
      const float* srcBuf = pd.outputs[0].channelBuffers32[sc];
      if (!srcBuf) continue;
      for (int f = 0; f < numFrames; ++f)
        interleaved[f * numChannels + c] = srcBuf[f];
    }

    slot->eventList.clear();
    slot->outputParamChanges.clearQueue();
  }
}

// ── RT block management (Bug #3) ─────────────────────────────────────────────
// Call beginRtBlock() once before all processChain() calls in a PaCallback and
// endRtBlock(numFrames) once after. This consolidates the generation bump and
// g_rtInChain flag to a single pair of atomic writes per audio callback.

void beginRtBlock() {
  g_rtBlockStart = g_rtTotalSamples;
  g_rtGeneration.fetch_add(1, std::memory_order_acq_rel);
  g_rtInChain.store(true, std::memory_order_release);
}

void endRtBlock(int numFrames) {
  g_rtTotalSamples += numFrames;
  g_rtInChain.store(false, std::memory_order_release);
}

// ── V9: plugin state (preset) get/set ────────────────────────────────────────
// Minimal IBStream implementations for IComponent::getState / setState.

namespace {

struct WriteStream final : public IBStream {
  std::vector<uint8_t>& buf;
  explicit WriteStream(std::vector<uint8_t>& b) : buf(b) {}
  tresult PLUGIN_API read(void*, int32, int32*) override { return kNotImplemented; }
  tresult PLUGIN_API write(void* src, int32 n, int32* written) override {
    int32 wrote = 0;
    if (src && n > 0) { buf.insert(buf.end(), (uint8_t*)src, (uint8_t*)src + n); wrote = n; }
    if (written) *written = wrote;
    return kResultOk;
  }
  tresult PLUGIN_API seek(int64, int32, int64*) override { return kNotImplemented; }
  tresult PLUGIN_API tell(int64*) override { return kNotImplemented; }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    QUERY_INTERFACE(iid, obj, FUnknown::iid, IBStream)
    QUERY_INTERFACE(iid, obj, IBStream::iid, IBStream)
    *obj = nullptr; return kNoInterface;
  }
  uint32 PLUGIN_API addRef()  override { return 1000; }
  uint32 PLUGIN_API release() override { return 1000; }
};

struct ReadStream final : public IBStream {
  const std::vector<uint8_t>& buf;
  size_t pos = 0;
  explicit ReadStream(const std::vector<uint8_t>& b) : buf(b) {}
  tresult PLUGIN_API read(void* dst, int32 n, int32* rd) override {
    if (!dst || n <= 0) { if (rd) *rd = 0; return kResultOk; }
    size_t avail = buf.size() > pos ? buf.size() - pos : 0;
    size_t take  = static_cast<size_t>(n) < avail ? static_cast<size_t>(n) : avail;
    std::memcpy(dst, buf.data() + pos, take);
    pos += take;
    if (rd) *rd = static_cast<int32>(take);
    return kResultOk;
  }
  tresult PLUGIN_API write(void*, int32, int32*) override { return kNotImplemented; }
  tresult PLUGIN_API seek(int64 p, int32 mode, int64* res) override {
    int64 newPos;
    if      (mode == kIBSeekSet) newPos = p;
    else if (mode == kIBSeekCur) newPos = static_cast<int64>(pos) + p;
    else if (mode == kIBSeekEnd) newPos = static_cast<int64>(buf.size()) + p;
    else { if (res) *res = static_cast<int64>(pos); return kResultFalse; }
    // Clamp to [0, buf.size()] — negative casts to size_t produce SIZE_MAX.
    pos = (newPos < 0) ? 0 : static_cast<size_t>(newPos);
    if (res) *res = static_cast<int64>(pos);
    return kResultOk;
  }
  tresult PLUGIN_API tell(int64* p) override {
    if (p) *p = static_cast<int64>(pos); return kResultOk;
  }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    QUERY_INTERFACE(iid, obj, FUnknown::iid, IBStream)
    QUERY_INTERFACE(iid, obj, IBStream::iid, IBStream)
    *obj = nullptr; return kNoInterface;
  }
  uint32 PLUGIN_API addRef()  override { return 1000; }
  uint32 PLUGIN_API release() override { return 1000; }
};

}  // namespace

bool getPluginState(int slotId, std::vector<uint8_t>& out) {
  if (slotId < 0 || slotId >= kMaxSlots) return false;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot || !slot->component) return false;
  WriteStream ws(out);
  return slot->component->getState(&ws) == kResultOk;
}

// PDC: IAudioProcessor::getLatencySamples() (VST3 SDK §3.7.5).
// Called from VstGetLatency in addon.cc on the JS thread. The processor
// pointer is written once on load (JS thread) and cleared on unload (JS
// thread under processChainVersion fence), so reading it here with acquire
// is safe — no RT-callback writes to the processor pointer.
int32_t getPluginLatencySamples(int slotId) {
  if (slotId < 0 || slotId >= kMaxSlots) return 0;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot || !slot->processor) return 0;
  return static_cast<int32_t>(slot->processor->getLatencySamples());
}

bool setPluginState(int slotId, const std::vector<uint8_t>& data) {
  if (slotId < 0 || slotId >= kMaxSlots) return false;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot || !slot->component) return false;
  ReadStream rs(data);
  return slot->component->setState(&rs) == kResultOk;
}

// ── Editor window (V4 spike, Windows) ────────────────────────────────────────
#ifdef _WIN32
namespace {

// IPlugFrame the plugin calls back into when it wants to resize its view. We
// resize the host window's client area to match, then echo onSize() back. A
// single static instance is fine: only one editor pump runs at a time and the
// frame is stateless (it derives the HWND from the view's window).
class KgbPlugFrame : public IPlugFrame {
 public:
  HWND hwnd = nullptr;

  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override {
    if (hwnd && r) {
      RECT rc{0, 0, r->getWidth(), r->getHeight()};
      AdjustWindowRectEx(&rc, static_cast<DWORD>(GetWindowLongPtr(hwnd, GWL_STYLE)), FALSE, 0);
      SetWindowPos(hwnd, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top,
                   SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    if (view) view->onSize(r);
    return kResultTrue;
  }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    QUERY_INTERFACE(iid, obj, FUnknown::iid, IPlugFrame)
    QUERY_INTERFACE(iid, obj, IPlugFrame::iid, IPlugFrame)
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1000; }   // static lifetime
  uint32 PLUGIN_API release() override { return 1000; }
};

KgbPlugFrame g_plugFrame;
const wchar_t* kEditorWndClass = L"KgbVstEditorWindow";

LRESULT CALLBACK editorWndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_CLOSE) { ShowWindow(h, SW_HIDE); return 0; }  // hide, don't destroy
  return DefWindowProcW(h, msg, wp, lp);
}

void ensureWndClass() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = editorWndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.lpszClassName = kEditorWndClass;
  RegisterClassExW(&wc);
  registered = true;
}

}  // namespace
#endif  // _WIN32

bool openEditor(int slotId) {
  std::lock_guard<std::mutex> lock(g_loadMutex);
  if (slotId < 0 || slotId >= kMaxSlots) return false;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot || !slot->controller) return false;
  if (slot->view) return true;  // already open

#ifdef _WIN32
  IPtr<IPlugView> view = owned(slot->controller->createView(Vst::ViewType::kEditor));
  if (!view) return false;  // headless plugin — no editor
  if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) return false;

  ensureWndClass();
  ViewRect rect{};
  view->getSize(&rect);
  RECT wr{0, 0, rect.getWidth() ? rect.getWidth() : 600,
          rect.getHeight() ? rect.getHeight() : 400};
  AdjustWindowRectEx(&wr, WS_OVERLAPPEDWINDOW, FALSE, 0);

  HWND hwnd = CreateWindowExW(
      0, kEditorWndClass, L"VST Editor", WS_OVERLAPPEDWINDOW,
      CW_USEDEFAULT, CW_USEDEFAULT, wr.right - wr.left, wr.bottom - wr.top,
      nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) return false;

  g_plugFrame.hwnd = hwnd;
  view->setFrame(&g_plugFrame);
  if (view->attached(hwnd, kPlatformTypeHWND) != kResultTrue) {
    DestroyWindow(hwnd);
    view->setFrame(nullptr);
    return false;
  }
  ShowWindow(hwnd, SW_SHOW);
  UpdateWindow(hwnd);

  slot->view = view;
  slot->editorHwnd = hwnd;
  return true;
#else
  return false;  // editor hosting is Windows-only for the MVP (ADR: Windows-first)
#endif
}

void closeEditor(int slotId) {
  std::lock_guard<std::mutex> lock(g_loadMutex);
  if (slotId < 0 || slotId >= kMaxSlots) return;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot || !slot->view) return;
  slot->view->setFrame(nullptr);
  slot->view->removed();
  slot->view = nullptr;
#ifdef _WIN32
  if (slot->editorHwnd) {
    g_plugFrame.hwnd = nullptr;
    DestroyWindow(static_cast<HWND>(slot->editorHwnd));
    slot->editorHwnd = nullptr;
  }
#endif
}

bool hasEditor(int slotId) {
  if (slotId < 0 || slotId >= kMaxSlots) return false;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  return slot && slot->view != nullptr;
}

void runEditorPump(int ms) {
#ifdef _WIN32
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
  MSG msg;
  while (std::chrono::steady_clock::now() < deadline) {
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
#else
  (void)ms;
#endif
}

void pumpEditorMessages() {
#ifdef _WIN32
  MSG msg;
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
#endif
}

// ── I3: MIDI note events ──────────────────────────────────────────────────────

bool noteOn(int slotId, int channel, int pitch, int velocity) {
  if (slotId < 0 || slotId >= kMaxSlots) return false;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot) return false;
  const uint32_t w = slot->midiWpos.load(std::memory_order_relaxed);
  const uint32_t r = slot->midiRpos.load(std::memory_order_acquire);
  if (w - r >= kMidiRingSize) return true;  // ring full — drop
  slot->midiRing[w & (kMidiRingSize - 1)] = {
    0,
    static_cast<uint8_t>(channel  & 0x0F),
    static_cast<uint8_t>(pitch    & 0x7F),
    static_cast<uint8_t>(velocity & 0x7F)
  };
  slot->midiWpos.store(w + 1, std::memory_order_release);
  return true;
}

bool noteOff(int slotId, int channel, int pitch) {
  if (slotId < 0 || slotId >= kMaxSlots) return false;
  PluginSlot* slot = g_slots[slotId].load(std::memory_order_acquire);
  if (!slot) return false;
  const uint32_t w = slot->midiWpos.load(std::memory_order_relaxed);
  const uint32_t r = slot->midiRpos.load(std::memory_order_acquire);
  if (w - r >= kMidiRingSize) return true;
  slot->midiRing[w & (kMidiRingSize - 1)] = {
    1,
    static_cast<uint8_t>(channel & 0x0F),
    static_cast<uint8_t>(pitch   & 0x7F),
    0
  };
  slot->midiWpos.store(w + 1, std::memory_order_release);
  return true;
}

// ── I1: per-track insert chains ───────────────────────────────────────────────
// JS-thread only — no RT access. trackId is an opaque integer handle the JS
// side assigns (e.g. index into the timeline tracks array).

namespace {
  std::unordered_map<int, std::vector<int>> g_trackChains;
  std::mutex g_trackChainMutex;
}

bool setTrackChain(int trackId, const int* slotIds, int count) {
  std::lock_guard<std::mutex> lock(g_trackChainMutex);
  if (count <= 0 || !slotIds) {
    g_trackChains.erase(trackId);
    return true;
  }
  g_trackChains[trackId].assign(slotIds, slotIds + count);
  return true;
}

bool getTrackChain(int trackId, int* slotIds, int& count, int maxSlots) {
  std::lock_guard<std::mutex> lock(g_trackChainMutex);
  auto it = g_trackChains.find(trackId);
  if (it == g_trackChains.end()) { count = 0; return false; }
  const auto& chain = it->second;
  count = static_cast<int>(chain.size() < static_cast<size_t>(maxSlots)
                           ? chain.size() : static_cast<size_t>(maxSlots));
  std::copy(chain.begin(), chain.begin() + count, slotIds);
  return true;
}

void shutdown() {
  for (int i = 0; i < kMaxSlots; ++i)
    unloadPlugin(i);
  {
    std::lock_guard<std::mutex> lock(g_trackChainMutex);
    g_trackChains.clear();
  }
  std::lock_guard<std::mutex> lock(g_loadMutex);
  g_hostContext = nullptr;
}

}  // namespace vst
}  // namespace kgb

#endif  // KGB_WITH_VST
