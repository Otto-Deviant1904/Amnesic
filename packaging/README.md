# Packaging

Distribution artifacts and the honest caveats that come with each. The
governing decisions are in `docs/adr/0006-packaging-and-distribution.md`; this
directory holds the concrete packaging inputs.

## Contents

- **`aur/`** — Arch User Repository `amnesic-browser-bin` PKGBUILD (unpacks the
  released x86_64 AppImage). Shipped.
- **`apparmor/`** — AppArmor profile granting unprivileged user namespaces to
  Amnesic on kernels that restrict them (Ubuntu 23.10+), so Chromium's sandbox
  can work without disabling it system-wide. Syntax-validated with
  `apparmor_parser -Q`; **not** enforcement-tested (the authoring machine had
  no AppArmor LSM loaded). Preferred over the system-wide sysctl. See its
  README.
- **`flatpak/`** — An **investigation**, not a shipped package. Draft manifest
  (never built) plus a document on how Flatpak's sandbox interacts with the
  "nothing recoverable on disk" guarantee. Current recommendation: **do not
  publish a Flatpak** until the tmpfs-`/dev/shm`, relaunch-bootstrap, and
  sandbox-wording questions are resolved on a real build. See its README.

## CI release architectures

`.github/workflows/release.yml` builds a Linux AppImage for **x86_64** and
**arm64** on a tag push (matrix over `ubuntu-latest` and the free
`ubuntu-24.04-arm` hosted runner), each behind the full quality gate, then
combines them into one draft release with a single `SHA256SUMS`.

**The arm64 leg is UNTESTED until the first tag push.** The `ubuntu-24.04-arm`
runner label and electron-builder's arm64 AppImage output could not be
exercised in the environment the workflow was written in. The x64 leg is
unchanged from the previous single-job workflow. If the first arm64 release
fails, that is the leg to look at; the workflow comments explain the intended
behaviour. The AUR package remains x86_64-only until an arm64 release exists to
point it at.
