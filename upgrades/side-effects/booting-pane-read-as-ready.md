# Side-Effects Review — a startup banner, and a startup menu, were read as an input prompt

**Version / slug:** `booting-pane-read-as-ready`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent — VERDICT: CONCERN. Design changed in response; see Phase 5.`

## Summary of the change

`SessionManager.detectClaudePrompt` decided a pane was accepting input if the last
six non-blank lines contained `❯`, `›`, `bypass permissions`, `/(effort|model|fast)`,
or `(low|medium|high) · /effort`. Two independent defects:

**1 — the banner.** The slash-command clause matched a bare mention **anywhere, in
any context, including prose**. Claude Code's startup banner advertises slash
commands in prose; the incident pane carried:

> `…Fable 5 draws down usage faster than Opus 4.8. Run /model and`
> `select Fable to use it. Learn more: https://support.claude.com/…`

**2 — the menu (found by the operator).** Claude Code paints the **same `❯`** on a
menu's focused option that it uses for the input box. A session sitting on a
startup question therefore read as READY. This is strictly worse: text typed at a
banner is lost, but **Enter at a menu SELECTS AN OPTION**, so an arriving message
can answer a permission question on the operator's behalf.

**Observed (topic 29723, 2026-07-26).** Inbound `17:44:49Z` → respawn → pointer
injected `17:45:00Z` → that session's start hook completed `17:45:15Z`. The paste
landed 15s early, was swallowed by the redraw, and the injector logged
`Injected initial message into "…" (915 chars, after stabilization delay)` — a
success line for a delivery that did not happen. The message reached the agent only
via the start hook's unanswered-message backstop, an unrelated path.

**The slash-command clauses are DELETED, not tuned.** The first attempt kept them
and required "status-bar shape" (line-start or post-interpunct). Second-pass review
falsified that, and I verified each claim before accepting it:

| falsifying input | verdict under the "shape" fix |
|---|---|
| `⚠ Fable 5 promotional access ends soon · /model to opt in` | `ready` (false positive) |
| `  · /model to switch between Opus and Fable` | `ready` (false positive) |
| soft-wrapped banner putting `/model` at column 0 | `ready` (false positive) |
| `opus 5 • medium • /effort` (bullet separator) | not ready (false negative) |

The artifact's own fixture contains `· /memory to free up context` and
`+1 more · /status` — **banner** lines in the exact shape it claimed prose never
uses. So discrimination was still vocabulary wearing structure's clothes, and the
line-start branch reinstated the Anthropic-copy dependency it claimed to remove
(at a fixed pane width, a copy edit shifting the wrap ~14 chars recreates the
original defect). A signal that cannot separate an *advert for* a command from a
*status bar showing* one carries no readiness information. Deleted, and the
genuinely structural markers widened instead.

**The answer is no longer a boolean.** See §1 — one of three consumers KILLS a live
session on not-ready. `classifyPaneReadiness` returns `ready | menu | not-ready`;
`isReadyPromptTail` is retained as the façade for callers that only want "can I
type now".

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `❯` / `›` present (and not on an option line) → ready | `invariant` | Deterministic substring test. |
| permission-mode / shortcut footer present → ready | `invariant` | Widened from one marker to four, sourced from the probes already trusted for this (`SessionReaper`, interactive-pool config) rather than invented here. |
| selector glyph ON a numbered option line + ≥2 options → menu | `invariant` | Deterministic shape test, mirroring `PermissionPromptAutoResolver`'s existing definition rather than a second divergent one. |
| slash-command mention → ready | **REMOVED** | Could not distinguish advert from status bar in any formulation tried. |
| consent-dialog auto-accept | `invariant` | Unchanged, and deliberately left in `SessionManager` — it has a side effect (`send-keys`), so it does not belong in a pure classifier. Verified still running BEFORE the classifier and over all 20 captured lines. |

No judgment points. No model call.

## 1. Over-block

**The risk is not uniform across callers, and the first draft of this section was
wrong about that.** There are three consumers:

