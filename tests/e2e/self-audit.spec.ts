import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

// The self-audit panel (start page) turns the CI-only trust story
// user-facing (Phase 1.3). It must render every check, distinguish
// "checked now" from "enforced by CI" rows honestly, and the re-check
// button must actually be clickable — an earlier version had `overflow:
// hidden` on `.self-audit` collapse its own computed height to a few
// pixels while a flex item of `.start-page`, silently occluding the button
// behind `.start-page` for real pointer input despite looking fine and
// having a correctly-sized child (`.self-audit__header`) underneath.

test('self-audit panel renders every check and the re-check button is clickable', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js')]
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.address-bar__input')
  await window.waitForSelector('.self-audit__list .self-audit__row')

  const rows = window.locator('.self-audit__row')
  await expect(rows).toHaveCount(8)

  // At least one row must be honestly labeled as build/CI-enforced (the
  // crash-reporter guarantee) rather than presented as a runtime check.
  await expect(
    window.locator('.self-audit__provenance', { hasText: 'enforced by CI' })
  ).toHaveCount(1)

  // The refresh button must be a real, clickable target — not occluded by
  // an ancestor with a collapsed layout box (see file header).
  const refresh = window.getByRole('button', { name: 'Re-check now' })
  await refresh.click({ timeout: 5000 })
  await expect(rows).toHaveCount(8)

  await app.close()
})
