// Standalone V1 spike harness — NOT part of the addon build.
//
// Proves the Steinberg VST3 SDK hosting subset compiles + links + runs under
// MinGW/GCC (the main E1 risk: the SDK targets MSVC). Build with the spike
// compile line in README / the CMake `vst_probe_test` target, then:
//   ./vst_probe_test "C:/Program Files/Common Files/VST3/SomePlugin.vst3"
// With no argument it enumerates the OS default VST3 paths.
#ifdef KGB_WITH_VST

#include "vst/vstHost.h"

#include <cstdio>
#include <string>

static void printProbe(const kgb::vst::ProbeResult& r) {
  if (!r.ok) {
    std::printf("  FAILED: %s\n", r.error.c_str());
    return;
  }
  std::printf("  module: %s   (factory vendor: %s)\n",
              r.moduleName.c_str(), r.factoryVendor.c_str());
  for (const auto& c : r.classes) {
    std::printf("    [%-10s] %-32s  %s  v%s  {%s}  <%s>\n",
                c.type.c_str(), c.name.c_str(), c.vendor.c_str(),
                c.version.c_str(), c.subCategories.c_str(), c.uid.c_str());
  }
}

#include <cmath>
#include <vector>

// Load the plugin, run a few RT-sized blocks of noise through processChain(),
// and report channel counts / parameter count / output sanity. Proves the
// V1-skeleton host core (instantiate IComponent/IAudioProcessor + call
// process() from a simulated RT callback) end to end.
static int runProcess(const char* path) {
  const double sr = 48000.0;
  const int block = 256;

  auto lr = kgb::vst::loadPlugin(path, /*classUid*/ "", sr, block, /*slotId*/ -1);
  if (!lr.ok) {
    std::printf("  loadPlugin FAILED: %s\n", lr.error.c_str());
    return 1;
  }
  std::printf("  loaded slot=%d  %s [%s]  in=%dch out=%dch  params=%zu\n",
              lr.slotId, lr.name.c_str(), lr.type.c_str(),
              lr.numInputChannels, lr.numOutputChannels, lr.params.size());
  for (size_t i = 0; i < lr.params.size() && i < 5; ++i)
    std::printf("    param[%u] \"%s\" %s def=%.3f steps=%d\n",
                lr.params[i].id, lr.params[i].title.c_str(),
                lr.params[i].units.c_str(), lr.params[i].defaultNormalized,
                lr.params[i].stepCount);

  const int numCh = 2;
  std::vector<float> buf(static_cast<size_t>(block) * numCh);
  const int slots[1] = {lr.slotId};

  unsigned seed = 12345;
  bool finite = true;
  float peak = 0.f;
  for (int blk = 0; blk < 10; ++blk) {
    for (auto& s : buf) {
      seed = seed * 1103515245u + 12345u;
      s = (static_cast<float>((seed >> 9) & 0x7fff) / 16384.f - 1.f) * 0.25f;
    }
    kgb::vst::processChain(slots, 1, buf.data(), numCh, block);
    for (float s : buf) {
      if (!std::isfinite(s)) finite = false;
      float a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
  }
  std::printf("  processed 10x%d frames — output finite=%s peak=%.4f\n",
              block, finite ? "yes" : "NO", peak);

  kgb::vst::unloadPlugin(lr.slotId);
  std::printf("  unloaded — OK\n");
  kgb::vst::shutdown();
  return finite ? 0 : 1;
}

int main(int argc, char** argv) {
  if (argc >= 3 && std::string(argv[2]) == "process") {
    std::printf("Load+process: %s\n", argv[1]);
    return runProcess(argv[1]);
  }
  if (argc >= 2) {
    std::printf("Probing: %s\n", argv[1]);
    printProbe(kgb::vst::probe(argv[1]));
    return 0;
  }

  std::printf("No path given — scanning default VST3 search paths:\n");
  for (const auto& p : kgb::vst::defaultSearchPaths())
    std::printf("  search path: %s\n", p.c_str());
  return 0;
}

#else
int main() { return 0; }
#endif
