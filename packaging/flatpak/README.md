# Flatpak: investigation, not a shipped package

**Status: DO NOT PUBLISH YET.** This directory is primarily an investigation
into whether Amnesic can be shipped as a Flatpak _without silently weakening
its core guarantee_ ("nothing recoverable on disk after exit"). The manifest
here (`io.github.Otto_Deviant1904.Amnesic.yml`) is a **draft that has never
been built** — flatpak-builder is not installed on the machine this was
authored on, so nothing below about build/run behaviour was executed.

The roadmap's rule for this task is explicit: _do not ship a silently-weaker
package._ Flatpak's sandbox model interacts with this app's tmpfs guarantee in
several non-obvious places, and until each is resolved the honest position is
that a Flatpak could quietly break the one claim the whole project rests on.

### Reachability note for this document

The authoring environment had network access only to a small allowlist
(github.com, raw.githubusercontent.com, and a few others). The Flatpak/Flathub
documentation hosts (docs.flatpak.org, docs.flathub.org) were **not reachable**,
so claims below are drawn from prior knowledge of how Flatpak/zypak/bwrap work
and are marked **[UNVERIFIED — confirm before shipping]** wherever they were not
checked against a reachable primary source. Do not treat an unverified claim as
settled.

---

## The three load-bearing questions

### (a) The Chromium sandbox: zypak changes "ships with the sandbox" into something else

Amnesic's charter position (ADR 0006, README sandbox note) is that it ships
**with** the Chromium OS sandbox on — it strips `--no-sandbox`, and on a kernel
that won't allow the userns sandbox it _fails closed_ rather than run hostile
content unsandboxed.

Inside a Flatpak sandbox that story does not translate directly:

- A Flatpak app runs inside **bwrap**, which has already put the app in a user
  namespace and, by default, blocks the app from creating **nested** user
  namespaces of its own. So Chromium _cannot_ build its normal userns sandbox
  the way it does from the raw AppImage. **[UNVERIFIED — confirm before
  shipping]**
- Flathub's answer for every Electron/Chromium app is **zypak**: a shim
  (`zypak-wrapper.sh`, `command:` in the manifest) that intercepts Chromium's
  sandbox/zygote machinery and redirects it onto the Flatpak sandbox and
  portals instead of Chromium's own SUID/userns helper. The isolation is then
  provided by **bwrap/seccomp at the Flatpak layer**, not by Chromium's
  in-process sandbox. **[UNVERIFIED — confirm before shipping]**

What this means for Amnesic's messaging is the important part:

> Under Flatpak, "we ship with the Chromium sandbox on" would be **false as
> written**. The truthful statement is "renderer isolation is provided by the
> Flatpak/bwrap sandbox via zypak, not by Chromium's own sandbox." Those are
> different trust stories with different threat surfaces. Shipping a Flatpak
> while keeping the AppImage's exact sandbox wording would be an overclaim —
> precisely the thing this project's brand forbids.

There is a second, subtler concern: the AppImage's fail-closed behaviour on
restricted-userns kernels is a _feature_ here (better to not start than to run
unsandboxed). Under zypak the app will happily start because bwrap is providing
the isolation — so the fail-closed signal the user relies on is gone, replaced
by a different guarantee they have not been told about. That substitution has
to be documented, not glossed. **[UNVERIFIED that zypak fully preserves
equivalent renderer isolation for this app — confirm before shipping]**

### (b) Where XDG dirs land, and whether the tmpfs redirect still holds

Two sub-questions, and the second is the one that could silently break the
core claim.

**Where XDG dirs land by default.** In a Flatpak, the per-app data/config/cache
dirs are redirected to `~/.var/app/<app-id>/` on the user's **real disk**:

- `XDG_DATA_HOME` → `~/.var/app/<id>/data`
- `XDG_CONFIG_HOME` → `~/.var/app/<id>/config`
- `XDG_CACHE_HOME` → `~/.var/app/<id>/cache`
- `XDG_STATE_HOME` → `~/.var/app/<id>/.local/state`

These are real, persistent, on-disk paths. **[UNVERIFIED exact paths — the
`~/.var/app/<id>/{data,config,cache}` layout is well-established Flatpak
behaviour but was not re-confirmed against docs here.]** For a normal app that
is fine; for an amnesic browser, _anything Chromium or the graphics stack
writes to `XDG_CACHE_HOME` by default would land on real disk_ — exactly the
residue this project exists to prevent.

