# AppArmor profile for Amnesic

This directory ships an AppArmor profile (`amnesic-browser`) that grants
unprivileged user namespaces to the Amnesic binary on kernels that restrict
them by default.

## Why you might need this

The AppImage deliberately ships **without** `--no-sandbox` (see
`docs/adr/0006-packaging-and-distribution.md`). A browser renders hostile web
content, so running it outside the Chromium OS sandbox is not acceptable —
Amnesic uses Chromium's unprivileged user-namespace sandbox instead of the
SUID helper.

Some kernels lock unprivileged user namespaces behind an AppArmor policy and a
sysctl. On **Ubuntu 23.10+** the default is
`kernel.apparmor_restrict_unprivileged_userns = 1`: an unconfined process can't
create a user namespace, so Chromium can't build its sandbox and Amnesic
**refuses to start** rather than silently running unsandboxed. That fail-closed
behaviour is intentional. This profile is the fail-open exception, scoped to
exactly this one executable.

This is the **preferred fix** over relaxing the restriction system-wide with
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`, which grants userns to
every unprivileged process on the machine. The profile grants it to Amnesic
alone.

## The path problem (read before installing)

AppArmor attaches a profile by matching the **executable's path**. An AppImage
does not have one stable path: run directly, it FUSE-mounts its own squashfs
under a per-run directory such as `/tmp/.mount_amnesiXXXXXX/` and executes an
inner binary from there. That mount path changes every run, so there is nothing
fixed to name in the profile.

There are two ways to give AppArmor a stable path. They are not equally
reliable:

### Option A — extract once, target the inner binary (recommended)

Unpack the AppImage to a fixed location and run it from there:

```sh
./amnesic-browser-*.AppImage --appimage-extract
sudo mv squashfs-root /opt/amnesic-browser
```

Now the executable lives at a path that never changes between runs
(`/opt/amnesic-browser/AppRun`, which execs the packaged Electron binary). The
shipped profile targets this layout. Launch with:

```sh
/opt/amnesic-browser/AppRun
```

This is the reliable option: a fixed executable path means the profile attaches
deterministically every time.

### Option B — pin the .AppImage and match the outer runtime (less reliable)

Keep the single-file `.AppImage` at a fixed location and let AppArmor match the
AppImage runtime itself. The problem is that the process that actually needs
`userns` is the inner Electron binary running from the transient FUSE mount, so
the profile has to also cover that per-run mount path — which is only loosely
predictable and varies across AppImage runtime versions. The attach-by-path
guarantee is weaker here. **Prefer Option A.**

## Installing (Option A)

1. Edit the path in the `amnesic-browser` profile if you extracted somewhere
   other than `/opt/amnesic-browser`. The profile's attachment path is the
   `profile amnesic-browser /opt/amnesic-browser/{...}` line.

2. Copy it into the system profile directory and load it:

   ```sh
   sudo cp packaging/apparmor/amnesic-browser /etc/apparmor.d/amnesic-browser
   sudo apparmor_parser -r /etc/apparmor.d/amnesic-browser
   ```

3. Launch `/opt/amnesic-browser/AppRun`. Chromium should now build its sandbox
   and the app should start.

To check the profile is loaded:

```sh
sudo aa-status | grep amnesic
```

To remove it:

```sh
sudo apparmor_parser -R /etc/apparmor.d/amnesic-browser
sudo rm /etc/apparmor.d/amnesic-browser
```

## What was verified when this profile was written, and what wasn't

- **Syntax / compilation: VERIFIED.** The profile compiles cleanly with
  `apparmor_parser -Q` (AppArmor parser 4.1.7): exit status 0, no errors. `-Q`
  performs the full policy compilation and skips only the kernel load, so this
  confirms the `abi <abi/4.0>`, `include`, `profile`, and `userns` syntax is
  valid against a current parser. (The parser prints
  `Cache read/write disabled: interface file missing` — that is not an error;
  it only means the compiled-policy cache couldn't be written because the
  kernel's AppArmor securityfs interface isn't present. See below.)

- **Runtime enforcement: NOT TESTED — cannot be, on the machine this was
  authored on.** That machine is Arch-based with the AppArmor LSM **not loaded**
  in the kernel (`/sys/module/apparmor/parameters/enabled` reads `N` and
  `/sys/kernel/security/apparmor` does not exist). Without the LSM active, the
  profile cannot be loaded, attached to a process, or observed granting
  `userns`. The whole point of this profile — that a confined process gets
  userns where an unconfined one on a restricted kernel would not — was
  therefore **never exercised end to end**. It needs a real Ubuntu 23.10+ (or
  other userns-restricting) system to confirm:
  1. the profile loads with `apparmor_parser -r`;
  2. it attaches to the running binary (check `aa-status`);
  3. Amnesic actually starts and builds its sandbox where it previously failed.

- **The attachment path is a placeholder.** `/opt/amnesic-browser/...` is a
  suggested fixed location, not something the packaging enforces. Whoever
  installs this must make the on-disk path and the profile's path agree.

Treat this profile as a correct-by-construction starting point that has been
syntax-validated but not enforcement-tested. Do not describe it as a tested
guarantee until someone has run steps 1–3 above on a restricting kernel.
