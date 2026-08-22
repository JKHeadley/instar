# Side-effects review — codex startup-menu session death

**Change:** interactive codex sessions died ~18s after spawn. Three fixes:
a selector-glyph asymmetry in the readiness probe (the root cause), an
update-prompt suppression flag on the codex interactive launch (prevention),
and a footer added to the persisting-menu detector (visibility).

**Files:**
- `src/core/claudeReadinessProbe.ts`
- `src/core/frameworkSessionLaunch.ts`
- `src/monitoring/PermissionPromptAutoResolver.ts`
- `src/core/SessionManager.ts`

**A fourth fix was added mid-review, and the reason is the most important
finding here.** The first three were written believing the probe fix stopped
the fatal Enter. Tracing the CONSUMER rather than trusting the label falsified
that: `handleReadyAndInject`'s not-ready branch blind-injects whenever the pane
is merely alive, so refusing at the ready check only RELOCATED the same Enter
to the timeout branch. Codex's update menu would still have killed the session
— at ~90s instead of ~18s — and the trust prompt would still have been
auto-answered. A delayed identical outcome is not a fix, so the timeout branch
now consults `classifyPaneState` and refuses on `menu`.

**Tier:** 1. Risk floor 1 — at the floor, not below it. Reversible by revert,
no migration, no new capability, no stored state. The size signal suggested
Tier 2 on raw LOC, but the great majority of the diff is explanatory comment
recording the incident; the executable change is one shared glyph set, one
launch flag, and one regex.

---

## 1. Over-block — what legitimate input does this now reject?

The widened menu test could, in principle, classify a genuinely-ready pane as
a menu and stall the inject path. It does not, because the discriminator was
never the glyph alone: `tailShowsMenu` still requires the glyph to sit **on a
numbered option line** AND at least **two** numbered option lines. Codex's
ready pane leads a line with `›` (`› Ask Codex to do anything`) and has no
numbered options, so it still classifies `ready`.

Verified against the literal pane text of a live codex 0.149 session, which
is committed as a test fixture (`CODEX_READY_PANE`) precisely so this
over-block question stays answered as codex's TUI drifts. A single `›`-led
numbered line is also covered — one numbered line is ordinary output, not a
menu, and the test asserts it.

The consequence of a hypothetical over-block is a delay, not a loss: the
inject path waits and then blind-injects if the pane is still alive. The
consequence of the under-block it replaces was a dead session. The asymmetry
favours this change.

A second over-block surface arrives with fix #4: a pane the probe calls `menu`
no longer receives its initial message at all. That is intended, and its loss
risk is closed by the retained pending-inject record (see §4b). The
over-correction guard — a still-painting pane must STILL be blind-injected — is
asserted by a committed test, because disabling that fallback wholesale would
have traded this defect for message loss on every slow-booting session.

**One real behaviour change belongs here, found by probing rather than
reasoning.** Codex has a SECOND blocking startup menu — the trust-directory
prompt (`› 1. Yes, continue / 2. No, quit / Press enter to continue`), which
fires when the working directory is not in codex's trusted-projects list. It
was previously misread as ready too, so an arriving user message plus Enter
would have selected `Yes, continue` — answering a **trust** decision on the
operator's behalf, which is the exact harm this module's header names. It now
classifies `menu`, so such a session waits for a real answer and Layer 3
reports it.

That is the correct trade and it is deliberate: a trust decision is the
operator's, not something an arriving message should settle by accident. It is
recorded as a behaviour change rather than a pure win because a codex session
in an UNTRUSTED directory now stalls where it previously proceeded. Instar
agent homes are trusted in `~/.codex/config.toml`, so the normal path is
unaffected. The prompt is committed as a second test fixture.

## 2. Under-block — what does this still miss?

The prose-agnostic shape test was checked against a menu it was not designed
from: codex's trust-directory prompt (different wording, same structure) is
caught with no additional code, which is the property that makes this a class
fix rather than a one-menu patch.

What remains missed: a codex (or other-framework) menu that uses a **third**
glyph not in `SELECTOR_GLYPHS`, or that renders options in a shape
`MENU_OPTION_RE` does not match (e.g. lettered options, or grok's `N (●) label` radio shape, which
the resolver knows but this probe does not). Both remain misreadable as
ready.

