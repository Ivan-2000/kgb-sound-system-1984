# @kgb/portaudio-addon

Native Node.js addon for KGB Sound System 85 — PortAudio device enumeration and audio I/O.

Built with `node-addon-api` + cmake-js. Targets Electron 42, Windows (MinGW UCRT64 toolchain).

---

## Quick start (Windows, no ASIO hardware)

```powershell
# From this directory (portaudioAddon/)
npm install
npm run build:noasio
```

`build:noasio` builds PortAudio from source with WASAPI / DirectSound / WDM-KS / MME backends.
No ASIO SDK required. Works on any Windows machine.

---

## Building with ASIO

ASIO (Audio Stream Input/Output) is Steinberg's professional low-latency audio API.
It gives ≤ 10 ms round-trip latency on compatible interfaces (Focusrite, Behringer, RME, etc.).

KGB Sound System requires ASIO to meet the ≤ 30 ms end-to-end latency goal (TASKS.md A6).

### Prerequisites

| Component | Version | Notes |
|---|---|---|
| MSYS2 UCRT64 | latest | MinGW toolchain, Ninja, cmake |
| cmake-js | ^7.3 | already in `devDependencies` |
| ASIO SDK | **2.3.4** (latest 2.3.x) | Steinberg — **cannot be in the repo**, see below |

### Obtaining the ASIO SDK

The ASIO SDK is covered by the Steinberg SDK License Agreement, which prohibits redistribution.
**Do not commit the SDK to the repository.**

Run the setup guide — it explains each step interactively:

```powershell
# From the repo root
powershell -ExecutionPolicy Bypass -File client/electron/nativeAudio/portaudioAddon/scripts/fetch-asio-sdk.ps1
```

Manual steps (if you prefer):

1. **Register** at [developer.steinberg.help](https://developer.steinberg.help) (free MySteinberg account).
2. **Download** ASIO SDK 2.3.4 (latest 2.3.x) from *SDK Downloads* → accept the license agreement.
   Expected file: `asiosdk_2.3.4_<date>.zip` (or similar)
3. **Extract** to a permanent location, e.g. `C:\ASIOSDK2.3.4\`
   Verify the structure:
   ```
   C:\ASIOSDK2.3.4\
     common\asio.h
     host\asiodrivers.h
     host\pc\asiolist.h
   ```
4. **Set the environment variable** (permanent, current user):
   ```powershell
   setx KGB_ASIO_SDK_DIR "C:\ASIOSDK2.3.4"
   # Re-open terminal after setx
   ```
   Or for the current session only:
   ```powershell
   $env:KGB_ASIO_SDK_DIR = "C:\ASIOSDK2.3.4"
   ```

### Build

```powershell
# From portaudioAddon/
npm install
npm run rebuild          # builds with ASIO (requires KGB_ASIO_SDK_DIR)
```

Or explicitly:

```powershell
npm run build:asio       # same as rebuild — ASIO required
npm run build:noasio     # WASAPI/DS/WDM-KS/MME only — no SDK needed
```

### Verify

Open DevTools in the running Electron app and run:

```js
await window.kgbAudio.listDevices()
```

Devices with an ASIO driver appear with `hostApi: 'ASIO'` in the returned array.
If no ASIO devices are installed, the list is empty for that host API — that is expected.

---

## MinGW and ASIO compatibility

MinGW UCRT64 is fully supported for ASIO builds. PortAudio ships
`iasiothiscallresolver.cpp` — a `__thiscall` shim that handles the calling-convention
difference between MinGW and MSVC for the `IASIO` COM interface. No MSVC required.

If you encounter MinGW + ASIO compilation issues beyond ~1 hour of investigation,
file an issue and we will evaluate switching the build chain to MSVC.

---

## CMake flags

| Flag | Default | Effect |
|---|---|---|
| `KGB_NO_ASIO=ON` | OFF | Build without ASIO — no SDK needed |
| `KGB_ASIO_SDK_DIR=/path` | — | SDK path as cmake define (alternative to env var) |

Pass cmake defines via cmake-js: `--CDKGB_NO_ASIO=ON` or `--CDKGB_ASIO_SDK_DIR=C:/ASIOSDK2.3.4`.

> **Switching between ASIO and no-ASIO builds:** cmake caches the `KGB_NO_ASIO` value.
> If you switch build modes, clean first:
> ```powershell
> node_modules/.bin/cmake-js clean
> npm run rebuild          # or build:noasio
> ```

---

## PortAudio submodule

PortAudio is included as a git submodule at `third_party/portaudio`, pinned to **v19.7.0**.

```powershell
# Initialize after fresh clone
git submodule update --init --recursive
```

Built from source with these backends:

| Backend | CMake flag | Default |
|---|---|---|
| ASIO | `PA_USE_ASIO` | ON (if SDK found) |
| WASAPI | `PA_USE_WASAPI` | ON |
| WDM-KS | `PA_USE_WDMKS` | ON |
| DirectSound | `PA_USE_DS` | ON |
| MME | `PA_USE_WMME` | ON |

---

## CI / no-SDK builds

CI pipelines that do not have the ASIO SDK available should use:

```powershell
npm run build:noasio
```

This passes `-DKGB_NO_ASIO=ON` to cmake and builds without ASIO.
For CI pipelines that do have the SDK (stored as a protected artifact/secret):

```powershell
# Set KGB_ASIO_SDK_DIR in the CI environment / secret store, then:
npm run build:asio
```

---

## Toolchain notes

- Generator: Ninja (MinGW UCRT64)
- Runtime: Electron 42
- NAPI symbols resolved via `libelectron-napi.dll.a` (MinGW import library for `electron.exe`).
  Regenerate if you upgrade Electron: `npm run gen-implib`
- MinGW runtime embedded statically (`-static-libgcc -static-libstdc++ libwinpthread.a`) —
  no MSYS2 in PATH needed at runtime.
