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

struct ParamSet {
  Vst::ParamID id;
  double value;
};

struct PluginSlot {
  VST3::Hosting::Module::Ptr module;
  IPtr<Vst::IComponent> component;
  IPtr<Vst::IAudioProcessor> processor;
  IPtr<Vst::IEditController> controller;
  bool controllerIsSeparate = false;

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

  ~PluginSlot() {
    if (processor) processor->setProcessing(false);
    if (component) {
      component->setActive(false);
      component->terminate();
    }
    if (controllerIsSeparate && controller)
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
// Bumped once per processChain() call; lets unloadPlugin know a full RT callback
// has elapsed since it nulled a slot (so no callback still holds the pointer).
std::atomic<uint64_t> g_rtGeneration{0};
// Set true while inside process()/the RT chain; false otherwise.
std::atomic<bool> g_rtInChain{false};

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

  std::vector<std::string> roots = paths.empty() ? defaultSearchPaths() : paths;
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
        c.category = m;  // overload: carry the module path for the caller
        out.push_back(std::move(c));
      }
    }
  }
  return out;
}

std::vector<std::string> defaultSearchPaths() {
  return VST3::Hosting::Module::getModulePaths();
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

  // Locate the requested class (or the first audio-module class).
  const VST3::Hosting::ClassInfo* chosen = nullptr;
  auto infos = factory.classInfos();
  for (const auto& ci : infos) {
    if (ci.category() != kVstAudioEffectClass) continue;
    if (classUid.empty() || uidToHex(ci.ID()) == classUid) {
      static thread_local VST3::Hosting::ClassInfo held;
      held = ci;
      chosen = &held;
      break;
    }
  }
  if (!chosen) { r.error = "audio module class not found in module"; return r; }

  auto slot = std::make_unique<PluginSlot>();
  slot->module = module;

  slot->component = factory.createInstance<Vst::IComponent>(chosen->ID());
  if (!slot->component) { r.error = "createInstance(IComponent) failed"; return r; }
  if (slot->component->initialize(hostContext()) != kResultOk) {
    r.error = "component->initialize failed"; return r;
  }

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
        slot->controller->initialize(hostContext());
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
  r.name = chosen->name();
  r.vendor = chosen->vendor();
  r.type = classifyType(chosen->category(), chosen->subCategories());
  r.uid = uidToHex(chosen->ID());
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
  g_rtGeneration.fetch_add(1, std::memory_order_acq_rel);
  if (count <= 0 || !interleaved || numChannels <= 0 || numFrames <= 0) return;

  g_rtInChain.store(true, std::memory_order_release);

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

  g_rtInChain.store(false, std::memory_order_release);
}

void shutdown() {
  for (int i = 0; i < kMaxSlots; ++i)
    unloadPlugin(i);
  std::lock_guard<std::mutex> lock(g_loadMutex);
  g_hostContext = nullptr;
}

}  // namespace vst
}  // namespace kgb

#endif  // KGB_WITH_VST
