# Contributing

Thanks for wanting to help. This project is unusual in one way that
affects every contribution: **the product is a verified guarantee, not a
feature set.** Read this before opening a PR.

## The two documents that gate everything

1. **[CLAUDE.md](CLAUDE.md)** — the project constitution. It lists the
   non-goals (bookmarks, downloads, extensions, autofill/passwords,
   telemetry, anti-fingerprinting) that must not be implemented without
   explicit owner approval, and the engineering rules (every Chromium
   switch verified against the pinned Electron version, no real-disk
   writes without an ADR, ADRs for every architectural decision).
2. **[docs/threat-model.md](docs/threat-model.md)** — what the app
   protects against, by which mechanism, with which limits. If your change
   touches any mitigation surface, this document must be updated in the
   same PR.

If your idea appears on the non-goals list, open an issue to discuss it
first — a PR implementing a non-goal will be closed regardless of quality.

## The quality gate

Every PR must pass all of:

```sh
npm run typecheck
npm run lint        # includes CI greps that enforce "never call X" guarantees
npm test            # vitest unit tests
npm run test:e2e    # playwright e2e (needs xvfb-run locally: xvfb-run npm run test:e2e)
scripts/verify_footprint.sh   # the footprint verifier — CI is authoritative
```

Notes for local runs:

- **e2e tests need a display.** Use `xvfb-run` rather than your live X
  session — against a live display the tests pop real windows and can
  capture ambient keystrokes.
- **The footprint verifier is noisy on dev machines** (desktop apps write
  files constantly). Treat the CI run as authoritative; locally, check
  that the _app-attributable_ paths are clean.
- **Never weaken the lint greps** (`crashReporter.start(`,
  `GOOGLE_API_KEY`, `addRecentDocument`). If your legitimate change trips
  one (it has happened — to a docs string), reword the change, not the
  grep.

## Rules of thumb

- **New subsystem ⇒ verifier coverage in the same PR.** A mitigation the
  footprint verifier doesn't exercise is an assertion, not a guarantee
  (CLAUDE.md). Extend `scripts/footprint-session.mjs` /
  `scripts/verify_footprint.sh` alongside the feature.
- **New Chromium switch or Electron API ⇒ research note.** Verify it
  against the pinned `electron@43.0.0` (Chromium 150.0.7871.46) — docs for
  that version or Chromium source — and add a note in `research/`. This
  project has shipped-almost-shipped dead flags before; see ADR 0002.
- **Architectural decision ⇒ ADR** in `docs/adr/`, numbered, with the
  rejected alternatives.
- **No writes outside the tmpfs userData dir.** A feature that needs a
  real-disk write needs an ADR and owner approval first.
- **Session hardening goes in `hardenSession()`**, per-tab hardening in
  `createTab()` — never a third place; those two functions are what make
  the guarantees uniform across startup and New Identity rotation
  (ADR 0009).
- Commits: logically grouped, conventional style, no AI co-author lines.

## Good first issues

Issues labeled
[`good first issue`](https://github.com/Otto-Deviant1904/Amnesic/labels/good%20first%20issue)
are scoped to be landable without touching guarantee-bearing code. Comment
on one before starting so effort isn't duplicated.