This is a genuine residual and is stated rather than closed. It is bounded by
the same property that made this incident survivable to diagnose: the failure
is loud (a dead pane), not silent. The module's header already carries the
standing tracked item for a canary that would detect the *next* drift rather
than the two shapes that already bit us (CMT-1044) — this change does not
close that, and does not claim to.

Prevention #2 (the launch flag) narrows the practical exposure considerably:
the specific menu that fires on **every** codex spawn is no longer drawn at
all, so the residual is limited to menus codex raises mid-session.

## 3. Level-of-abstraction fit

Correct layer, and this is the load-bearing judgement of the review.

The root-cause fix belongs in `claudeReadinessProbe` because that module owns
exactly one question ("can I type here?") and already owns the menu-vs-ready
distinction. Fixing it at the caller (SessionManager) would have put a
framework-specific special case in the spawn path and left every other
consumer of the probe — `waitForClaudeReadyWithRetry`, the Slack stuck-session
path — still wrong.

The launch flag belongs in `frameworkSessionLaunch` for the same reason: it is
the single funnel that builds codex argv, so both fresh and resume launches
inherit it without either callsite knowing about it.

The Layer-3 footer belongs in the resolver because that module owns "a menu
persisted and nobody cleared it". Teaching the probe to *report* stuck menus
would have duplicated an existing detector.

Explicitly considered and rejected: writing `check_for_update_on_startup`
into `~/.codex/config.toml`. That file is SHARED by every codex agent on the
machine; instar must not mutate it. Passing `-c` per launch confines the
change to instar-spawned panes.

## 4. Signal vs authority compliance

Compliant, and the compliance is the reason one obvious "fix" was rejected.

- `claudeReadinessProbe` is a **pure classifier** — text in, verdict out. It
  holds no authority; each caller applies its own policy, which is why the
  module returns three states instead of a boolean. Widening its glyph set
  changes what it *reports*, never what it *does*.
- `detectPersistingMenu` (Layer 3) is **observability only** — its sole
  actuation is raising an Attention item. Adding a footer widens what it can
  see; it presses no key.
- The launch flag is a **launch-time argument**, not a runtime decision point.

The rejected option is the instructive one. `PermissionPromptAutoResolver`
Layer 2 *does* hold actuation authority (it presses Enter), and teaching it
this menu was deliberately **not** done. On this menu the focused default runs
`npm install -g @openai/codex` and exits codex, so an auto-Enter here IS the
defect. This is the same reasoning already recorded in that file for grok:
"an answer whose meaning depends on where a cursor happens to rest is not a
safe default, and here the cursor rests on the irreversible one." Layer 2's
codex signature stays absent.

## 4b. The inject-path refusal (fourth fix)

`handleReadyAndInject`'s timeout branch now calls `classifyPaneState` and
returns without injecting when the pane is a `menu`.

**Why this caller and not the boolean.** `classifyPaneState` was built for
exactly this shape of caller — the module documents it as "for callers whose
not-ready branch is DESTRUCTIVE." Blind-injecting into a menu is destructive in
the precise sense that matters: Enter does not lose the message, it SELECTS an
option. On codex's update menu that option exits the process; on its trust
prompt it grants directory trust. This branch had been reading a boolean that
cannot distinguish "still painting" from "waiting on a question."

**Message delivery — the risk this introduces, stated precisely.** Refusing to
inject could drop the user's first message. It is not dropped SILENTLY, and the
exact strength of that claim was checked rather than assumed:

- The durable pending-inject record is deliberately left INTACT (the inject
  path clears it only after an inject actually runs). The absent `clear()` call
  is the load-bearing part.
- `recoverPendingInjects` is called from `server.ts` at BOOT — it is not a
  menu-clear watcher. So the record is re-delivered on the next server boot if
  the pane is still alive and the record is under its 6h expiry, and REPORTED
  via `DegradationReporter` otherwise.
- Immediate visibility comes from the `DegradationReporter` entry this branch
  emits, plus the Layer-3 defect for the parked menu itself.
- The practical recovery is the bridge's existing respawn on the next inbound
  message.

