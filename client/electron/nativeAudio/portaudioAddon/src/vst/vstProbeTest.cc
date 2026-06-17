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

int main(int argc, char** argv) {
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