1. `waitForClaudeReadyWithRetry` → `handleReadyAndInject` (spawn/inject). Failure
   direction: waits, then the pre-existing extended-wait and blind-inject-if-alive
   fallbacks apply. Safe.
2. `waitForClaudeReady` direct, in the Slack stuck-session path (`server.ts:8395`).
   **Failure direction: it KILLS the live session and respawns.** A tightened probe
   that false-negatives here destroys a live conversation. `docs/signal-vs-authority.md`
   names session lifecycle as explicitly high-risk.
3. `classifyPaneState` (new), used by (2) to tell `menu` from `not-ready`.

**Mitigations, both required by the above:**
- The positive marker set was **widened**, not just narrowed: `? for shortcuts`,
  `shift+tab to cycle`, `auto-accept edits` join `bypass permissions`. Previously
  only one of Claude Code's three permission-mode footers was recognised, so a
  session in auto-accept mode depended entirely on `❯` being visible. That
  assumption is no longer load-bearing. All four are asserted absent from the
  banner fixture, so the widening costs no false positives.
- The Slack path no longer kills on `menu`. It gives the always-on auto-resolver a
  bounded second window and re-checks; a menu that never clears falls through to
  the pre-existing stuck path, so no message is lost.

**Residual, stated honestly:** a status bar using a separator other than U+00B7 (`•`,
box-drawing) and showing none of the four footers and no `❯` would now wait. I have
not enumerated every Claude Code rendering across widths and themes. On caller (1)
that costs a delay; on caller (2) the menu carve-out plus the widened footers are
what keep it from costing a session.

## 2. Under-block

**Injection still reports success on having TYPED, not on arrival.**
`verifyInjection` recovers a swallowed *submit*, not a swallowed *paste*. A pane
that becomes ready and then stalls mid-paste still produces a success log for a lost
message. Deliberately **not bundled** — it changes the injector's success criterion
at every inject callsite, and folding it in would make this PR's refusal evidence
ambiguous. Recorded as a candidate, not silently deferred.

Also untouched: the probe reads the last 6 of 20 captured non-blank lines. A banner
longer than that window pushing a real prompt out of view still reads not-ready.
Unchanged behaviour; fails toward waiting on callers (1) and (3).

The menu detector requires ≥2 numbered options. A single-option prompt, or a
free-text startup question with no numbered options, is not detected as a menu.

## 3. Level-of-abstraction fit

One pure function, no state, no I/O, below `SessionManager`. The consent-dialog
branch stayed behind because it presses keys — a classifier that mutates the pane is
not a classifier.

**A smarter component already exists and was consulted rather than duplicated.**
`PermissionPromptAutoResolver` owns approval-prompt handling (matching, auto-answer,
audit). This probe deliberately reuses its notion of a menu (selector glyph on a
numbered option line) instead of inventing a second one, and does not attempt to
answer prompts — it only declines to call a menu an input surface.

Callers of the removed clause: exactly one, verified independently by grep. No
duplicate site left holding the old semantics.

## 4. Signal vs authority compliance

**The first draft's answer here was materially incomplete and is corrected.** It
claimed the probe "cannot block a message, refuse an action, or reach a user". False
via §1(2): a not-ready verdict at `server.ts` refuses an action and kills a session.

The *principle* is not violated — `docs/signal-vs-authority.md` scopes it to
brittle logic making judgments about **meaning**, and exempts deterministic
invariants. This is mechanics (is a glyph on screen), not meaning. But the honest
statement is: **this probe feeds a destructive authority**, which is exactly why the
verdict was widened from a boolean to a named state, so that authority can
distinguish "wedged" from "waiting on an answer" instead of treating both as kill.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points introduced. The change moves *away* from a vocabulary match whose
behaviour drifts as Anthropic edits its banner copy, toward structural markers. Note
the correction to the first draft: the intermediate "status-bar shape" design did
**not** achieve that and claimed it anyway — the claim is retracted above rather
than quietly restated.

## 5. Interactions