An earlier draft of this review claimed re-delivery "once the menu clears."
That was wrong, and tracing the caller is what caught it. The honest guarantee
is narrower and still worth having: the message is never typed into a menu, and
its non-delivery is never silent.

**Over-correction guard.** The timeout branch exists for genuine
prompt-detection false negatives and must keep working for them. A committed
test asserts a merely-unrecognised pane (still painting, no menu, no prompt) is
STILL blind-injected. Only `menu` is refused; `not-ready` is untouched.

**Signal vs authority.** The refusal consults a pure classifier and declines to
act. It adds no blocking authority over anything else, and its failure mode is
a retained message plus a reported degradation — not a lost one.

## 5. Interactions

- **Probe ↔ inject path:** the intended interaction, and the one that had to
  be traced rather than assumed. `isReadyPromptTail` now answers `false` for
  this pane, so `handleReadyAndInject` waits instead of typing. On timeout it
  previously took the "alive but not ready → blind inject" branch and pressed
  the same fatal Enter ~75s later; fix #4 closes that branch against menus. Fix
  #2 additionally removes the update menu from the fresh-spawn path entirely,
  so the two prevention layers are independent rather than co-dependent.
- **Probe ↔ Slack stuck-session path:** that caller kills on not-ready, and
  is documented as needing `classifyPaneReadiness` rather than the boolean so
  it leaves a `menu` pane alone. This change moves codex menus from `ready`
  into `menu` — i.e. into the state that caller is already required to treat
  as "do not kill". Strictly safer for that consumer.
- **Layer 2 ↔ Layer 3:** unchanged. Layer 3 fires only on menus Layer 2 did
  not clear; since Layer 2 has no codex signature, a codex menu was always
  Layer 3's to report. It simply could not see the bottom of one before.
- **Double-fire:** none. Layer 3 dedups on a digest of option labels and has
  a persistence threshold; one stuck menu yields one defect.
- **Shadowing:** the launch flag makes the probe fix unreachable for *this*
  menu on a normal spawn. That is redundancy by intent, not shadowing — the
  probe fix covers menus the flag does not suppress, and the flag covers the
  window before any probe runs.

## 6. External surfaces

- **Visible to the operator:** codex panes spawned by instar no longer show
  the update prompt. `codex update` is unaffected; a codex session started by
  hand outside instar is unaffected. Documented in the ELI16.
- **Visible to other agents:** every instar agent that spawns codex
  interactively inherits both fixes on upgrade. That is the intent — the
  defect is fleet-wide.
- **Timing dependence:** reduced, not added. The old behaviour raced the
  readiness probe against codex's menu paint; the new behaviour removes the
  menu from the fresh-spawn path entirely.
- **Unknown-key tolerance verified, not assumed.** A codex launched with a
  deliberately bogus `-c totally_bogus_key_xyz=false` starts normally, so a
  codex build predating `check_for_update_on_startup` will not be broken by the
  flag. This was the main version-compatibility risk of prevention #2 and it was
  tested rather than argued.
- **Upstream dependence:** `check_for_update_on_startup` is codex's own
  config key. If codex renames or removes it, `-c` on an unknown key is the
  failure mode to watch; the probe fix is the backstop that keeps the session
  from *dying* in that case, which is exactly why both halves ship together.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, for a concrete reason: both fixes act on a tmux
pane that exists on one machine's disk, spawned by that machine's
SessionManager, running that machine's codex binary. There is no state to
replicate and no cross-machine read to merge — the probe is a pure function
over a local capture, and the launch flag is an argv element.

Consequences checked:
- **No one-voice concern.** Neither change emits a user-facing notice. The
  Layer-3 defect it enables routes through the existing Attention surface,
  which already owns dedup and one-voice gating.
- **Nothing strands on topic transfer.** No durable record is written by
  either fix.
- **No generated URLs.**
- **Version skew is benign and asymmetric in the safe direction.** A machine
  on the old version keeps the old (fatal) behaviour until it upgrades; a
  machine on the new version is fixed. Neither machine's behaviour depends on
  the other's version, so a partially-upgraded pool degrades per-machine
  rather than incoherently.

## Framework generality

Standard: `docs/STANDARDS-REGISTRY.md` → "Framework-Agnostic — and
Framework-Optimizing". The two source changes sit on opposite sides of that
standard, deliberately, and each is on the correct side.

