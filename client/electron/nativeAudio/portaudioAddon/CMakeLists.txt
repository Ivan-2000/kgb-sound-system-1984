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

# PortAudio from MSYS2 UCRT64 (installed via pacman)
set(PA_ROOT "C:/msys64/ucrt64")
set(PORTAUDIO_INCLUDE_DIR "${PA_ROOT}/include")
set(PORTAUDIO_STATIC_LIB "${PA_ROOT}/lib/libportaudio.a")

if(NOT EXISTS ${PORTAUDIO_INCLUDE_DIR}/portaudio.h)
  message(FATAL_ERROR
    "portaudio.h not found at ${PORTAUDIO_INCLUDE_DIR}.\n"
    "Install via MSYS2: pacman -S mingw-w64-ucrt-x86_64-portaudio")
endif()

include_directories(${PORTAUDIO_INCLUDE_DIR})

set(ADDON_SOURCES src/addon.cc)

# cmake-js injects /DELAYLOAD:NODE.EXE (MSVC syntax) which GNU ld rejects.
# We clear it and instead link against a pre-generated MinGW import library
# (libelectron-napi.dll.a) that imports the NAPI symbols directly from
# electron.exe — no delay loading required.
set(CMAKE_SHARED_LINKER_FLAGS "")

# Import library that resolves NAPI symbols from electron.exe at load time.
# Generated via: dlltool --dllname electron.exe --def electron_napi.def
set(ELECTRON_NAPI_LIB "${CMAKE_SOURCE_DIR}/libelectron-napi.dll.a")

if(NOT EXISTS ${ELECTRON_NAPI_LIB})
  message(FATAL_ERROR
    "libelectron-napi.dll.a not found.\n"
    "Run: dlltool --dllname electron.exe --def electron_napi.def --output-lib libelectron-napi.dll.a")
endif()

add_library(${PROJECT_NAME} SHARED ${ADDON_SOURCES} ${CMAKE_JS_SRC})

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

# Windows: link against the Electron NAPI import library + static PortAudio +
# system audio DLLs.  -static-libgcc / -static-libstdc++ embed the MinGW
# runtime so Electron does not need MSYS2 DLLs in PATH at run time.
target_link_libraries(${PROJECT_NAME}
  ${ELECTRON_NAPI_LIB}
  ${PORTAUDIO_STATIC_LIB}
  -lwinmm
  -lole32
  -ldsound
  -lksuser
  -luuid
  -lsetupapi
  # Embed GCC + C++ + pthreads runtimes so Electron does not need MSYS2 in PATH
  -static-libgcc
  -static-libstdc++
  ${PA_ROOT}/lib/libwinpthread.a
)