**Does Amnesic's own tmpfs redirect still save it?** Amnesic doesn't rely on
the default `XDG_CACHE_HOME`. It **overrides it itself**: at startup it points
`XDG_CACHE_HOME` into a `/dev/shm/amnesic-browser-<pid>/xdg-cache` directory and
then _relaunches_ so the value is inherited by Chromium's zygote from birth
(ADR 0004, and ADR 0008 for why it's a manual `spawn`, not `app.relaunch()`).
It also `app.setPath('userData', …)` onto `/dev/shm`. So the app is not
depending on Flatpak's default cache location at all — it is trying to move
everything to tmpfs regardless of what the environment set.

Whether that holds inside Flatpak depends on **two things that were NOT
verified**:

1. **Does the relaunch bootstrap survive inside zypak/bwrap?** The bootstrap
   spawns `process.execPath` with an augmented environment and exits the
   parent. Under Flatpak the "exec path" is inside the sandbox and the process
   is already wrapped by zypak; whether a self-spawn-and-exit works the same way
   (and whether the second process re-enters through zypak correctly) is
   **[UNVERIFIED — confirm before shipping]**. Note ADR 0008 already documents
   that this exact bootstrap is fragile across packaging changes
   (`app.relaunch()` crashed under the AppImage FUSE mount and had to be
   replaced with a manual spawn). Flatpak is a _different_ packaging again — the
   ADR 0008 warning ("re-verify this bootstrap still survives a real packaged
   launch") applies directly and has not been done for Flatpak.

2. **Is `/dev/shm` inside the Flatpak sandbox actually tmpfs, and is it private
   to this app?** This is the crux. Options, none confirmed here:
   - If bwrap gives the app a **private, tmpfs `/dev/shm`** mounted fresh per
     sandbox, then the app's redirect lands in genuine RAM-backed storage that
     dies with the sandbox — the guarantee could hold, _possibly even better_
     than the AppImage (per-app isolation of the shm).
   - If `/dev/shm` inside the sandbox is instead **bind-mounted from the host**
     or is **shared** across the app's instances, the residue lifetime and
     visibility change and the "gone at process exit / gone at reboot" reasoning
     has to be re-derived.
   - If it is **not tmpfs** at all inside the sandbox, the core claim breaks
     silently — writes the app believes are in RAM would be on disk.

   **[UNVERIFIED — this is the single most important thing to confirm before
   any Flatpak ship. It must be checked empirically: build the Flatpak, run it,
   and `stat -f /dev/shm` + inspect `/proc/self/mountinfo` from inside the
   sandbox to confirm the filesystem type and backing, then run
   `scripts/verify_footprint.sh`-equivalent forensics against the host disk
   after exit.]**

Until (1) and (2) are both confirmed by a real run, a Flatpak build could pass a
casual smoke test while leaving cache residue on real disk — the exact
silent-weakening the roadmap forbids.

### (c) Portal-layer writes on real disk, outside the app's control

Even with a perfect in-sandbox tmpfs story, Flatpak itself writes state to real
disk that the app does not mediate:

- **The permission store.** When an app uses portals (file chooser, etc.),
  granted permissions are recorded in `~/.local/share/flatpak/db/` (the
  permission store, backing `org.freedesktop.impl.portal.PermissionStore`).
  These are real-disk writes made by the portal/`xdg-desktop-portal`
  infrastructure, not by Amnesic. **[UNVERIFIED exact path/behaviour — confirm
  before shipping]**
- **Flatpak's own bookkeeping.** Installation state, per-app metadata, and the
  `~/.var/app/<id>/` tree itself exist on real disk the moment the app is
  installed/run, independent of what the app writes. An empty
  `~/.var/app/<id>/` tree is itself a breadcrumb that the app was run.
- **Document portal.** If the file chooser portal is ever used, the document
  portal (`~/.local/share/flatpak/db/documents`, a FUSE-backed store) records
  handles to files the app was granted — real-disk metadata about user
  activity. Amnesic has no downloads feature in v1 (a non-goal) so this may not
  fire, but it is a portal-layer leak to keep in scope if downloads are ever
  added. **[UNVERIFIED — confirm before shipping]**

None of these are things the app's own cleanup routine can reach — they live
outside the sandbox, written by the portal/Flatpak layer. For a project whose
threat model is specifically about on-disk breadcrumbs, they must be enumerated
and judged, not ignored.

---

## Recommendation

**Do not publish a Flatpak until the following are resolved and verified on a
real build:**

1. **Confirm `/dev/shm` inside the sandbox is tmpfs and RAM-backed** (question
   b.2). This is non-negotiable — it is the core claim. Verify empirically from
   inside a running Flatpak, then run the footprint forensics against the host
   disk after exit. If `/dev/shm` is not genuine per-sandbox tmpfs, stop.

2. **Confirm the relaunch bootstrap survives under zypak/bwrap** (question b.1),
   per the ADR 0008 re-verification rule. If it doesn't, the Mesa/fontconfig
   cache gap ADR 0004 exists to close would reopen — silently.

3. **Rewrite the sandbox claim for the Flatpak build** (question a). The
   AppImage's "ships with the Chromium sandbox / fails closed" wording is false
   under zypak. Either ship different, accurate wording, or don't ship. Keeping
   the AppImage wording on a Flatpak is an overclaim and violates the project's
   honesty rule.

4. **Enumerate and accept (or reject) the portal-layer real-disk writes**
   (question c) in an ADR, the same way ADR 0006 enumerated every packaging
   deviation. `~/.var/app/<id>/`, the permission store, and the document portal
   are outside the app's cleanup reach.

5. **Reconcile the app ID.** electron-builder uses
   `io.github.ottodeviant1904.amnesic`; this draft uses
   `io.github.Otto_Deviant1904.Amnesic` (Flathub's hyphen→underscore
   normalisation of the GitHub owner). Pick one canonical ID.

My honest assessment: a Flatpak is **plausibly a good fit** — a per-app tmpfs
`/dev/shm` could even isolate the shm better than the bare AppImage — but it is
**not shippable on the strength of this investigation alone**. Every load-
bearing fact above is unverified, and at least one (b.2) can silently break the
core guarantee if wrong. The correct next step is a _test build on a machine
with flatpak-builder_, run through the project's own footprint verifier, before
any Flathub submission. Until then: **do not publish.**

## App ID

See the reconciliation note in item 5 above and the header of the manifest.
Flathub convention for a GitHub-hosted project without a custom domain is
`io.github.<user>.<repo>`, with hyphens in the username replaced by underscores
because Flatpak app-ID elements may not contain `-`. **[UNVERIFIED against
current Flathub docs — host unreachable here.]**
