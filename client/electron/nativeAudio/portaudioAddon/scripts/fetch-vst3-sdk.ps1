# ============================================================
# fetch-vst3-sdk.ps1 -- VST3 SDK setup guide for KGB Sound System 85
# ============================================================
# The VST3 SDK (Steinberg) is dual-licensed (GPLv3 / proprietary) and, like the
# ASIO SDK, is NOT committed to this repository. This script guides you through
# obtaining it and points KGB_VST3_SDK_DIR at it.
#
# We build a MINIMAL VST3 HOST (not a plugin), so only a subset of the SDK is
# needed (pluginterfaces, base, public.sdk/hosting). A full recursive clone is
# the simplest reliable way to get it; vstgui is not required for the host.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/fetch-vst3-sdk.ps1
# ============================================================

$envVar = "KGB_VST3_SDK_DIR"
# Stable header that proves a usable host SDK layout.
$probe  = "pluginterfaces\vst\ivstaudioprocessor.h"

# Check process -> user -> machine scope (cmake-js reads the process env).
$currentPath = $env:KGB_VST3_SDK_DIR
if (-not $currentPath) { $currentPath = [System.Environment]::GetEnvironmentVariable($envVar, "User") }
if (-not $currentPath) { $currentPath = [System.Environment]::GetEnvironmentVariable($envVar, "Machine") }

if ($currentPath -and (Test-Path (Join-Path $currentPath $probe))) {
    Write-Host ""
    Write-Host "VST3 SDK already configured:" -ForegroundColor Green
    Write-Host "  ${envVar} = $currentPath" -ForegroundColor Cyan
    Write-Host "  $probe -- found." -ForegroundColor Green
    Write-Host ""
    Write-Host "You are ready to build with VST:" -ForegroundColor Green
    Write-Host "  cd client/electron/nativeAudio/portaudioAddon" -ForegroundColor White
    Write-Host "  npm run build:vst" -ForegroundColor White
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Yellow
Write-Host "  VST3 SDK Setup -- KGB Sound System 85" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "The VST3 SDK is not bundled (Steinberg license). Obtain it once:" -ForegroundColor White
Write-Host ""
Write-Host "1. Clone the SDK recursively (it has submodules) to a path of your choice," -ForegroundColor White
Write-Host "   e.g. A:\VST_SDK\vst3sdk :" -ForegroundColor White
Write-Host ""
Write-Host "     git clone --recursive https://github.com/steinbergmedia/vst3sdk.git A:\VST_SDK\vst3sdk" -ForegroundColor Cyan
Write-Host ""
Write-Host "   (If you forgot --recursive: cd into it and run" -ForegroundColor DarkGray
Write-Host "    'git submodule update --init --recursive'.)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "2. Point the env var at the clone root (this session + persisted for you):" -ForegroundColor White
Write-Host ""
Write-Host "     `$env:KGB_VST3_SDK_DIR = 'A:\VST_SDK\vst3sdk'" -ForegroundColor Cyan
Write-Host "     setx KGB_VST3_SDK_DIR 'A:\VST_SDK\vst3sdk'" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. Re-run this script to verify, then build:" -ForegroundColor White
Write-Host ""
Write-Host "     powershell -ExecutionPolicy Bypass -File scripts/fetch-vst3-sdk.ps1" -ForegroundColor White
Write-Host "     npm run build:vst" -ForegroundColor White
Write-Host ""
Write-Host "Note: you accept the Steinberg VST3 SDK License when you download it." -ForegroundColor DarkYellow
Write-Host "      The default build (npm run build:asio) stays VST-OFF and needs none of this." -ForegroundColor DarkYellow
Write-Host ""

if ($currentPath) {
    Write-Host "Current ${envVar} = $currentPath" -ForegroundColor Yellow
    Write-Host "  but $probe was NOT found there -- check the path / recursive clone." -ForegroundColor Red
    Write-Host ""
}
exit 1
