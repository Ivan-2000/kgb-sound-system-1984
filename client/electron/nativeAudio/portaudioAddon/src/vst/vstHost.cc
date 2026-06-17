// VST3 host glue — implementation. Compiled only when KGB_WITH_VST=1.
#ifdef KGB_WITH_VST

#include "vst/vstHost.h"

#include "public.sdk/source/vst/hosting/module.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"

#include <cstdio>

namespace kgb {
namespace vst {

namespace {

// Render a class UID as a stable 32-char hex string. The SDK's UID is 16 bytes;
// we use it as the persisted identity of an inserted plugin (project files).
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

// Classify a class by its VST3 subcategories. Instruments carry "Instrument"
// (kInstrumentSynth etc.); everything else that is an Audio Module is an effect.
std::string classifyType(const std::string& category,
                         const VST3::Hosting::ClassInfo::SubCategories& subs) {
  if (category != kVstAudioEffectClass) return "other";
  for (const auto& s : subs) {
    if (s == "Instrument") return "instrument";
  }
  return "effect";
}

}  // namespace

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
  // module shared_ptr drops here → library unloaded. Probe is non-residential.
  return result;
}

std::vector<std::string> defaultSearchPaths() {
  return VST3::Hosting::Module::getModulePaths();
}

}  // namespace vst
}  // namespace kgb

#endif  // KGB_WITH_VST
