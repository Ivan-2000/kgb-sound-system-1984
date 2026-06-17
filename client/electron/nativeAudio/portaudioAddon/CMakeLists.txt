cmake_minimum_required(VERSION 3.15)
project(portaudio_addon C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# cmake-js injects Node.js headers; node-addon-api provides napi.h
include_directories(${CMAKE_JS_INC})

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_INC
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_INC "${NODE_ADDON_API_INC}")
include_directories(${NODE_ADDON_API_INC})

# ─── ASIO SDK ──────────────────────────────────────────────────────────────────
# KGB_NO_ASIO=ON  → build without ASIO (CI fallback, KGB_ASIO_SDK_DIR not needed).
# Default (OFF)   → KGB_ASIO_SDK_DIR env var must be set; CMake fails otherwise.
option(KGB_NO_ASIO "Build without ASIO support (CI/no-SDK fallback)" OFF)

if(NOT KGB_NO_ASIO)
  # Allow passing via cmake define (-DKGB_ASIO_SDK_DIR=/path) as an alternative
  # to the environment variable — useful for CI pipelines and IDE builds.
  if(DEFINED KGB_ASIO_SDK_DIR AND NOT "${KGB_ASIO_SDK_DIR}" STREQUAL "")
    set(ENV{KGB_ASIO_SDK_DIR} "${KGB_ASIO_SDK_DIR}")
  endif()

  if(NOT DEFINED ENV{KGB_ASIO_SDK_DIR} OR "$ENV{KGB_ASIO_SDK_DIR}" STREQUAL "")
    message(FATAL_ERROR
      "\n"
      "KGB_ASIO_SDK_DIR is not set.\n"
      "ASIO SDK cannot be redistributed (Steinberg license) — you must obtain it manually.\n"
      "\n"
      "Run the setup guide (from repo root):\n"
      "  powershell -ExecutionPolicy Bypass -File "
      "client/electron/nativeAudio/portaudioAddon/scripts/fetch-asio-sdk.ps1\n"
      "\n"
      "Or pass the path directly:\n"
      "  npm run rebuild -- --CDKGB_ASIO_SDK_DIR=C:/ASIOSDK2.3.4\n"
      "\n"
      "To build without ASIO (CI / no-SDK fallback):\n"
      "  npm run build:noasio\n")
  endif()

  # Validate SDK structure before delegating to PortAudio's FindASIOSDK.cmake.
  if(NOT EXISTS "$ENV{KGB_ASIO_SDK_DIR}/common/asio.h")
    message(FATAL_ERROR
      "\n"
      "KGB_ASIO_SDK_DIR=$ENV{KGB_ASIO_SDK_DIR}\n"
      "common/asio.h not found there — check the path.\n"
      "Expected layout: <SDK_ROOT>/common/asio.h, <SDK_ROOT>/host/asiodrivers.h\n")
  endif()

  # Pre-set ASIOSDK_ROOT_DIR so PortAudio's FindASIOSDK.cmake picks it up
  # without needing the SDK to sit next to the portaudio directory.
  set(ASIOSDK_ROOT_DIR "$ENV{KGB_ASIO_SDK_DIR}" CACHE PATH "Path to ASIO SDK root" FORCE)
  set(PA_USE_ASIO ON CACHE BOOL "Enable ASIO support in PortAudio" FORCE)
  message(STATUS "[KGB] ASIO enabled — SDK: ${ASIOSDK_ROOT_DIR}")
else()
  set(PA_USE_ASIO OFF CACHE BOOL "Enable ASIO support in PortAudio" FORCE)
  message(STATUS "[KGB] ASIO disabled (KGB_NO_ASIO=ON)")
endif()

# ─── PortAudio from source (third_party/portaudio submodule) ──────────────────
if(NOT EXISTS "${CMAKE_SOURCE_DIR}/third_party/portaudio/CMakeLists.txt")
  message(FATAL_ERROR
    "third_party/portaudio submodule is missing.\n"
    "Run: git submodule update --init --recursive")
endif()

