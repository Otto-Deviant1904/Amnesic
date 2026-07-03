// Swap detection for the startup warning (threat-model §3 / known
// limitation 1: swapped-out pages can land plaintext session data on disk,
// and no userspace mitigation exists — the honest move is to tell the user).
//
// Pure parsing lives here, separate from the electron entrypoint, so it can
// be unit-tested without an Electron environment.

/**
 * Parse /proc/swaps content and return the device names of swap areas that
 * can put memory on a real disk. zram devices are excluded: they are
 * compressed RAM, so pages "swapped" to them never leave volatile memory.
 */
export function diskBackedSwapDevices(procSwapsContent: string): string[] {
  return procSwapsContent
    .split('\n')
    .slice(1) // header row
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((device) => device !== '' && !/\bzram\d*$/.test(device))
}
