# Bundled filter-list attribution

These snapshots are refreshed **only** by `scripts/update-blocklists.mjs`,
run manually at release time. The app performs **no runtime downloads**
(docs/adr/0013-content-blocking.md).

**Retrieved:** 2026-07-06

## Licensing summary

- **EasyList** — Creative Commons Attribution-ShareAlike 3.0 Unported
  (CC BY-SA 3.0), elected over the GPLv3 alternative offered by the EasyList
  authors to avoid copyleft-scope ambiguity when bundling a static data
  snapshot inside this Apache-2.0 codebase (see ADR 0013).
- **uBlock Origin filter lists & resources** (`ubo-*.txt`, `ubo-resources.json`)
  — **GPLv3**. These are a verbatim mirror of uBlockOrigin/uAssets, carried
  here (via the ghostery/adblocker asset mirror) as static *data* files, not
  linked code. Redistributing them requires preserving this attribution and
  the GPLv3 grant; they remain under GPLv3 regardless of this repo's
  Apache-2.0 license. **Owner action:** confirm this aggregation is acceptable
  for distribution (see ADR 0013 "Licensing").

## Snapshots

### easylist-snapshot.txt

- **Source:** https://easylist.to/easylist/easylist.txt
- **License:** CC BY-SA 3.0 (elected over GPLv3 — see ADR 0013)
- **Attribution (required):** The EasyList authors (https://easylist.to/)
- **SHA-256:** `d3352fc5223d86c8925fef887edd7b124343f50f22520a506b3fa59f418ea2d9`
- **Size:** 2,055,671 bytes

### ubo-filters.txt

- **Source:** https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/filters.txt
- **License:** GPLv3 (uBlockOrigin/uAssets, mirrored by ghostery/adblocker)
- **Attribution (required):** Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)
- **SHA-256:** `f97c1a92206093fa0224ddac629c19ac9be8c779d8be5ac1b662065b2109261d`
- **Size:** 475,464 bytes

### ubo-quick-fixes.txt

- **Source:** https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/quick-fixes.txt
- **License:** GPLv3 (uBlockOrigin/uAssets, mirrored by ghostery/adblocker)
- **Attribution (required):** Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)
- **SHA-256:** `8e4a433981aa84de6f7a74d157abb3267ef610f03cf312171f8cf6eeb33b0f55`
- **Size:** 84,014 bytes

### ubo-privacy.txt

- **Source:** https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/privacy.txt
- **License:** GPLv3 (uBlockOrigin/uAssets, mirrored by ghostery/adblocker)
- **Attribution (required):** Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)
- **SHA-256:** `55dc58f7ca9f86bd28cea3a1f582f36f0181d5385b9a8c1c4b39b29837347f45`
- **Size:** 177,360 bytes

### ubo-resources.json

- **Source:** https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json
- **License:** GPLv3 (uBlockOrigin/uAssets scriptlet & redirect resources, mirrored by ghostery/adblocker)
- **Attribution (required):** Raymond Hill & contributors (https://github.com/uBlockOrigin/uAssets)
- **SHA-256:** `0532b9d3ece19d3aeb8ca23369cdf5dc4ea4cb0a142a84b205880040b4eb4cd7`
- **Size:** 181,973 bytes
