#!/usr/bin/env node
// Refresh the bundled ad/tracker filter snapshots and scriptlet resources.
//
// Run manually at release time only — the app NEVER downloads filter lists at
// runtime (docs/adr/0013-content-blocking.md; the "no phone-home" charter in
// electron-builder.yml). This script writes verbatim snapshots into
// resources/adblock/ and rewrites resources/adblock/ATTRIBUTION.md with the
// exact source URL, retrieval date, and SHA-256 of every file so the bundled
// data is auditable and reproducible.
//
// Sources are pinned to the Ghostery adblocker asset mirror
// (raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets).
// That mirror is version-matched to the installed @ghostery/adblocker engine:
// the uBlock Origin scriptlet *names* referenced by ublock-origin/filters.txt
// are guaranteed to resolve against ublock-origin/resources.json from the same
// tree. Pulling the filter lists straight from uBlockOrigin/uAssets risks a
// scriptlet-name/resource skew that would silently break YouTube blocking.
//
// LICENSING: EasyList is CC BY-SA 3.0 (see ATTRIBUTION.md). The ublock-origin/*
// filter data is a mirror of uBlockOrigin/uAssets, which is GPLv3. Bundling it
// as a static data file inside this Apache-2.0 repo is an aggregation, but the
// attribution/GPLv3 note in ATTRIBUTION.md is required. Flagged for the owner.

import { createHash } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'resources', 'adblock')

const GHOSTERY_PREFIX =
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets'

// [localFilename, url, license, attribution, reuse]
// `reuse: true` = record the existing on-disk snapshot (compute its sha256) but
// do NOT re-download. EasyList is served from easylist.to, and its verbatim
// snapshot is deliberately carried forward unchanged across the engine swap
// (ADR 0013); re-fetching would churn it needlessly.
const SOURCES = [
  [
    'easylist-snapshot.txt',
    'https://easylist.to/easylist/easylist.txt',
    'CC BY-SA 3.0 (elected over GPLv3 — see ADR 0013)',
    'The EasyList authors (https://easylist.to/)',
    true
  ],
  [
    'ubo-filters.txt',
    `${GHOSTERY_PREFIX}/ublock-origin/filters.txt`,
    'GPLv3 (uBlockOrigin/uAssets, mirrored by ghostery/adblocker)',
    'Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)'
  ],
  [
    'ubo-quick-fixes.txt',
    `${GHOSTERY_PREFIX}/ublock-origin/quick-fixes.txt`,
    'GPLv3 (uBlockOrigin/uAssets, mirrored by ghostery/adblocker)',
    'Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)'
  ],
  [
    'ubo-privacy.txt',
    `${GHOSTERY_PREFIX}/ublock-origin/privacy.txt`,
    'GPLv3 (uBlockOrigin/uAssets, mirrored by ghostery/adblocker)',
    'Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)'
  ],
  [
    'ubo-resources.json',
    `${GHOSTERY_PREFIX}/ublock-origin/resources.json`,
    'GPLv3 (uBlockOrigin/uAssets scriptlet & redirect resources, mirrored by ghostery/adblocker)',
    'Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)'
  ]
]

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  return res.text()
}

async function main() {
  const only = process.argv[2] // optional: refresh a single filename
  const records = []
  for (const [name, url, license, attribution, reuse] of SOURCES) {
    if (only && only !== name) continue
    let body
    if (reuse) {
      process.stdout.write(`Reusing existing ${name} (not re-downloaded)\n`)
      body = await readFile(join(OUT_DIR, name), 'utf8')
    } else {
      process.stdout.write(`Fetching ${name} <- ${url}\n`)
      body = await fetchText(url)
      await writeFile(join(OUT_DIR, name), body, 'utf8')
    }
    const sha256 = createHash('sha256').update(body).digest('hex')
    records.push({ name, url, license, attribution, sha256, bytes: Buffer.byteLength(body) })
  }

  if (only) {
    process.stdout.write(`Refreshed only ${only}; ATTRIBUTION.md left unchanged.\n`)
    return
  }

  const date = new Date().toISOString().slice(0, 10)
  const lines = [
    '# Bundled filter-list attribution',
    '',
    'These snapshots are refreshed **only** by `scripts/update-blocklists.mjs`,',
    'run manually at release time. The app performs **no runtime downloads**',
    '(docs/adr/0013-content-blocking.md).',
    '',
    `**Retrieved:** ${date}`,
    '',
    '## Licensing summary',
    '',
    '- **EasyList** — Creative Commons Attribution-ShareAlike 3.0 Unported',
    '  (CC BY-SA 3.0), elected over the GPLv3 alternative offered by the EasyList',
    '  authors to avoid copyleft-scope ambiguity when bundling a static data',
    '  snapshot inside this Apache-2.0 codebase (see ADR 0013).',
    '- **uBlock Origin filter lists & resources** (`ubo-*.txt`, `ubo-resources.json`)',
    '  — **GPLv3**. These are a verbatim mirror of uBlockOrigin/uAssets, carried',
    '  here (via the ghostery/adblocker asset mirror) as static *data* files, not',
    '  linked code. Redistributing them requires preserving this attribution and',
    "  the GPLv3 grant; they remain under GPLv3 regardless of this repo's",
    '  Apache-2.0 license. **Owner action:** confirm this aggregation is acceptable',
    '  for distribution (see ADR 0013 "Licensing").',
    '',
    '## Snapshots',
    ''
  ]
  for (const r of records) {
    lines.push(`### ${r.name}`)
    lines.push('')
    lines.push(`- **Source:** ${r.url}`)
    lines.push(`- **License:** ${r.license}`)
    lines.push(`- **Attribution (required):** ${r.attribution}`)
    lines.push(`- **SHA-256:** \`${r.sha256}\``)
    lines.push(`- **Size:** ${r.bytes.toLocaleString('en-US')} bytes`)
    lines.push('')
  }
  await writeFile(join(OUT_DIR, 'ATTRIBUTION.md'), lines.join('\n'), 'utf8')
  process.stdout.write(`Wrote ${records.length} snapshots + ATTRIBUTION.md to ${OUT_DIR}\n`)
}

main().catch((err) => {
  process.stderr.write(`update-blocklists failed: ${err.message}\n`)
  process.exit(1)
})
