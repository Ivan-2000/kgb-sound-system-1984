/**
 * afterPack hook — creates electron.exe as a hard link to the renamed executable.
 *
 * portaudio_addon.node is a MinGW-built native addon whose PE import table
 * references 'electron.exe' as the NAPI host (see electron/nativeAudio/
 * portaudioAddon/CMakeLists.txt).  electron-builder renames the executable
 * to the productName (e.g. 'KGB Sound System 85.exe'), so Windows cannot
 * resolve the 'electron.exe' import when loading the addon → "The specified
 * module could not be found".
 *
 * Hard-linking electron.exe → <productName>.exe costs zero extra disk space
 * and requires no Developer Mode (unlike symbolic links).  Windows module
 * loader finds electron.exe in the application directory (the same folder as
 * the utility process executable) and resolves NAPI symbols from it.
 */

import { linkSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export default async function afterPack(context) {
  const { appOutDir, packager } = context

  // productName becomes the exe stem (spaces included).
  const productName = packager.appInfo.productName
  const mainExe = join(appOutDir, `${productName}.exe`)
  const electronExe = join(appOutDir, 'electron.exe')

  if (!existsSync(mainExe)) {
    console.warn(`[afterPack] main exe not found: ${mainExe}`)
    return
  }

  if (existsSync(electronExe)) {
    console.log('[afterPack] electron.exe already exists, skipping')
    return
  }

  try {
    linkSync(mainExe, electronExe)
    console.log(`[afterPack] created hard link: electron.exe → ${productName}.exe`)
  } catch (hardLinkErr) {
    // Hard link can fail across filesystem boundaries or on FAT32.
    // Fall back to a full copy — wastes space but is always safe.
    console.warn(`[afterPack] hard link failed (${hardLinkErr.code}), falling back to copy`)
    try {
      copyFileSync(mainExe, electronExe)
      console.log(`[afterPack] copied ${productName}.exe → electron.exe`)
    } catch (copyErr) {
      console.error(`[afterPack] could not create electron.exe: ${copyErr.message}`)
    }
  }
}
