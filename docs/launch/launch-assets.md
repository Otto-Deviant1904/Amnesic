# Launch assets — v0.3.0

Prepared copy for the owner to post. **Rules** (from the roadmap): time the
push to the v0.3.0 (Tor) release, one submission per venue, never
buy/trade stars, never astroturf. Post the first comment yourself,
immediately, linking the threat model and ADRs preemptively.

Pre-flight checklist before posting anywhere:

- [ ] v0.3.0 tag pushed, CI green, release published (not draft), SHA256SUMS attached
- [ ] README landing-page version live on master (GIF renders, badges green)
- [ ] `good first issue` labels applied (see `good-first-issues.md`)
- [ ] AUR package published, or the README's install section doesn't promise it

---

## Show HN

**Title** (80-char limit; this is 79):

> Show HN: A browser that forensically proves its own amnesia (fail-closed Tor)

Fallback if that reads too clever on the day:

> Show HN: Amnesic – a Linux browser verified to leave zero disk footprint

**Text:**

> Amnesic is a Linux browser (Electron/Chromium) built around one narrow,
> verifiable promise: nothing recoverable is left on disk once the process
> exits. Instead of trusting deletion code, CI proves it empirically on
> every push — a scripted session deliberately tries to persist data
> through every mechanism in the threat model (cookies, LocalStorage,
> IndexedDB, Cache API, service workers, a forced download), the app
> exits, and a filesystem diff must come back clean. The verifier is the
> interesting part: its first real runs falsified the claim (tmpfs residue
> surviving exit, Mesa/fontconfig caches escaping to real disk) and those
> fixes are documented in the ADRs. v0.3.0 adds opt-in, fail-closed
> SOCKS5/Tor routing — an unreachable proxy fails navigation closed rather
> than silently going direct — plus a DNS-over-HTTPS toggle.
>
> Equally important is what it doesn't claim: it is not an anonymity tool
> (no anti-fingerprinting — Tor Browser is still the right tool for that),
> it can't stop OS swap from leaking page content (it warns instead), and
> live RAM forensics beats every browser. The threat model documents each
> limit with the same prominence as the features, and the start page's
> self-audit panel distinguishes "checked at runtime right now" from
> "enforced by CI" rather than faking runtime checks. I'd genuinely value
> scrutiny of scripts/verify_footprint.sh — if the verifier has a blind
> spot, the claim does too.

**First comment (post immediately after submitting):**

> Author here. Before anyone asks "how is this not snake oil" — the docs
> that answer that are the threat model
> (https://github.com/Otto-Deviant1904/Amnesic/blob/master/docs/threat-model.md),
> which lists what is NOT protected (fingerprinting, RAM, swap,
> localhost-bypass under Tor mode — that last one confirmed empirically,
> not assumed), and the ADRs
> (https://github.com/Otto-Deviant1904/Amnesic/tree/master/docs/adr),
> which include the wrong turns: a dead Chromium flag we almost shipped, a
> preload-script mitigation that was a silent no-op due to context
> isolation, and the verifier catching real residue. Happy to answer
> anything, especially "what breaks the guarantee."

---

## r/privacy

**Title:**

> I built a Linux browser whose "leaves nothing on disk" claim is verified by a filesystem diff in CI — and the threat model lists everything it can't protect you from

**Body:** reuse the Show HN text, plus this closing paragraph (r/privacy is
rightly hostile to overclaiming — lead with the limits):

> To be explicit about what this is NOT: not an anonymity tool, not a Tor
> Browser replacement (no fingerprinting protection — using Tor mode here
> makes you a non-uniform Tor user), not protection against a live
> attacker on your machine, and not able to stop the OS from swapping
> page content to disk. It solves one problem: local forensic residue
> after a clean exit. If your threat model is anything else, the threat
> model doc says which tool to use instead.

## r/linux

**Title:**

> Amnesic Browser — a Linux-only browser that proves, via filesystem diff in CI, that it leaves nothing on disk after exit

**Body:** Show HN text, plus a Linux-specific paragraph:

> Linux-specific bits that made this possible/fun: userData lives in a
> per-pid dir on /dev/shm (tmpfs), XDG_CACHE_HOME is redirected inside it
> so Mesa's shader cache and fontconfig can't escape to ~/.cache (env has
> to be set via a relaunch bootstrap — Chromium's zygote forks before
> main-process env mutations can matter), the single-instance lock is a
> unix socket on tmpfs instead of Electron's real-disk lockfile, and the
> AppImage ships WITH the Chromium sandbox (most Electron AppImages inject
> --no-sandbox; this one refuses to start unsandboxed, with an AppArmor
> profile provided for Ubuntu 23.10+'s userns restrictions).

## Lobsters

Tags: `security`, `privacy`, `linux`. Submit the repo URL (or the blog
post once published — prefer the blog post if it's live; Lobsters favors
write-ups over repo links).

**Title:**

> A browser that forensically proves its own amnesia: filesystem-diff verification of a zero-disk-footprint Chromium browser

No text field needed; post the first-comment content (above) as a comment
if questions come.

---

## Timing and sequencing

1. Publish the blog post (`docs/blog/zero-footprint-browser.md`) on the
   personal blog / dev.to first — HN and Lobsters both convert better with
   a write-up behind the link, and the repo README links to it.
2. Show HN: Tuesday–Thursday, 14:00–16:00 UTC is the conventional window.
   Submit once; do not resubmit on a flop (HN allows a second attempt
   after some weeks — that's a later decision, not a launch-day one).
3. Lobsters same day or the day after (different audience, fine to
   overlap). Reddit posts can trail by a day or two.
4. Watch the repo issues for launch-day reports; a fast, honest response
   to the first hostile technical comment is worth more than the
   submission text.
