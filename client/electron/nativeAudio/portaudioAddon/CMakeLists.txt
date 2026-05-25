cmake_minimum_required(VERSION 3.15)
project(portaudio_addon CXX)

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
  if(NOT DEFINED ENV{KGB_ASIO_SDK_DIR} OR "$ENV{KGB_ASIO_SDK_DIR}" STREQUAL "")
    message(FATAL_ERROR
      "\n"
      "KGB_ASIO_SDK_DIR is not set.\n"
      "ASIO SDK cannot be redistributed (Steinberg license) — you must obtain it manually.\n"
      "\n"
      "Run the setup guide:\n"
      "  powershell -ExecutionPolicy Bypass -File "
      "client/electron/nativeAudio/portaudioAddon/scripts/fetch-asio-sdk.ps1\n"
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

# ─── addon ────────────────────────────────────────────────────────────────────
set(ADDON_SOURCES src/addon.cc)

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

# portaudio_static exposes its include dir as PUBLIC, so target_link_libraries
# propagates it automatically (portaudio.h, pa_win_wasapi.h, pa_asio.h, ...).
# System audio libraries are listed explicitly in case portaudio_static marks
# them PRIVATE in the linked cmake version — deduplication happens at link time.
# -static-libgcc / -static-libstdc++ embed the MinGW runtime so Electron does
# not need MSYS2 DLLs in PATH at run time.
target_link_libraries(${PROJECT_NAME}
  ${ELECTRON_NAPI_LIB}
  portaudio_static
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