- **`waitForClaudeReadyWithRetry` / `handleReadyAndInject`** — unchanged; both now
  consult the corrected probe. A pane that used to pass early on the banner now
  passes on the input box instead: later, and correctly.
- **`server.ts` Slack stuck-session path** — changed, see §1.
- **`PermissionPromptAutoResolver`** — complementary, not shadowed. It clears
  prompts; this declines to type at them. The Slack carve-out explicitly depends on
  it running (it is an always-on floor with no enable flag).
- **`StuckInputSentinel`, `SessionWatchdog`, `PromptGate`, `PresenceProxy`,
  `SessionReaper`, `TriageOrchestrator`, `anthropic-interactive-pool`** — each keeps
  its own independent markers for its own question ("is it stuck?", "is it idle?").
  None imports `detectClaudePrompt`; none carried the removed clause. Their marker
  vocabulary is now the *source* for this probe's footers rather than a fourth
  divergent set.
- **`ModelSwapService`** injects literal `/model <id>` into live panes — a real
  in-pane source of the removed token. Another reason the clause had to go.
- **Codex / Gemini / pi panes** — the `›` clause is unchanged; they do not print the
  Claude banner.

## 6. External surfaces

None. No route, no config key, no CLI flag, no message text, no state file. Two new
exported functions and one new public method on `SessionManager`, all internal.

## 6b. Operator-surface quality

One new log line when the Slack path declines to kill a session on a menu, naming
the session and the reason. The pre-existing failure lines are unchanged.

Worth recording for the follow-up: the *success* line still reports typing, not
arrival — the asymmetry that hid this incident for seven hours is untouched here.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by construction — the probe reads a tmux pane on the machine that owns
it. No replication, no lease interaction, no shared state, no generated URL. Two
machines on different versions apply their own probe to their own panes; there is no
cross-machine invariant to violate.

## 8. Rollback cost

Low. Delete the module, restore the inline clauses, revert one `server.ts` block. No
migration, no persisted state, no config default, nothing written to an agent home.
The test file would fail on revert, which is the desired property.

## Phase 5 — Second-pass review (independent reviewer subagent)

**VERDICT: CONCERN** — one blocking, four should-fix, one note. Every finding was
independently verified before being accepted; all were real.

| # | finding | disposition |
|---|---|---|
| 1 (blocking) | Unenumerated third consumer at `server.ts:8395` kills a live session on not-ready, so §1's "the failure direction is waiting, which is safe" and §4's "cannot refuse an action" are false for it. | **Design changed.** Verdict widened to `ready \| menu \| not-ready`; Slack path given a menu carve-out + bounded re-check; §1 and §4 rewritten. |
| 2 (should-fix) | The `^` line-start branch reinstates the Anthropic-copy dependency via wrap geometry, and carries no test weight. | **Clause deleted entirely** (both branches). |
| 3 (should-fix) | "Shape, not vocabulary" is falsified by the artifact's own fixture; `· /model to opt in` matches. | **Verified and accepted.** Clause deleted; the claim is retracted in §4b rather than restated. |
| 4 (should-fix) | "A ready pane always shows `❯`" is contradicted by four sibling probes; only one of three permission-mode footers was covered. | **Marker set widened** to four footers, sourced from those siblings. This is also the mitigation for #1. |
| 5 (should-fix) | §4 Q4 materially incomplete. | **Rewritten** above. |
| 6 (note) | Interpunct is U+00B7 only; `•` and box-drawing are false negatives. `ModelSwapService` injects `/model` into live panes. | Moot for the separator (clause deleted); the `ModelSwapService` point is recorded in §5 as further justification. |

**Independently found by the operator, in parallel:** the menu case (§ Summary 2).
Verified against three realistic startup questions, all three of which read as ready
before this change.

**Reviewer concurrence on the revised design was not re-sought.** The revision was
driven by the reviewer's own findings plus a verified operator report, and every
change is pinned by a test asserting both sides of its boundary. That is a
disclosed reduction in independence for the second iteration, not a claim of
concurrence.
