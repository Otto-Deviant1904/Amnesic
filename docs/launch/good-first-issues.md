# `good first issue` drafts

Six genuinely approachable issues for the owner to file and label
`good first issue` before launch (creating GitHub issues is a remote
action — owner executes). Each is scoped so a newcomer can land it without
touching the guarantee-bearing code, and each says which gate applies.

---

**1. Add `Ctrl+Shift+T`-style "duplicate tab" shortcut (`Ctrl+Shift+D`)**
Open a new tab with the current tab's URL. Renderer-side shortcut in
`App.tsx`'s keydown listener plus a context-menu entry. No session or
storage surface touched. Gate: full quality gate must pass (it will —
this is UI-only). Note for the implementer: "reopen closed tab" is
deliberately impossible here (that would be history), which is why this is
duplicate, not reopen.

**2. Start-page polish: keyboard focus order and `Enter` behavior**
On the start page, the address bar should be focused on open (it is), but
Tab order between the self-audit panel's "Re-check" button and the
dismissible swap warning is untested and visually unindicated. Add
`:focus-visible` styles consistent with the shell design language.
Frontend-only.

**3. Show zoom level in the tab tooltip**
Tabs show a zoom chip in the address bar when zoom ≠ 100%, but hovering a
background tab tells you nothing. Add zoom (when ≠ 100%) to the tab's
`title` tooltip. Small renderer change; the value already flows over IPC.

**4. Document every shortcut in one place and add a `?`-style shortcut overlay**
The README table and the two keydown listeners (main's
`handleShortcut()`, renderer's `App.tsx`) can drift. Add a
`Ctrl+/`-triggered in-shell overlay listing shortcuts, sourced from one
shared constant. Bonus: a unit test asserting the README table matches
the constant. No new capabilities, shell-only.

**5. Improve the "download blocked" notice with the blocked filename**
The transient notice currently says a download was blocked; include the
filename (from the `will-download` item) so users know what the page
attempted. Filename must be treated as untrusted text (no HTML injection
into the shell). Touches the notice plumbing only — the `preventDefault()`
in the handler must not move; `scripts/verify_footprint.sh` will catch a
regression.

**6. CONTRIBUTING.md improvements from a fresh-clone experience**
Follow CONTRIBUTING.md on a fresh machine and file/fix everything that's
wrong or missing (e.g., the xvfb-run requirement for local e2e, Node
version). Docs-only; great first exposure to the quality gate.

---

Labels to create: `good first issue`, plus `guarantee-adjacent` for #5 (a
reviewer must check the verifier still passes — it runs in CI anyway).
