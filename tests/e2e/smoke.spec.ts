import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

// This is a launch smoke test only. The real forensic-diff check (snapshot
// filesystem mtimes before/after a scripted session, assert every new/
// modified file lives under the tmpfs-backed userData path) is owned by the
// forensics-verifier subagent and is tracked separately — see
// scripts/verify_footprint.sh and docs/threat-model.md.

test('app launches and shows a window with the address bar', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js')]
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.address-bar__input')
  await expect(window.locator('.address-bar__input')).toBeVisible()
  await app.close()
})
