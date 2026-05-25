# ============================================================
# fetch-asio-sdk.ps1 -- ASIO SDK setup guide for KGB Sound System 85
# ============================================================
# The ASIO SDK (Steinberg) cannot be redistributed or committed to the
# repository due to the Steinberg SDK License Agreement. This script
# guides you through obtaining it manually.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/fetch-asio-sdk.ps1
# ============================================================

$envVar = "KGB_ASIO_SDK_DIR"

# Check all three scopes: process (current session) -> user -> machine.
# cmake-js reads from the process environment, so a session-only $env: assignment
# is enough to make the build work even without setx.
$currentPath = $env:KGB_ASIO_SDK_DIR
if (-not $currentPath) {
    $currentPath = [System.Environment]::GetEnvironmentVariable($envVar, "User")
}
if (-not $currentPath) {
    $currentPath = [System.Environment]::GetEnvironmentVariable($envVar, "Machine")
}

if ($currentPath -and (Test-Path (Join-Path $currentPath "common\asio.h"))) {
    Write-Host ""
    Write-Host "ASIO SDK already configured:" -ForegroundColor Green
    Write-Host "  ${envVar} = $currentPath" -ForegroundColor Cyan
    Write-Host "  common\asio.h -- found." -ForegroundColor Green
    Write-Host ""
    Write-Host "You are ready to build with ASIO:" -ForegroundColor Green
    Write-Host "  cd client/electron/nativeAudio/portaudioAddon" -ForegroundColor White
    Write-Host "  npm run rebuild" -ForegroundColor White
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Yellow
Write-Host "  ASIO SDK Setup -- KGB Sound System 85" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "The ASIO SDK is NOT included in this repository." -ForegroundColor White
Write-Host "Steinberg's license prohibits redistribution -- you must obtain it" -ForegroundColor White
Write-Host "directly from their developer portal." -ForegroundColor White
Write-Host ""

Write-Host "STEP 1 -- Register / log in at Steinberg Developer:" -ForegroundColor Cyan
Write-Host "  https://developer.steinberg.help" -ForegroundColor White
Write-Host "  (Create a free MySteinberg account if you don't have one)" -ForegroundColor Gray
Write-Host ""

Write-Host "STEP 2 -- Download ASIO SDK 2.3.4 (latest):" -ForegroundColor Cyan
Write-Host "  After logging in, go to: SDK Downloads (top navigation)" -ForegroundColor White
Write-Host "  Find: 'ASIO SDK' -- download version 2.3.4 (or latest 2.3.x)" -ForegroundColor White
Write-Host "  You must accept the Steinberg SDK License Agreement to proceed." -ForegroundColor White
Write-Host "  Expected filename: asiosdk_2.3.4_<date>.zip (or similar)" -ForegroundColor Gray
Write-Host ""

Write-Host "STEP 3 -- Extract the SDK to a permanent location:" -ForegroundColor Cyan
Write-Host "  Recommended: C:\ASIOSDK2.3.4\" -ForegroundColor White
Write-Host "  After extraction, verify this structure:" -ForegroundColor White
Write-Host "    C:\ASIOSDK2.3.4\common\asio.h" -ForegroundColor Gray
Write-Host "    C:\ASIOSDK2.3.4\host\asiodrivers.h" -ForegroundColor Gray
Write-Host "    C:\ASIOSDK2.3.4\host\pc\asiolist.h" -ForegroundColor Gray
Write-Host ""

Write-Host "STEP 4 -- Set the environment variable:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Option A -- Permanent, current user (recommended):" -ForegroundColor White
Write-Host '    setx KGB_ASIO_SDK_DIR "C:\ASIOSDK2.3.4"' -ForegroundColor Green
Write-Host "    Then close and re-open your terminal / VS Code." -ForegroundColor Gray
Write-Host ""
Write-Host "  Option B -- Current PowerShell session only:" -ForegroundColor White
Write-Host '    $env:KGB_ASIO_SDK_DIR = "C:\ASIOSDK2.3.4"' -ForegroundColor Green
Write-Host ""
Write-Host "  Option C -- Via GUI (System Properties):" -ForegroundColor White
Write-Host "    Win+R -> sysdm.cpl -> Advanced -> Environment Variables" -ForegroundColor Gray
Write-Host "    Under 'User variables' -> New:" -ForegroundColor Gray
Write-Host "      Variable name:  KGB_ASIO_SDK_DIR" -ForegroundColor Gray
Write-Host "      Variable value: C:\ASIOSDK2.3.4" -ForegroundColor Gray
Write-Host ""

Write-Host "STEP 5 -- Build the addon with ASIO:" -ForegroundColor Cyan
Write-Host "  cd client/electron/nativeAudio/portaudioAddon" -ForegroundColor White
Write-Host "  npm run rebuild" -ForegroundColor White
Write-Host ""

Write-Host "---------------------------------------------" -ForegroundColor DarkGray
Write-Host "CI environments:" -ForegroundColor Gray
Write-Host "  Store the unpacked SDK as a CI secret/artifact and set" -ForegroundColor Gray
Write-Host "  KGB_ASIO_SDK_DIR to its path before running 'npm run build:asio'." -ForegroundColor Gray
Write-Host ""
Write-Host "No ASIO hardware? Build and test without it:" -ForegroundColor Gray
Write-Host "  npm run build:noasio" -ForegroundColor Gray
Write-Host "  getDevices() will return an empty ASIO list -- that is expected." -ForegroundColor Gray
Write-Host ""