**The probe fix is framework-GENERAL, and that is the point of its shape.**
The defect existed precisely *because* a framework-specific assumption
(`❯` = Claude Code) had been baked into one half of a module that serves every
framework. The fix does not add a codex branch; it replaces a hardcoded glyph
with a shared `SELECTOR_GLYPHS` set consulted by BOTH the menu test and the
ready test. Adding a third framework's cursor is now a one-line addition to
one list that automatically stays consistent across both tests — which is the
property whose absence caused this incident. `classifyPaneReadiness` takes no
framework parameter and needs none: it discriminates on menu *shape* (glyph on
a numbered option line, two or more options), not on framework identity.

Verified across frameworks in the committed tests: the codex menu classifies
`menu`, the same menu rewritten with Claude's `❯` also classifies `menu`
("neither glyph is special"), the Claude input box still classifies `ready`,
and codex's real ready pane still classifies `ready`.

Known generality limit, stated rather than glossed: grok-build's radio menu
shape (`N (●) label`) is recognised by `PermissionPromptAutoResolver` but not
by this probe's `MENU_OPTION_RE`. That predates this change and is unchanged
by it — this change neither closes nor worsens it — but it is the honest
answer to "is this correct for ALL frameworks": for glyph-led numbered menus,
yes; for grok's radio shape, the probe was and remains shape-blind.

**The launch flag is deliberately framework-SPECIFIC, and correctly scoped.**
`check_for_update_on_startup` is codex's own config key; it is meaningless to
Claude Code, gemini-cli, pi-cli and grok-build. It is emitted only from
`codexCliBuilder`, so it can only ever reach a codex argv — the builder table
is exactly the framework abstraction this standard asks changes to route
through, and a test asserts a Claude launch carries no codex config key. This
is the "framework-optimizing" half of the standard, not a violation of the
"framework-agnostic" half: each framework's builder owns that framework's
launch specifics, which is why per-framework builders exist.

The headless `codexCliHeadlessBuilder` was deliberately left alone: `codex
exec` has no TUI to draw a blocking menu in, so adding the flag there would
have shipped an unverified change to a path with no demonstrated defect.

**Does the fix generalise to the NEXT framework that does this?** Partly, and
the split is worth being precise about. If gemini-cli or pi-cli ships a
glyph-led numbered startup menu using a cursor already in `SELECTOR_GLYPHS`,
the probe catches it with no code change and the session survives. If it uses
a new cursor, the probe does not — the residual recorded under "Under-block".
No framework inherits the *prevention* half automatically; each would need its
own equivalent of the codex flag, which is correct, because each vendor's
opt-out is its own.

## 8. Rollback cost

Near-zero. `git revert` of the commit restores prior behaviour exactly. The
inject-path refusal (fix #4) is a single conditional with an early return; the
pending-inject store it relies on already existed and is unmodified, so a
revert leaves no orphaned state. No
data migration, no agent-state repair, no config written to disk, nothing
persisted by either change.

Partial rollback is also available and worth naming, because the two halves
are independent: dropping only `CODEX_NO_UPDATE_PROMPT_FLAGS` restores the
update prompt while keeping sessions alive (they stall visibly instead of
dying); dropping only the glyph change re-opens the death for any codex menu
the flag does not suppress. If one half has to go, keep the glyph fix — it is
the one that prevents the fatal outcome.

---

## Second-pass review (Phase 5)

**Not run — and this is a declared gap, not an omission.**

This change touches session lifecycle (spawn) and a module named
`...AutoResolver`, so Phase 5's independent-reviewer trigger applies on
subject matter. It was not run because this session carries a standing
operator directive not to spawn subagents unless explicitly requested, and
fabricating a reviewer concurrence that no reviewer produced would be worse
than declaring the gap.

The trace records `secondPass: false` and `reviewerConcurred: null`
accordingly — the record is truthful rather than convenient. The Tier-1 lane's
own compensating control (the causal autopsy, per the gate's Step 4.55
rationale: "Low-ceremony lanes (Tier-1) ship without an independent
reviewer") is supplied in the trace.

The operator can request the independent pass in one word, and it will be run
before merge.