# Only build the static library; disable shared lib, tests, examples, install.
set(PA_BUILD_STATIC  ON  CACHE BOOL "" FORCE)
set(PA_BUILD_SHARED  OFF CACHE BOOL "" FORCE)
set(PA_BUILD_TESTS   OFF CACHE BOOL "" FORCE)
set(PA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(PA_DISABLE_INSTALL ON CACHE BOOL "" FORCE)

# Windows backends — same set as the previous MSYS2 prebuilt.
set(PA_USE_WASAPI ON CACHE BOOL "" FORCE)
set(PA_USE_WDMKS  ON CACHE BOOL "" FORCE)
set(PA_USE_DS     ON CACHE BOOL "" FORCE)
set(PA_USE_WMME   ON CACHE BOOL "" FORCE)

add_subdirectory(third_party/portaudio EXCLUDE_FROM_ALL)

# ─── libopus from source (third_party/opus submodule) ─────────────────────────
if(NOT EXISTS "${CMAKE_SOURCE_DIR}/third_party/opus/CMakeLists.txt")
  message(FATAL_ERROR
    "third_party/opus submodule is missing.\n"
    "Run: git submodule update --init --recursive")
endif()

# Tests and programs are OFF by default in opus CMakeLists; set explicitly for
# clarity and to guard against future upstream defaults changing.
set(OPUS_BUILD_TESTING  OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE  OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)

add_subdirectory(third_party/opus EXCLUDE_FROM_ALL)

# ─── VST3 host (Steinberg VST3 SDK) ───────────────────────────────────────────
# KGB_WITH_VST=ON  → build the VST3 host (KGB_VST3_SDK_DIR env/-D must point at a
#                    recursive clone of github.com/steinbergmedia/vst3sdk).
# Default (OFF)    → no VST host; the engine builds with PortAudio + Opus only,
#                    so contributors without the SDK (and the build:asio default)
#                    are never blocked. Mirrors the ASIO opt-in block above.
#
# We compile only the SUBSET of the SDK a minimal *host* needs (pluginterfaces +
# base + public.sdk/source/{common,vst/hosting}). No plugin/vstgui/sdk_common.
# The SDK targets MSVC; this addon is MinGW/GCC — see README for the patch notes.
option(KGB_WITH_VST "Build the VST3 host (requires KGB_VST3_SDK_DIR)" OFF)

set(KGB_VST_SOURCES "")
set(KGB_VST_INCLUDE_DIRS "")

if(KGB_WITH_VST)
  # -D override falls back to the environment variable (cmake-js reads process env).
  if(DEFINED KGB_VST3_SDK_DIR AND NOT "${KGB_VST3_SDK_DIR}" STREQUAL "")
    set(ENV{KGB_VST3_SDK_DIR} "${KGB_VST3_SDK_DIR}")
  endif()

  if(NOT DEFINED ENV{KGB_VST3_SDK_DIR} OR "$ENV{KGB_VST3_SDK_DIR}" STREQUAL "")
    message(FATAL_ERROR
      "\n"
      "KGB_VST3_SDK_DIR is not set, but KGB_WITH_VST=ON.\n"
      "The VST3 SDK (Steinberg license) is not bundled — obtain it manually.\n"
      "\n"
      "Run the setup guide (from repo root):\n"
      "  powershell -ExecutionPolicy Bypass -File "
      "client/electron/nativeAudio/portaudioAddon/scripts/fetch-vst3-sdk.ps1\n"
      "\n"
      "Or pass the path directly:\n"
      "  npm run build:vst -- --CDKGB_VST3_SDK_DIR=A:/VST_SDK/vst3sdk\n"
      "\n"
      "To build without VST (default):\n"
      "  npm run build:asio\n")
  endif()

  # Normalize backslashes (A:\VST_SDK\...) to forward slashes — embedding a raw
  # Windows path in CMake source-list strings otherwise triggers escape-parsing
  # errors (\V is an invalid escape).
  file(TO_CMAKE_PATH "$ENV{KGB_VST3_SDK_DIR}" VST3_SDK)
  # Stable header that proves a usable host SDK layout (same probe as the script).
  if(NOT EXISTS "${VST3_SDK}/pluginterfaces/vst/ivstaudioprocessor.h")
    message(FATAL_ERROR
      "\n"
      "KGB_VST3_SDK_DIR=${VST3_SDK}\n"
      "pluginterfaces/vst/ivstaudioprocessor.h not found there — check the path /\n"
      "make sure the clone was recursive (git submodule update --init --recursive).\n")
  endif()

  # Minimal host source set. Compiled MSVC-first SDK under MinGW/GCC; the subset
  # below is everything VST3::Hosting::Module + the host helper classes need.
  set(KGB_VST_SOURCES
    ${VST3_SDK}/pluginterfaces/base/conststringtable.cpp
    ${VST3_SDK}/pluginterfaces/base/coreiids.cpp
    ${VST3_SDK}/pluginterfaces/base/funknown.cpp
    ${VST3_SDK}/pluginterfaces/base/ustring.cpp
    ${VST3_SDK}/base/source/baseiids.cpp
    ${VST3_SDK}/base/source/fbuffer.cpp
    ${VST3_SDK}/base/source/fdebug.cpp
    ${VST3_SDK}/base/source/fobject.cpp
    ${VST3_SDK}/base/source/fstreamer.cpp
    ${VST3_SDK}/base/source/fstring.cpp
    ${VST3_SDK}/base/source/updatehandler.cpp
    ${VST3_SDK}/base/thread/source/flock.cpp
    ${VST3_SDK}/base/thread/source/fcondition.cpp
    ${VST3_SDK}/public.sdk/source/common/commoniids.cpp
    ${VST3_SDK}/public.sdk/source/common/commonstringconvert.cpp
    ${VST3_SDK}/public.sdk/source/common/memorystream.cpp
    ${VST3_SDK}/public.sdk/source/common/threadchecker_win32.cpp
    ${VST3_SDK}/public.sdk/source/vst/utility/stringconvert.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/connectionproxy.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/eventlist.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/hostclasses.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/module.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/module_win32.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/parameterchanges.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/processdata.cpp
    # KGB host glue. vstIids.cc defines the VST-domain interface IIDs the SDK
    # leaves undefined for hosts (mirrors coreiids.cpp). plugprovider.cpp is
    # intentionally NOT included — it is a test helper and drags in
    # ITestPlugProvider; the host wires component↔controller itself.
    ${CMAKE_SOURCE_DIR}/src/vst/vstIids.cc
    ${CMAKE_SOURCE_DIR}/src/vst/vstHost.cc
  )
  set(KGB_VST_INCLUDE_DIRS ${VST3_SDK} ${CMAKE_SOURCE_DIR}/src)
  message(STATUS "[KGB] VST3 host enabled — SDK: ${VST3_SDK}")
else()
  message(STATUS "[KGB] VST3 host disabled (KGB_WITH_VST=OFF)")
endif()

# ─── addon ────────────────────────────────────────────────────────────────────
set(ADDON_SOURCES src/addon.cc ${KGB_VST_SOURCES})

# cmake-js injects /DELAYLOAD:NODE.EXE (MSVC syntax) which GNU ld rejects.
# We clear it and instead link against a pre-generated MinGW import library
# (libelectron-napi.dll.a) that imports the NAPI symbols directly from
# electron.exe — no delay loading required.
set(CMAKE_SHARED_LINKER_FLAGS "")

set(ELECTRON_NAPI_LIB "${CMAKE_SOURCE_DIR}/libelectron-napi.dll.a")
if(NOT EXISTS ${ELECTRON_NAPI_LIB})
  message(FATAL_ERROR
    "libelectron-napi.dll.a not found.\n"
    "Run: npm run gen-implib")
endif()

add_library(${PROJECT_NAME} SHARED ${ADDON_SOURCES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

# VST host: include dirs + KGB_WITH_VST guard (addon.cc #ifdef's its VST exports)
# and the SDK's mandatory RELEASE/NDEBUG defines (fdebug.h #errors without one).
if(KGB_WITH_VST)
  target_include_directories(${PROJECT_NAME} PRIVATE ${KGB_VST_INCLUDE_DIRS})
  target_compile_definitions(${PROJECT_NAME} PRIVATE KGB_WITH_VST=1 RELEASE=1 NDEBUG=1)
  # SDK hosting on Windows pulls in COM (CoCreateInstance), shell known-folder
  # paths (SHGetKnownFolderPath), the FOLDERID_* GUIDs (uuid), and — for the V4
  # editor window — user32/gdi32.
  target_link_libraries(${PROJECT_NAME} -lole32 -loleaut32 -lshell32 -luuid -luser32 -lgdi32)

  # Standalone V1 spike harness — reproduces the MinGW compile+link+run proof
  # outside Electron (a .node cannot be loaded by plain node — it imports
  # Electron's NAPI symbols). Build: cmake --build build --target vst_probe_test
  add_executable(vst_probe_test
    ${KGB_VST_SOURCES}
    ${CMAKE_SOURCE_DIR}/src/vst/vstProbeTest.cc)
  target_include_directories(vst_probe_test PRIVATE ${KGB_VST_INCLUDE_DIRS})
  target_compile_definitions(vst_probe_test PRIVATE KGB_WITH_VST=1 RELEASE=1 NDEBUG=1)
  target_link_libraries(vst_probe_test
    -static -static-libgcc -static-libstdc++
    -lole32 -loleaut32 -lshell32 -luuid -luser32 -lgdi32)
endif()

# portaudio_static exposes its include dir as PUBLIC, so target_link_libraries
# propagates it automatically (portaudio.h, pa_win_wasapi.h, pa_asio.h, ...).
# System audio libraries are listed explicitly in case portaudio_static marks
# them PRIVATE in the linked cmake version — deduplication happens at link time.
# -static-libgcc / -static-libstdc++ embed the MinGW runtime so Electron does
# not need MSYS2 DLLs in PATH at run time.
target_link_libraries(${PROJECT_NAME}
  ${ELECTRON_NAPI_LIB}
  portaudio_static
  opus
  -lwinmm
  -lole32
  -ldsound
  -lksuser
  -luuid
  -lsetupapi
  -static-libgcc
  -static-libstdc++
  C:/msys64/ucrt64/lib/libwinpthread.a
)
