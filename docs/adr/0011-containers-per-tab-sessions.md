# 0011: Containers mode — per-tab isolated sessions

## Status

Accepted (owner approval given for this one Phase 3 item, 2026-07-05). This is
a session-only, opt-in feature with no persisted state, consistent with
CLAUDE.md's no-persisted-settings rule — there is no "containers enabled at
startup" state to design around; the user opts in each session.

## Context

Every tab in this app has shared one in-memory session (the per-generation
`inmemory-session-<n>` partition, ADR 0009). That means a cookie or
`localStorage` entry a tracker sets in tab A is readable by that same tracker
in tab B — the two tabs are correlatable through storage even though nothing
survives the eventual exit. Firefox's Multi-Account Containers popularized the
fix a user actually wants here: deliberately separate a set of tabs so their
storage can't see each other's, without needing a second browser profile.

Phase 3.3 asks for that: per-tab isolated sessions, opt-in, off by default,
inside the same amnesic (nothing-to-disk) envelope everything else already
lives in.

## Decision

### 1. Session-only toggle, OFF by default on every launch

A "Containers" toolbar chip following the exact IPC + UI pattern of the Tor
(ADR 0007) and DNS (ADR 0010) chips: `CONTAINERS_GET_STATUS` /
`CONTAINERS_SET_ENABLED`, plain serializable `{ enabled: boolean }` payloads,
no new renderer capability crossing the bridge. No keyboard shortcut in v1.

Turning the toggle ON affects **only tabs created afterward**; existing tabs
keep their current session. Turning it OFF likewise only affects subsequently
created tabs. There is deliberately **no teardown of existing tabs on either
edge** — that avoids any mass-teardown ambiguity, and the only mass reset in
the app remains New Identity. The chip's popover copy and the README state the
"new tabs only" semantics plainly.

### 2. Partition naming extends ADR 0009's never-reuse scheme

Fresh per-tab partitions are named `inmemory-session-<generation>-tab-<k>`,
where `<k>` is a **module-level monotonic counter** (`tabPartitionCounter` in
`src/main/index.ts`) that is only ever incremented — **never reset, not even by
New Identity**. Pairing it with the generation makes the name unique on both
axes, so no per-tab session object is ever reused for the life of the process
(zero-reuse, the simplest possible invariant). The shared partition for
containers-off tabs remains `inmemory-session-<generation>` exactly as today.
No `persist:` prefix anywhere — that absence is what keeps every partition
memory-only. The naming logic lives in the pure, unit-tested `src/main/
partitions.ts` (like `tor.ts` / `dns.ts`).

### 3. Opener inheritance

Tabs created **by a page** — the `setWindowOpenHandler` path (`window.open` /
`target=_blank`) and the context-menu "open in new tab" path — inherit the
**opener tab's** `Session`, even when containers mode is on. Only
user-initiated tabs (Ctrl+T, the + button, a forwarded second-instance URL,
and the fresh tab New Identity creates) get fresh partitions when the mode is
on.

Without this, every OAuth/login popup flow breaks — the popup would land in a
different container than the page that opened it and lose its login. This
matches Firefox Multi-Account Containers semantics: a container's own links
stay in its container. Implementation: `createTab()` takes an already-prepared
`Session` as a required parameter; the window-open and context-menu callbacks
pass the current tab's `ses` straight in (it is already hardened, so no await),
while user tabs go through `openUserTab()`.

### 4. The hardening invariant, enforced by a type

No `WebContentsView` may be constructed with a partition whose
`hardenSession()` has not resolved. Fresh per-tab partitions require an `await`
(create the partition, harden it, apply the current network state) before the
view can exist. Rather than rely on a comment, `createTab(ses: Session, …)`
takes an **already-prepared session as a required argument**, so no call site
can construct a view on an unhardened session — the type is the enforcement.

`prepareFreshTabSession()` is the single async door that does
`fromPartition` + `hardenSession` and returns the prepared session;
`openUserTab()` calls it when containers are on and otherwise hands over the
shared session (always already hardened at startup / New Identity). Inherited
and shared sessions need no await. `hardenSession()` already applies
`currentProxyConfig()` as its last step, so decision 5b (below) falls out for
free: a fresh partition is proxied before it can back a view.

### 5. Tor/proxy over ALL live sessions

ADR 0007 applied the SOCKS5 proxy to the in-memory tab session +
`defaultSession`. With containers, "the tab session" becomes a set:

- (a) Toggling Tor on/off applies/clears the proxy on **every live tab
  session**, derived from `liveTabSessions()` — the shared session,
  `defaultSession`, and every open tab's own `session` (stored on each
  `TabEntry`). The set collapses to `{shared, default}` when containers are
  off, so this is a strict generalization of the ADR 0007 behavior. The SOCKS5
  handshake probe still runs once (it validates the endpoint, identical for all
  sessions) — only the `setProxy` application fans out.
- (b) A fresh per-tab partition created **while Tor is on** has the proxy
  applied before any content loads, because `prepareFreshTabSession()` runs
  `hardenSession()` (which ends in `setProxy(currentProxyConfig())`) and is
  awaited before the view is built.
- (c) The fail-closed kill-switch (ADR 0007 decision 4) holds identically on
  per-tab sessions: each gets the same bare `socks5://host:port` proxy rules
  with no `direct://` fallback, so an unreachable proxy fails navigation closed
  on a container tab exactly as on the shared one.

