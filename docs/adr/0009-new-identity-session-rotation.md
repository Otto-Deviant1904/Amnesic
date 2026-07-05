# 0009: New Identity rotates the in-memory partition rather than clearing it in place

## Status

Accepted

## Context

Phase 1.2 of the v0.2.0 roadmap asks for a Tor Browser-style "New Identity":
close every tab and start over with a forensically fresh session, without
restarting the whole app. Two designs were on the table:

(a) **Keep the existing partition name** (`inmemory-session`) and rely on
`clearStorageData()` + `clearCache()` + `clearAuthCache()` +
`closeAllConnections()` being exhaustive.

(b) **Rotate to a new partition name** (`inmemory-session-<n>`) so the old
`Session` object is abandoned entirely, rather than trusted to have been
cleared exhaustively.

`session.fromPartition(name, options)` returns the **same** `Session` object
for the same `name` for the lifetime of the app (confirmed current in
Electron 43 — `research/session-and-userdata.md` §8; no breaking change
found in `breaking-changes.md` for this behavior). That single fact is what
makes (a) and (b) meaningfully different, not equivalent phrasings of the
same idea: under (a), every tab created after the reset still shares the
exact same underlying `Session`/network-context object that existed before
it, and the guarantee that nothing survives depends entirely on
`clearStorageData()`'s options object covering every storage type Chromium
has, forever, across every future Electron version. Under (b), no code path
after the rotation ever asks for the old partition name again — the old
`Session` object simply has nothing left referencing it (no tab's
`webContents.session`, no `defaultSession`), and Chromium's underlying state
for it becomes eligible for reclamation without depending on any specific
storage-type enumeration staying complete.

## Decision

**Option (b).** `sessionGeneration` is a module-level counter in
`src/main/index.ts`, starting at 0 and only ever incremented, never reused
within one app run. `getInMemorySession()` derives the partition name from
it (`` `inmemory-session-${sessionGeneration}` ``) instead of using a fixed
constant. `newIdentity()`:

1. Captures a reference to the _current_ (about-to-be-abandoned) in-memory
   session.
2. Closes every open tab via the existing `closeTab()` — not a separate
   teardown path — passing `{ quitOnEmpty: false }` so the pre-existing
   "closing the last tab closes the window" behavior (which exists for the
   normal close-to-exit flow) doesn't fire during a reset that must **not**
   quit the app.
3. Explicitly awaits `clearStorageData()` / `clearCache()` /
   `clearAuthCache()` on the _old_ session before dropping the reference —
   the same immediate, awaited pattern `cleanupAndExit()` already uses. This
   is belt-and-suspenders on top of (b), not the primary guarantee: it drops
   Chromium's own references and lets the allocator reclaim sooner rather
   than waiting on JS-engine GC timing (threat-model.md §3's memory-hygiene
   reasoning applies here identically to the exit path).
4. Increments `sessionGeneration`, so the next `getInMemorySession()` call
   returns a brand-new `Session` object under a name never used before.
5. Calls `hardenSession()` — see below — on that new session _before_ any
   tab can reference it.
6. Opens one fresh tab and tells the shell to show a brief "identity reset"
   flash.

**The `hardenSession()` refactor.** The function that applies session-level
mitigations (spellchecker off, referrer stripping, permission-request
denial, download cancellation — `docs/threat-model.md` §2) was previously
named `applySessionMitigations()` and called twice, both at startup
(`configureSession()`, once for the tab partition and once for
`defaultSession`). It is renamed `hardenSession()` and is now the **only**
function anywhere in the codebase permitted to follow a
`session.fromPartition()` call — startup and New Identity both funnel
through it, so the two paths cannot drift apart. A future contributor adding
a new session-level mitigation only has one call site to find and one
function to reason about, instead of needing to remember that a mid-session
reset path also needs the same fix applied a second time.

**Per-webContents hardening needs no new code.** WebRTC IP-handling policy,
the CDP `RTCPeerConnection` removal, and the popup-deny window-open handler
(threat-model.md §2, ADR 0002/0003) are applied inside `createTab()`, which
already calls `getInMemorySession()` fresh on every invocation rather than
caching a session reference. Since `getInMemorySession()` now transparently
returns the rotated session, the one fresh tab `newIdentity()` opens after
rotation gets every per-webContents mitigation through the exact same code
path every other tab does — verified by reading `createTab()`, not assumed.

## Alternatives considered

- **Option (a), clear-in-place.** Rejected: correct today, but its
  correctness is a claim about Chromium's `clearStorageData()` options
  object being exhaustive _forever_, across every future Electron version —
  exactly the kind of claim this project has already been burned by trusting
  without re-verification (`no-referrers`, ADR 0002). Rotation makes the
  guarantee structural (nothing references the old object) rather than
  enumerative (we remembered to clear every storage type).
- **`closeAllConnections()` on the old session before dropping it.**
  Considered, not added: `cleanupAndExit()` doesn't call it either, and
  adding it only to the New Identity path (but not to the equally
  security-relevant final-exit path) would be an inconsistency introduced
  for this task alone rather than a deliberate, reviewed decision. Revisit
  for both paths together if a future finding shows in-flight connections
  surviving a reset.
- **A second, New-Identity-specific cleanup function.** Rejected outright by
  the task's own framing and by this project's precedent (`cleanupAndExit()`
  is deliberately the single wipe routine reached by every exit trigger) —
  forking a parallel routine is exactly the divergence risk `hardenSession()`
  is designed to prevent.

## Consequences

- `sessionGeneration` must never be reset or wrapped within a running
  process — it exists specifically so a partition name is never revisited,
  which is what makes rotation stronger than clear-in-place. Nothing in the
  current design resets it (it isn't part of any serialized state, and
  there's nothing to serialize it into — it dies with the process like
  everything else).
- `closeTab()`'s new `{ quitOnEmpty }` option is now a public contract
  between it and any caller that closes tabs in bulk without wanting the
  app to quit; the default (`true`) preserves the existing single-tab-close
  behavior every current caller and test relies on.
- `scripts/verify_footprint.sh` and `scripts/footprint-session.mjs` don't
  exercise New Identity; a mid-session reset followed by the normal
  window-close exit path needs its own e2e coverage (added alongside this
  ADR) proving cookies set before a reset are gone after, and that the
  footprint verifier's tmpfs-residue guarantee still holds when New Identity
  fires mid-session before the final exit.
- `docs/threat-model.md` gains a row: New Identity is a second, user-facing
  wipe trigger for the tab session (distinct from the full app-exit wipe),
  not a new mitigation mechanism in its own right — it reuses every
  mechanism the existing rows already describe.