DNS-over-HTTPS needs **no** per-session work: `app.configureHostResolver()`
(ADR 0010) is a process-global Chromium network-service setting, not a
per-session one, so containers change nothing about it.

### 6. New Identity interplay

Unchanged semantics: New Identity closes ALL tabs (whatever partitions they
had), bumps the generation, and creates one fresh tab. If containers mode is on
at rotation time, that fresh tab gets a fresh per-tab partition under the new
generation (via the same `openUserTab()` door). `tabPartitionCounter` is **not**
reset by the rotation (decision 2). The containers toggle itself keeps its
state across New Identity, exactly as the Tor/DNS selections do.

One natural extension, not a semantic change: New Identity now explicitly
clears every abandoned session it captured before closing tabs — the shared
session **and** each open tab's per-tab session — rather than only the shared
one. This is the same belt-and-suspenders `clearStorageData()` reasoning ADR
0009 already applies to the shared session, extended to the per-tab sessions
that containers introduced (closing a tab drops its view but not its session's
in-RAM storage). The exit-time wipe (`cleanupAndExit()`) does the same over
`liveTabSessions()`, so the "clear every live session" logic can't drift
between the two paths.

## Alternatives considered

- **Always-on isolation (per-tab sessions with no toggle).** Rejected: it
  breaks cross-tab login UX (open a link in a new tab and you're logged out),
  and it couldn't be turned off without introducing a persisted setting —
  which this project forbids. The opt-in toggle gives users who want isolation
  exactly that, while leaving the shared-session default that most browsing
  expects.
- **Per-first-party (per-site) isolation, à la Chromium's "first-party
  isolation" / Tor Browser's double-keying.** Rejected as out of scope: it is a
  different, larger feature (keying storage by the top-level site, affecting
  third parties _within_ a tab), not what "containers" asks for. Containers is
  per-tab, by deliberate user grouping — explicitly not per-site. A separate
  ADR could add first-party isolation later; it does not replace this.
- **Teardown of existing tabs when the toggle flips off (or on).** Rejected:
  it introduces exactly the mass-teardown ambiguity this design avoids (what
  happens to a tab mid-load? to its in-flight auth challenge?), and the app
  already has one well-defined mass-reset primitive — New Identity — for
  "wipe everything now." The toggle affecting only future tabs is both simpler
  to reason about and impossible to get subtly wrong.

## Consequences

- `TabEntry` gains a `session` field, and `createTab` gains a required
  `Session` parameter — a public contract that every path opening a tab now
  supplies an already-hardened session. `openUserTab()` is the one async door
  for user-initiated tabs.
- `liveTabSessions()` becomes the single source of "all sessions in play,"
  used by the Tor apply/clear path, the New Identity clear, and the exit-time
  wipe — so none of them can diverge on which sessions they cover.
- Memory cost: each container tab carries its own Chromium session/network
  context. This is the deliberate tradeoff of isolation; see the measurement
  section below.
- `docs/threat-model.md` gains a containers row (what it protects: storage/
  cookie correlation between tabs a user deliberately separates; what it does
  not: same IP for all tabs, fingerprinting still correlates, and third parties
  _within_ one tab still share that tab's partition — this is per-tab, not
  first-party isolation).
- Verification: unit tests for the never-reuse partition naming
  (`tests/unit/partitions.test.ts`); e2e coverage for OFF-shares / ON-isolates
  / opener-inheritance / New-Identity-isolation / Tor-through-a-container
  (`tests/e2e/containers.spec.ts`); and `scripts/footprint-session.mjs` now
  toggles containers on mid-session and stores data in a fresh per-tab
  partition, keeping every existing tmpfs-residue assertion green.

### Memory tradeoff — measurement method

`scripts/measure-containers.mjs` (dev-only, not run in CI) launches the built
app twice against a local hermetic page — once with containers OFF, once ON —
opens 10 tabs each time, lets them settle, and sums RSS across the app's whole
process tree (walking `/proc` children of the launched pid). It prints a small
OFF-vs-ON table with the delta. Relaunching between the two runs (rather than
toggling in place) keeps the OFF run's tabs from bleeding into the ON
measurement.

Measured on this workstation (Electron 43, x64, 10 tabs on the hermetic local
page, two separate launches):

| Mode                             | Total RSS across process tree | Processes |
| -------------------------------- | ----------------------------- | --------- |
| OFF (all tabs share one session) | 1620.6 MiB                    | 16        |
| ON (one fresh partition per tab) | 1636.4 MiB                    | 16        |
| **delta**                        | **+15.8 MiB (≈1.0%)**         | 0         |

Two honest caveats on that number:

- **The process count does not change** (16 either way). Per-tab partitions add
  in-memory network contexts _inside_ the existing network-service process, not
  new OS processes — Chromium's process model keys on origins/site isolation,
  not on session partition. So containers mode is not "N× the processes."
- **This is a floor, not a typical figure.** The measured tabs load a trivial
  hermetic page, so each isolated session is nearly empty. The cost of a
  container scales with what its session actually holds — cookies, a populated
  HTTP/memory cache, service workers, decoded resources. Ten containers each
  hosting a heavy real site would cost materially more than 1%. The takeaway is
  the shape (per-partition overhead is a network-context, not a whole process),
  not the specific 15.8 MiB. Re-run `scripts/measure-containers.mjs` to measure
  against a representative workload before quoting a number for real browsing.
