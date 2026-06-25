---
title: Framework Permission-Prompt Robustness — Instar is never blocked by an agent-framework approval prompt
slug: framework-permission-prompt-robustness
author: echo
date: 2026-06-25
parent-principle: "Structure beats Willpower"
status: draft
approved: true
approved-basis: "operator HARD-REQUIREMENT autonomous-mission pre-approval (2026-06-25); convergence report surfaced for visibility; change is internal/additive/reversible (emergencyDisable off-switch)"
ships-staged: false
ships-on-safety-floor: true
companion-spec: framework-permission-prompt-robustness.eli16.md
emergency-optout-path: monitoring.permissionPromptAutoResolver.emergencyDisable
review-convergence: "2026-06-25T21:08:18.761Z"
review-iterations: 6
review-completed-at: "2026-06-25T21:08:18.761Z"
review-report: "docs/specs/reports/framework-permission-prompt-robustness-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Spec — Framework Permission-Prompt Robustness

**Date:** 2026-06-25 · **Author:** echo · **Status:** draft

> **Round-3 convergence note.** Rounds 1–2 (6 internal reviewers + codex/gpt-5.5
> external each round) returned 40 then ~30 findings. Round 2's central correction:
> a tmux text capture **cannot** perfectly distinguish a TUI-rendered `❯` selector
> from displayed content containing the same bytes (`paneTail.ts:16` — the glyphs are
> ordinary Unicode that `capture-pane -p` preserves). This spec therefore (a) **stops
> claiming injection is "closed"** and frames the glyph gate honestly as *bar-raising
> mitigation*, with the residual bounded by **Enter-only** keystrokes (a false match
> sends a benign empty submit, never a destructive selection), re-capture, a bounded
> attempt cap, and a terminal defect; (b) **deletes the digit-escalation branch**
> (it contradicted the strict cursor-on-approve gate and was unverified — Enter only);
> (c) **reuses the existing 5-line capture (`SessionManager.ts:1580`) as a cheap
> pre-gate** so the common case adds **zero** extra captures, and is **honest that the
> fuller candidate-only capture is _synchronous_ on the fleet** (the async path is
> dev-gated off there) — round 3 corrected the round-2 "async, non-blocking" claim;
> (c2) **episode-scopes the fingerprint state** (reset-on-clear) so answering one prompt
> never pre-terminates a later same-shape prompt, and drops the global window cap;
> (c3) **broadens Layer 3** to surface any persisting unanswerable menu (`❯`-not-on-
> approve, prose-drift) so "never silently stranded" is actually true; (c4) defines
> `matchedPatternNames` as the registry's **static names** (never tail text);
> (d) fingerprints on the **signature identity** (framework + sorted matched-pattern
> names), not volatile tail text; (e) makes `approval-prompt-waiting` **never** a
> PresenceProxy user message (the sole surface is the terminal defect); (f) grounds
> the guard-posture integration in a **computed** posture key (+ a runtime `guardStatus`
> for `on-confirmed`) so the floor has no
> persistable `enabled:true` to rot, yet still shows in `/guards`; (g) rests the
> auto-approve security trade-off **solely** on the operator-full-access trust model.
> Full trace in the convergence report.

## Problem statement

Claude Code **2.1.176–177** added a **hardcoded Bash safety classifier**. When a
Bash command is a `cd <dir> && <cmd>` compound *and* it also contains an output
redirection or pipe (`>`, `>>`, `|`, `2>`), the harness pauses the session and
renders a terminal approval prompt:

```
Compound command contains cd with output redirection — manual approval required
to prevent path resolution bypass.
Do you want to proceed?
❯ 1. Yes
  2. No
  Esc to cancel
```

This classifier runs **before all permission rules and PermissionRequest hooks**.
Empirically confirmed: there is **no config / env / flag** that suppresses it —
`--dangerously-skip-permissions`, `permissions.allow`, and PermissionRequest
allow-hooks all run *after* it and cannot pre-answer it. Instar spawns
`claude --dangerously-skip-permissions`, so the prompt fires anyway.

A session parked on this prompt is a **third liveness state** that every existing
watcher mis-reads:

- The process is **alive** and **emitting fresh output** (the prompt itself), so
  the freeze watchers (`ActiveWorkSilenceSentinel`) see new bytes and stay quiet.
- The process tree is live, so `PresenceProxy` tier-3 sees active processes and
  can report "🔭 actively working" — a lie (the loop is blocked on a terminal
  Y/N it cannot answer).
- The autonomous liveness reconciler sees a live session and self-heals nothing.

Telegram and the dashboard cannot answer a terminal Y/N. The result is a
**permanent availability failure**: the agent is silently wedged on a prompt no
remote surface can clear. This renders Instar useless, and it must be fixed
**framework-agnostically** — Instar's availability must never be dictated by a
Claude Code / Codex / Gemini host's prompt behavior.

### Binding operator directive (governs the whole design)

**No low-level command/tool approval prompt is ever a user decision.** The agent
runs operator-owned sessions with full machine access. The user is consulted only
for **high-level** decisions (irreversible, financial, out-of-scope, policy-
sensitive) — and those are *already* gated by `external-operation-gate.js`, the
Coherence Gate, and the Coordination Mandate. A prompt-parked session is a
**defect to auto-clear and detect**, never a "waiting for operator / respond in
Telegram" state. **This class must never be surfaced to the user** — with one
narrow exception the directive itself implies: a prompt the floor genuinely
**cannot** auto-clear (host changed the UI, an unrecognized selector) is no longer
a routine low-level prompt — it is a real malfunction the agent cannot self-resolve,
and *that* (only that) is a legitimate high-level surface (see Layer 2 §Terminal).

### Prior art in the codebase (grounded, and why it is not enough)

Instar already ships a prompt-detection + auto-approve pipeline, and its fleet
*default* is on:

- `src/monitoring/PromptGate.ts` (`InputDetector`) — hooks into
  `SessionManager.monitorTick()` via `this.promptDetector.onCapture(...)`, but only
  when `this.promptDetector` exists (it is constructed **only** when
  `monitoring.promptGate.enabled` is truthy, `server.ts:5400`). Classifies prompts as
  `permission | question | plan | selection | confirmation`; can carry an
  `autoDismissKey` (`PromptGate.ts:35-44`).
- `src/core/AutoApprover.ts` — Phase-2 auto-approve; `resolveApprovalKey`
  (`AutoApprover.ts:51-75`) maps a `permission` prompt → `"1"`, and a `confirmation`
  prompt containing `"Esc to cancel"` → `Enter`. Audit at `state/prompt-gate-audit.jsonl`.
- Default config: `src/config/ConfigDefaults.ts:573-582` — `promptGate.enabled: true`.

**Empirically confirmed failure mode (live `echo` agent, 2026-06-25).** Although the
fleet *default* is `enabled: true`, the deployed `echo` agent's persisted
`.instar/config.json` carries `monitoring.promptGate.enabled: false` — so the entire
detect+auto-approve pipeline is **off**, and there is no `prompt-gate-audit.jsonl`
because it never ran. This is the **stale-persisted-override trap** (the cartographer
pattern): a new default of `true` does not reach an existing agent that already
persisted `false`, and existing agents are exactly the fleet. With the pipeline off,
**nothing** answers the cd-redirection prompt and the session wedges — the observed
bug. (PromptGate's `InputDetector` would *likely* classify the shape if it ran, so the
real failure is **"the floor is disabled,"** not "the signature is unrecognized.")

**Why a dedicated, unconditional resolver is the fix** (load-bearing, not duplication):

1. **The floor must be unconditional.** PromptGate is gated on
   `monitoring.promptGate.enabled`, persisted `false` on `echo`. Any floor whose
   on-state lives in a *persisted* config value can be silently killed the same way.
   The directive demands a floor that is **on in code**, with **no persisted
   enable-true flag** that could rot to enable-false (Decision 6, the autoRecover
   pattern, grounded against `ConfigDefaults.ts:174-180`).
2. **No LLM in the path.** PromptGate routes each prompt through `InputClassifier`
   (Haiku) before deciding auto-approve vs **relay**; the classifier's circuit breaker
   trips under rate limits, and the relay branch **surfaces the prompt to the user** —
   forbidden for this class. The resolver is deterministic and zero-LLM.
3. **Routing is not guaranteed.** Even enabled, the auto-approve branch fires only if
   the LLM first tags the prompt *and* routes it to auto-approve rather than relay — a
   per-tick non-determinism a must-answer-every-time class cannot tolerate.

The resolver reuses PromptGate's proven primitive (`sendKey`) and the `paneTail`
discriminators but depends on **none** of PromptGate's gating, LLM classification, or
relay branch. On agents where PromptGate *is* enabled the two coexist via a structural
handoff (Decision 7).

## Proposed design

Two layers (a Layer-1 prevent hook was **dropped in round 1** — see "Considered and
rejected"). **Layer 2 is the load-bearing fix; Layer 3 is observability with the
single terminal user-surface.**

### Layer 2 — PermissionPromptAutoResolver (LOAD-BEARING, unconditional)

A new deterministic component, `src/monitoring/PermissionPromptAutoResolver.ts`,
driven once per monitoring tick from inside `SessionManager.monitorTick()`'s
per-running-session loop. For each running session it captures the live tail, and if
that tail shows a **live, focused approval menu** matching a registered signature, it
sends **`Enter`** (the verified approve key — confirm the highlighted default), then
re-verifies the prompt cleared.

#### Where it runs + its capture (grounded; zero extra captures in the common case)

The loop is `SessionManager.monitorTick()` (`SessionManager.ts:1330`), iterating
`listSessions({status:'running'})` (`:1334`) with a 15 s start-grace and an alive check.
The resolver call is inserted **inside the existing `!protectedSessions && !isReaping`
block** (`SessionManager.ts:1579`), **immediately after** that block's existing 5-line
tail capture `const output = await captureMeaningfulTailMaybeAsync(session.tmuxSession,
5)` (`:1580`). It is **not** gated by `isActuallyIdle` (a prompt-wedged session must be
handled regardless of that flag's semantics).

**Capture cost — minimized by a cheap, BOTTOM-ANCHORED pre-gate** (round-3/4
scalability + adversarial). The resolver **reuses the already-captured 5-line `output`**
(`:1580`) as a **cheap pre-gate**, keyed on the **menu shape, not the prose**: a fast
check for a glyph-led numbered option line (`\d+\.` with a TUI lead glyph) **or** a
generic blocking affordance (`/Esc to cancel/i`, `/Do you want to proceed/i`). The menu
+ its affordance render at the **very bottom** of the pane, so they are reliably within
the last 5 non-empty lines even though `meaningfulTail` (`paneText.ts:30`) preserves
*interior* blanks (round-4 adversarial: keying on the higher-up prose would miss it; the
bottom-anchored menu shape does not). Keying on the menu shape (not the prose) **also**
ensures a **prose-drifted** prompt still trips the pre-gate (round-4 lessons-aware).
**Only on a pre-gate hit** — rare — does the resolver do its own fuller capture
(`captureMeaningfulTailMaybeAsync(…, 16)`, for the full menu + glyph lines) and run
detection; on a Layer-2 match it does **one** re-capture-before-send. **Common case (no
menu) → ZERO extra captures** (it reads a string already in hand).

**Honest about async vs sync on the fleet** (round-3/4 scalability — correcting the
round-2 "async, non-blocking" claim). `captureMeaningfulTailMaybeAsync` dispatches to
the async twin only when `tmuxAsyncEnabled` is true, which is **dev-gated**
(`resolveDevAgentGate(monitoring.tmuxResilience.asyncHotPath.enabled)`; omitted ⇒
`!!developmentAgent` ⇒ **true on a dev agent like `echo`, FALSE on the fleet**). So on
the fleet the resolver's *candidate-only* fuller capture is a **synchronous**
`execFileSync` capture that blocks the event loop, bounded by that call's **own
`{ timeout: 5000 }`** (`SessionManager.ts:3061` `captureOutput`) — **not**
`asyncHotPath.timeoutMs` (9000 ms), which governs only the async twin and has no effect
on the fleet sync path. The per-matched-tick worst case is up to two sequential ~5 s
sync captures (fuller capture + the re-capture-before-send). Because the bottom-anchored
pre-gate fires only when a menu shape is actually at the pane bottom, this cost is
**proportional to pre-gate hits** (live prompts plus the rare pane that persistently
displays menu-shaped content), not one extra sync capture per running session per tick.
Stated plainly rather than papered over with an "it's async" claim that does not hold on
the fleet.

#### Detection — strongest available signal that a focused menu is live

`detectApprovalPrompt(tail: PaneTailLine[], registry): ApprovalMatch | null` is the
pure, unit-testable core, where `PaneTailLine = { text: string; leadGlyphs: string }`.
**`text` is the lead-STRIPPED content** (via the existing `stripLineLead`,
`paneTail.ts:46`) so anchored regexes match the real first token; **`leadGlyphs` is the
separated leading glyph run** (a new pure helper `leadGlyphsOf(line)` that returns the
`LEAD_RE` match) so the detector can test for the **`❯` selector cursor (U+276F)**
specifically, not merely "some glyph" (`paneTail.wasGlyphLed` only answers the latter).
A match REQUIRES **all** of:

1. **≥2 _distinct_ named prose patterns** matched from the framework's registry — each
   registry pattern carries a stable `name` (registry shape below), and "distinct" means
   ≥2 *different* registry entries matched (not one pattern repeated across lines). This
   corrects the round-2 mis-citation of `countAupSignatureLines` (which counts one
   signature repeated). The set of matched names is `matchedPatternNames` — the **static
   registry names**, NEVER the matched substring/capture text — which is what the audit
   logs and the fingerprint hashes (so neither can ever carry tail-derived bytes;
   round-3 security).
2. **A `❯`-cursor approve-option line in the live tail**: a line whose `leadGlyphs`
   contains U+276F **and** whose lead-stripped `text` matches
   `^\s*\d+\.\s*(yes|proceed|allow|continue)\b` (case-insensitive). I.e. the selector
   cursor is *on an approve option*.
3. **The menu is at the genuine bottom** of the live tail (the approve-option /
   `Esc to cancel` lines are within the last few non-empty lines — there is no live
   idle input box rendered *below* the menu), **and** the session is **not generating**
   (the existing generating-now discriminator applied to the joined tail *string*,
   `looksGeneratingNow(tail.map(l => l.text).join('\n'), framework)` — it is a string
   predicate, not a line-array one).

**Honest security posture (round-2 security#1, adversarial#1, lessons#2).** A tmux
`capture-pane -p` is plain text; U+276F and the box-drawing glyphs are ordinary Unicode
**content**, so a capture **cannot** perfectly prove a `❯ 1. Yes` line is TUI chrome
rather than displayed content (a fixture, a pasted transcript, a doc *about* this
prompt). Requirements 1–3 **substantially raise the bar** — displayed content must
reach the genuine bottom of the live tail, carry the `❯` on an approve verb, match ≥2
distinct prose patterns, and the session must not be generating — but this is
**mitigation, not closure**, and the spec says so. The residual is bounded structurally:

- **Enter-only keystroke** (next section): the *consequence* of a false match is a
  single **`Enter`** to the pane. On an idle Claude pane that is a benign empty submit
  (Claude ignores it / re-prompts); it never selects a destructive option, because we
  only ever send `Enter` and only when a `❯` already sits on an *approve* option.
- **re-capture-before-send**, the per-episode **`MAX_ATTEMPTS = 3`** (reset-on-clear),
  and the **terminal defect** (a persistent false match stops sending and
  surfaces, rather than hammering forever).

A Tier-1 test pins this residual explicitly (Tests).

#### The approve keystroke — `Enter` only (digit branch deleted)

From a requirement-2 match the `❯` cursor is already on the approve option, so the
approve key is **`Enter`** (confirm the highlighted default) — the dominant Claude-Code
case (`❯ 1. Yes`) and doubly precedented (`AutoApprover.ts:64`; `codexHookArm.ts:188-190`,
which sends `Enter`, explicitly **not** a digit, when the cursor is already on "Yes").
The round-2-flagged **digit-escalation branch is deleted**: it contradicted requirement 2
(if the cursor must be on the approve option, a "cursor on a non-approve option" branch
is unreachable) and was unverified (codex#4 warned a bare `1` may be inserted as text).
There is **no** `Enter`-then-`1` escalation. If a future framework genuinely needs a
non-Enter key, that is a new registry entry added only after the live prompt is
characterized (it ships off until then — Decision 10).

#### Re-capture-before-send (closes the capture→send race)

Immediately before sending, the resolver **re-captures the live tail and re-runs
`detectApprovalPrompt`**; it sends `Enter` **only if the same stable fingerprint (below)
is still the live focused menu**. If it cleared/changed, it sends nothing this tick
(audit `race-aborted`). This prevents a key landing in the next program (round-2 codex#2).

#### State machine — episode-scoped, reset-on-clear, bounded attempts, terminal

`stableFingerprint = hash(framework + sorted(matchedPatternNames))` is the *registered
signature identity* — invariant across redraws of the same prompt (round-2). But every
cd-redirection prompt shares that signature, so the state keyed on it must be
**EPISODE-scoped**, or answering prompt A would pre-terminate a later distinct prompt B
of the same shape (round-3 adversarial HIGH):

- State per `(tmuxSession, stableFingerprint)`: `{ consecutiveUnclearedSends, lastTick }`.
- **A contiguous wedge episode** = consecutive ticks where the menu stays present and
  un-cleared. On any tick where the menu is **absent / cleared** for that fingerprint,
  the entry is **evicted** — the episode ended, so a later separately-observed
  appearance starts **fresh at zero**. (A successful `Enter` that clears the prompt thus
  resets the state next tick; distinct prompts separated by ≥1 cleared tick are
  independent.)
- **attempt**: re-capture-confirm the same fingerprint is still the live focused menu →
  `sendKey('Enter')` → `consecutiveUnclearedSends++`.
- The anti-hammer bound is **per-episode**: `MAX_ATTEMPTS = 3` consecutive un-cleared
  sends → Terminal. There is **no** global per-session answers-per-window cap (round-3
  adversarial: it would false-Terminal a legitimately busy session hitting many
  *distinct* prompts). A large per-session *runaway* counter (≈100 sends / 5 min) exists
  only as a pathology backstop and **logs** rather than raising a Terminal defect.
- **Narrow residual**: two distinct prompts back-to-back within a single ~5 s tick gap
  with no observed cleared-tick between them look like one episode; the worst case is an
  *early Terminal defect* (a surfaced "couldn't clear" notice), never a silent strand.

##### Terminal — the one legitimate user surface (round-1 adversarial#1, round-2/3)

When `consecutiveUnclearedSends ≥ MAX_ATTEMPTS` and the same focused menu is **still**
present, the resolver declares the prompt **un-clearable**: it **stops sending** for
that episode and raises **one deduped Attention defect** (deduped on
`sessionName + fingerprint`, age-escalating) — plain English: *"a session is wedged on
an approval prompt I could not auto-clear (the host may have changed its prompt UI) —
it needs a look."*

**This, plus Layer 3's broader detection, is what makes "never silently stranded" TRUE
for ALL menu-like wedges — not only the auto-answerable ones** (round-3 adversarial +
decision-completeness, which correctly flagged that Enter-only + cursor-on-approve
leaves two cases unhandled). Layer 3 (below) detects the broader class — *any* glyph-led
numbered menu persisting on a **non-generating** session that the resolver did **not**
auto-clear within a few ticks — which covers exactly the cases Layer 2's strict gate
does not auto-answer: (a) a recognized prompt whose `❯` is **not** on an approve option,
and (b) a **prose-drifted / unrecognized** future prompt. Both route to the **same**
Terminal Attention defect. So the honest division is: Layer 2 **auto-clears** matched +
cursor-on-approve prompts; everything else that looks like a persisting unanswerable
menu **surfaces** via Layer 3's Terminal — nothing is silently stranded, and this is
also the **prompt-string drift detector** (round-1 lessons#3).

#### Always-on, unconditional — no stale-false trap; guard-posture via a *computed* key

The resolver is **instantiated and run unconditionally**; its on-state lives in **code**,
not a persisted config value (round-1 lessons#1, the central lesson of the bug —
`ConfigDefaults.ts:174-180` documents that `autoRecover` is deliberately **not**
persisted for exactly this reason):

- **No `enabled: true` is written to config.** There is therefore **no** persisted
  enable-true value that can rot to enable-false (the `promptGate.enabled:false` trap).
- The **only** opt-out is `monitoring.permissionPromptAutoResolver.emergencyDisable`,
  whose **default is absent** (absence ⇒ **on**). Turning the floor off is a deliberate,
  present, visible act.
- **Guard-posture integration is a _computed_ key (grounded fix, round-2
  integration#1/decision-completeness#1/lessons#3).** `extractGuardPosture`
  (`guardPosture.ts:48-60`) reads `monitoring.<key>.enabled` literally, so it cannot see
  an inverted `emergencyDisable`. This spec adds a **small, explicit** branch to
  `extractGuardPosture` that derives a posture entry
  `monitoring.permissionPromptAutoResolver.enabled := (config.monitoring
  ?.permissionPromptAutoResolver?.emergencyDisable !== true)`. The posture key is
  therefore **computed, always present, and defaults `true`** — so the floor shows in
  `GET /guards`, and a flip to `emergencyDisable:true` reads as `enabled→disabled`,
  which the `GuardPostureTripwire` raises as a HIGH boot incident. Because the *source*
  field is `emergencyDisable` (absent by default) and the posture `enabled` is computed,
  there is **no persisted boolean to rot** — the floor satisfies both "no stale-false
  trap" and "a disabled floor is a visible incident."
- **Runtime `on-confirmed` (round-3 integration).** The computed config posture alone
  would grade `on-unverified`; to reach `on-confirmed`, the resolver implements the same
  runtime contract the other sentinels do — a cheap, no-I/O
  `guardStatus(): { enabled: boolean; lastTickAt: number }`
  (cf. `ActiveWorkSilenceSentinel.ts:516`, `ContextWedgeSentinel.ts:361`) — and
  `server.ts` self-registers it with the `GuardRegistry`
  (`src/monitoring/GuardRegistry.ts:36`) at boot, exactly like the other guards. So
  `GET /guards` confirms the floor is actually *running* (`on-confirmed`), not merely
  enabled-in-config.
- **`GUARD_MANIFEST` entry is mandatory (round-4 integration + lessons-aware).** A
  runtime-registered guard that is **not** classified in `GUARD_MANIFEST`/`NOT_A_GUARD`
  (`src/monitoring/guardManifest.ts`) escapes the manifest-classification lint and cannot
  be graded `on-confirmed`. This spec adds the manifest entry, mirroring
  `ActiveWorkSilenceSentinel` (`guardManifest.ts:157`):
  `{ key: 'monitoring.permissionPromptAutoResolver.enabled', kind: 'config', configPath:
  'monitoring.permissionPromptAutoResolver.enabled' (the computed key), defaultEnabled:
  true, expectedTickMs: 5000, process: 'server', expectRuntime: true, component:
  'PermissionPromptAutoResolver' }`. The manifest-classification test (which fails on any
  boot-constructed guard absent from both lists) thus stays green. **Because the
  resolver's filename (`PermissionPromptAutoResolver.ts`) does not match the lint's
  guard-name pattern** (round-5 integration), `'PermissionPromptAutoResolver'` is **also**
  added to `ADDITIONAL_CANDIDATES` in `scripts/lint-guard-manifest.js:86` — exactly as
  `QuotaTracker` (`:87`) and `PromptGate` (`:98`) are listed there for the same reason —
  so the lint actually *detects* it as a candidate and enforces its manifest entry.

#### Bounded state (round-1 scalability#2 — Bounded Accumulation)

**Both** resolver state maps — the Layer-2 `(session, fingerprint)` episode map **and**
the Layer-3 `(session, menuStructureKey)` persistence map — **evict** entries on the
**same triple**: cleared-tick (episode end), session-exit (absent from
`listSessions({running})`), and a per-entry TTL (30 min). Neither can grow with uptime,
even under session churn with a never-cleared menu (round-5 scalability/lessons). The
audit log `logs/permission-prompt-resolver.jsonl` is **size-bounded with rotation**
(8 MB); per-episode `MAX_ATTEMPTS=3` and `LAYER3_PERSIST_TICKS=4` (then Terminal stops
re-raising) prevent per-tick append on a non-clearing prompt.

#### Audit (round-1 security#6)

Each action appends one JSON line: `{ ts, sessionName, framework, matchedPatternNames,
keySent:'Enter', fingerprint, attempt, outcome }`, `outcome ∈ {answered, retried,
cleared, persisted-terminal, send-failed, race-aborted}`. **The raw tail is never
logged** — only the matched-pattern *names* — so surrounding pane content (possibly
secret-bearing) cannot leak into the audit.

#### Framework registry (round-1 lessons#4, codex#1 — honest naming)

`APPROVAL_PROMPT_SIGNATURES` is keyed by framework, each entry `{ prosePatterns:
{ name: string; pattern: RegExp }[]; approveLabels: RegExp }` — each prose pattern
carries a **stable symbolic `name`** (e.g. `'manual-approval'`, `'path-resolution-
bypass'`) which is what `matchedPatternNames` reports (never the matched text). The
resolver tries **every** registered signature
each tick (it does **not** depend on `session.framework`, undefined on legacy records);
a Claude prompt won't match a Codex pattern, so trying all is safe and cheap. Initial
contents populate **claude-code** (verified); codex/gemini entries are **conservative,
off until a live prompt is characterized**. Because only claude-code is verified at
ship, the spec says **framework-extensible**, not "framework-agnostic" (codex#1).

### Layer 3 — Detect-as-defect (the BROAD persisting-menu detector + the Terminal surface)

**The broad detector is a concrete, prose-AGNOSTIC structural predicate (round-4
adversarial HIGH — the round-3 "broaden Layer 3" claim was asserted but underspecified).**
A second pure function `detectPersistingMenu(tail: PaneTailLine[]): MenuMatch | null`
runs on the same fuller capture as `detectApprovalPrompt`, and matches purely on
**structure, no registry prose**: (i) a glyph-led numbered option line (a line whose
`leadGlyphs` contains a TUI lead glyph and whose stripped text matches `^\d+\.\s`), (ii)
a generic blocking affordance in the tail (`/Esc to cancel/i` **or** `/Do you want to
proceed/i` **or** ≥2 numbered option lines), (iii) at the genuine bottom, (iv)
not-generating. This deliberately matches the cases Layer 2 declines — `❯` **not** on an
approve option, and a **prose-drifted/unrecognized** prompt — *as well as* a genuinely
open non-approval picker (e.g. a `/model` menu left open); the last is an **accepted,
benign** surface (something IS waiting for input the agent cannot self-answer, which is
worth one notice). It is **prose-agnostic by design**, which is exactly why it catches
drift; the cost is the accepted false-positive on a deliberately-open picker, bounded by
the persistence threshold below.

**Layer 3 has its OWN state machine, independent of Layer 2's prose fingerprint**
(round-4 adversarial — Layer 2's `consecutiveUnclearedSends` only increments on a
`sendKey`, and a Layer-3-only match has no `ApprovalMatch`/`matchedPatternNames`/
fingerprint). Keyed on `(tmuxSession, menuStructureKey)` where
`menuStructureKey = hash(session + the sorted option-label texts of the menu)`. The
option-label texts are consumed **only** as input to the one-way hash — they are
**never logged raw**, and the dedup key is the digest, never the labels (the same
tail-bytes-never-in-keys-or-logs discipline as Layer 2's `matchedPatternNames`,
round-5 security):

- **`persistTicks++` only on a tick where `detectPersistingMenu` matched AND
  `detectApprovalPrompt` did NOT** (round-5 adversarial/decision-completeness: this is
  the cross-layer coordination rule — a menu Layer 2 *matched* this tick is Layer 2's
  responsibility, including its own Terminal, so Layer 3 never counts it and the two can
  **never double-raise** for one wedge). Layer 3 therefore covers exactly and only the
  cases Layer 2 declines (`❯`-not-on-approve, prose-drift, open non-approval picker).
- a tick where the menu is **absent/cleared** → evict (reset-on-clear). And — like the
  Layer-2 map (Bounded state, below) — this map **also** evicts on **session-exit**
  (absent from `listSessions({running})`) and a **30-min per-entry TTL**, so it cannot
  grow with uptime under session churn (round-5 scalability/lessons — Bounded
  Accumulation).
- at `LAYER3_PERSIST_TICKS = 4` (~20 s at the 5 s cadence) → raise **one** Terminal
  Attention defect, **deduped on `(sessionName, menuStructureKey)`** (the no-fingerprint
  dedup key), age-escalating, then stop re-raising for that episode.

So an unanswerable/unrecognized/drifted menu **surfaces** rather than silently stranding
— the honest backbone of Decision 5 and the drift detector — via a fully-specified
counter, threshold, key, and dedup, not a hand-wave.

**PresenceProxy never emits a user message for `approval-prompt-waiting` (round-2/3).**
Because `StuckClassification` requires a user-facing `message`
(`StuckSignatureClassifier.ts:42-48`) and the resolver's ownership flag is released at
Terminal, an ownership-gated suppression could leak the kind on the post-terminal tick;
so the rule is absolute and lifecycle-free: **the consumer declines to surface this kind,
period** (a consumer policy, not a `classifyStuckSignature` contract inversion — the
classifier still returns the kind; it is only used to mark the session **non-`dead`** so
it is not respawned, and for logs). The **only** user-facing output for this whole class
is the resolver's Terminal Attention defect.

**Honest scope (round-3 lessons-aware).** The load-bearing, always-on suppression point
is **Tier 3** — the process-tree "🔭 actively working" surface that fires on the fleet
today. `approval-prompt-waiting` is suppressed there unconditionally, which is the exact
false-"actively working" lie this spec set out to kill. The Tier-1/2 honest-receipt
paths sit behind `standbyHonestyTiers` (dark on the fleet); where they are off, fleet
behavior for those tiers is byte-identical to today, and where they are on they honor
the same consumer policy. The guarantee is stated at the surface that is actually live.

### Considered and rejected — Layer 1 (the prevent PreToolUse hook)

Round 1 (integration#2/#3/#4, lessons#7, codex#5) showed the original Layer 1 (a
PreToolUse Bash hook pre-empting the `cd …&&… >` trigger) is **not worth shipping**: its
premise (a PreToolUse Bash hook fires *before* the hardcoded classifier) is **unverified
host ordering**; "default-off" was self-contradictory (an installed `settings.json`
entry runs unconditionally); robust compound parsing is a known-hard problem; and Layer 2
auto-clears the prompt anyway. Recorded as **considered and rejected**; revisit only if
the ordering is ever empirically verified. (This rejection is also why Decision 8 makes
**no** ordering-dependent claim about a denylist firing "after" the resolver.)

## Frontloaded Decisions

All resolved here so the build completes in one autonomous run. Every choice is
**internal, additive, reversible** (emergency opt-out + the bounded, deterministic,
Enter-only design).

1. **Layer 2 is the fix; Layer 1 is dropped; Layer 3 is observability + the single
   terminal surface.**

2. **Detection: bar-raising mitigation, honestly framed — not "closed."** ≥2 distinct
   prose patterns + a `❯`-cursor approve line + bottom-of-tail + not-generating. The
   spec explicitly states a text capture cannot perfectly distinguish chrome from
   content; the residual is bounded by Enter-only + re-capture + per-episode
   `MAX_ATTEMPTS` + Terminal (round-2 security#1/adversarial#1/lessons#2).

3. **Keystroke: `Enter` only.** The digit-escalation branch is deleted (unreachable
   under requirement 2, unverified). A false positive's worst case is a benign empty
   submit (round-2 adversarial#2, codex#4).

4. **Capture→send race closed by re-capture-before-send** (round-2 codex#2).

5. **Nothing silently stranded — via episode-scoped attempts + Layer 3's broad
   detection.** Per-episode `MAX_ATTEMPTS=3` (reset-on-clear, so distinct prompts are
   independent — round-3 adversarial) → Terminal for an auto-answerable-but-unclearing
   prompt; AND Layer 3 detects the broader class (any persisting glyph-led menu on a
   non-generating session the resolver did not clear — covering `❯`-not-on-approve and
   prose-drift) → the **same** Terminal defect. No global per-session window cap (it
   would false-Terminal a busy session). Doubles as the drift detector.

6. **The floor is unconditional — NO persisted enable-true flag; guard-posture via a
   computed key.** On-state in code (autoRecover pattern); only opt-out is
   `emergencyDisable` (absent ⇒ on); `extractGuardPosture` computes the always-present
   `…permissionPromptAutoResolver.enabled = (emergencyDisable !== true)` so the floor
   shows in `/guards` and a disable is a tripwire incident — with no persisted boolean to
   rot (round-1 lessons#1; round-2 integration#1/decision-completeness#1/lessons#3,
   grounded against `guardPosture.ts:48-60`).

7. **Coexistence with an enabled PromptGate is structural, not just timing.** On `echo`
   PromptGate is disabled (no collision today). Where enabled, the resolver, on answering
   a session's safety-prompt, calls the existing input-sent notification on the detector
   (`InputDetector.onCapture`/the auto-dismiss bookkeeping at `server.ts:5456`) so
   PromptGate sees the prompt as handled and does not double-answer; and because the
   resolver only ever sends `Enter` at a still-present `❯`-on-approve menu, a redundant
   keystroke to an already-cleared prompt is a benign empty line. The resolver owns the
   framework-safety-prompt class (round-2 adversarial#5/integration; if the structural
   notification proves unavailable at build time, the deterministic+faster resolver still
   wins the race and the benign-Enter property bounds any overlap — recorded as the
   fallback, not the primary).

8. **Auto-approving the cd-redirection prompt — honest residual risk, accepted on the
   trust model alone.** Resolved per round-2 security#2: **no instar gate is claimed to
   replace the host's path-resolution-bypass check**, and **no ordering** relative to the
   host classifier is asserted (consistent with the Layer-1 rejection). The residual
   bypass risk is accepted **purely under the operator full-machine-access trust model** —
   the principal IS the operator and the agent could already run the non-`cd` form of the
   same command un-prompted. `dangerous-command-guard.sh` (the destructive denylist,
   wired as the first Bash PreToolUse hook — verified present on `echo`'s live settings)
   remains an **independent** guard that the resolver neither needs nor weakens; the
   resolver only answers a **UI-flow** prompt and never widens the allow-set. The Tier-3
   safety test (below) is **best-effort defense-in-depth evidence**, not a proof that
   bounds the risk.

9. **Ships ON as a safety floor, not dark.** Per the operator directive ("never
   blocked"), this safety floor ships **on**, not behind a dark/dry-run flag. The
   substitutes for a soak are the deterministic, **Enter-only**, live-menu-gated,
   re-captured, attempt-capped, bounded design **plus the mandated live
   Playwright-Telegram proof before "done."** A **diagnostic** `dryRun` (logs "would send
   Enter" without sending) exists for operator inspection but is not the default. A
   deliberate, justified divergence from dark-ships-first, recorded for the reviewer.

10. **Framework-extensible, not "framework-agnostic"** (codex#1): verified coverage is
    claude-code; codex/gemini entries ship off until characterized.

## Decision points touched

- **`SessionManager.monitorTick`** (`:1330`): the resolver call goes **inside the
  existing `!protected && !isReaping` block (`:1579`), right after the 5-line `output`
  capture (`:1580`)** — reusing `output` as the cheap pre-gate; only on a pre-gate hit
  does it do the fuller `captureMeaningfulTailMaybeAsync(…,16)` + detection, and on a
  match one re-capture + `sendKey('Enter')`. Not gated by `isActuallyIdle`.
- **`src/core/paneTail.ts`**: new pure `leadGlyphsOf(line): string` helper (returns the
  `LEAD_RE` lead run) so the detector tests for U+276F specifically; `PaneTailLine.text`
  is the `stripLineLead` content. No behavior change to existing exports.
- **New component** `src/monitoring/PermissionPromptAutoResolver.ts`: two pure detectors
  — `detectApprovalPrompt` (Layer 2 auto-answer) + `detectPersistingMenu` (Layer 3 broad,
  prose-agnostic) — plus a stateful driver (Layer-2 episode map keyed on prose
  fingerprint + Layer-3 persistence map keyed on `menuStructureKey` + audit writer +
  Terminal defect raiser + `guardStatus()`), DI'd with `captureTail`, `sendKey`, `now`,
  `appendAudit`, `raiseDefect`, `notifyPromptGate?` (wiring-integrity testable).
- **`src/monitoring/guardPosture.ts`**: add the computed-posture branch (Decision 6).
- **`src/monitoring/guardManifest.ts`**: add the `GUARD_MANIFEST` entry (above) so the
  resolver is classified and gradable `on-confirmed`.
- **`StuckSignatureClassifier.ts`**: `approval-prompt-waiting` kind (`:36`) +
  `APPROVAL_PROMPT_TAIL_PATTERNS` + branch in `classifyStuckSignature` (`:109`).
  Contract unchanged.
- **`PresenceProxy.ts`**: unconditional suppression of `approval-prompt-waiting` as a
  user message (consumer policy, no contract inversion).
- **`server.ts`**: construct + wire the resolver into the production monitoring init
  (the "feature is alive" path), unconditionally.
- **`ConfigDefaults.ts`**: NO persisted `enabled`; document `emergencyDisable`
  (absent ⇒ on) for discoverability only.
- **`src/scaffold/templates.ts` (`generateClaudeMd`)** — Agent Awareness Standard: a
  short CLAUDE.md template note so an agent can answer "why did my session auto-continue
  past a prompt?" / "what is the permission-prompt floor?" and knows the Terminal defect
  is the only surface.

## Open questions

*(none)*

## Tests

Three tiers (Testing Integrity Standard) + wiring-integrity + both-sides semantic tests.

**Tier 1 — Unit (`tests/unit/`):**

- `paneTail.leadGlyphsOf`: returns the U+276F run for a `❯`-led line; empty for a
  column-0 line; box-drawing-led line's run contains no U+276F.
- `detectApprovalPrompt`:
  - **fires** on the real CC cd-redirection capture (≥2 distinct prose patterns + the
    `❯ 1. Yes` line at bottom + not generating); approveKey=`Enter`.
  - **does NOT fire**: only ONE distinct prose pattern (repeated) → no match (the ≥2
    *distinct* rule).
  - **does NOT fire**: the menu text present but a live idle input box is rendered below
    it (not the genuine bottom) → no match.
  - **does NOT fire**: `looksGeneratingNow` true (spinner) → no match.
  - **does NOT fire (Layer 2 auto-answer)**: a `❯`-led line whose option label is `No`
    (cursor not on an approve verb) → Layer 2 refuses to send (never guess); the same
    fixture is asserted to be **named `approval-prompt-waiting` by Layer 3** (so it
    surfaces via Terminal, not silently stranded).
  - **residual documented (round-2 security#1)**: a `❯ 1. Yes` block that IS the genuine
    bottom of an idle pane as *displayed content* → asserts current behavior (it matches;
    the consequence is a single benign `Enter`; comment links this to the honest residual
    + the Terminal backstop) — the residual is *documented*, not denied.
- **State machine (episode-scoped, round-3 adversarial)**: `stableFingerprint` is
  identical across two captures differing only in non-signature lines; a **cleared tick
  evicts the entry** so a later same-shape prompt starts fresh (asserts answering prompt
  A does NOT pre-terminate a distinct prompt B); per-episode `MAX_ATTEMPTS=3` consecutive
  un-cleared sends → Terminal defect raised exactly once; re-capture mismatch →
  `race-aborted`, no send; **no global window cap** (a busy session hitting many distinct
  prompts is never false-Terminal'd).
- **Bounded state**: ended-session + TTL eviction; map does not grow across N ticks.
- **Audit privacy**: a secret-looking token in the tail never appears in the audit line.
- **guardPosture (Decision 6)**: `extractGuardPosture` returns
  `…permissionPromptAutoResolver.enabled = true` when `emergencyDisable` absent, `false`
  when `true`; the boot-diff classifies `true→false` as a disable.
- `detectPersistingMenu` (Layer 3, prose-AGNOSTIC, round-4): **fires** on a glyph-led
  numbered menu + a generic affordance (`Esc to cancel`) + not-generating, with **no**
  registry prose present (a prose-drifted prompt); **fires** on a `❯`-on-`No` menu;
  **does NOT fire** on a generating session or a menu with no affordance and <2 options;
  the structural match carries the `menuStructureKey` (sorted option labels).
- **Layer-3 persistence + no double-raise (round-5)**: a Layer-2-declined menu (`❯` on
  `No`) persisting increments `persistTicks`; at `LAYER3_PERSIST_TICKS` → exactly one
  Terminal defect deduped on `(sessionName, menuStructureKey)`; a cleared tick evicts.
  **AND**: an auto-answerable prompt that Layer 2 *matched but could not clear* (Layer 2
  goes Terminal at `MAX_ATTEMPTS`) raises exactly **one** defect total — Layer 3 does NOT
  increment on the ticks Layer 2 matched, so no second defect.
- **Layer-3 bounded state (round-5)**: the `(session, menuStructureKey)` map evicts on
  session-exit and TTL (not only cleared-tick) — an entry whose session exited mid-wedge,
  and a TTL-expired entry, are swept; the map does not grow across N ticks of churn.
- **Layer-3 audit privacy (round-5)**: a secret-looking token placed in a menu option
  label never appears in cleartext in any resolver log and is not recoverable from the
  `menuStructureKey` digest.
- `classifyStuckSignature` returns `approval-prompt-waiting` for the Layer-3 structural
  predicate (NOT requiring ≥2 distinct registry prose — that is Layer 2's gate); existing
  kinds unchanged (regression).
- **Guard manifest classification**: `PermissionPromptAutoResolver` is present in
  `GUARD_MANIFEST` so the manifest-classification test (every boot-constructed guard in
  `GUARD_MANIFEST` or `NOT_A_GUARD`) stays green.

**Tier 2 — Integration (`tests/integration/`):**

- Resolver wired into a `SessionManager` with a fake tmux whose tail is the
  cd-redirection prompt → exactly one `sendKey('Enter')` within one tick (after the
  re-capture confirm); audit gains one `answered` row; a healthy generating session gets
  zero sends.
- **Wiring-integrity**: injected `captureTail`/`sendKey`/`raiseDefect` are non-null and
  delegate to the real `SessionManager` / attention surface (not no-ops).
- **Capture budget (round-3 scalability)**: a session whose 5-line `output` shows NO
  prose pattern triggers **zero** fuller captures (the pre-gate short-circuits on the
  already-captured string); only a pre-gate hit issues the one fuller capture (+ one
  re-capture on match). Guards the event-loop-block regression on the fleet (where the
  fuller capture is synchronous).
- **`matchedPatternNames` privacy**: the audit row and the fingerprint use the registry
  `name`s; a fixture whose prompt text contains a fake "secret" substring proves the
  substring never reaches the audit or the fingerprint (round-3 security).
- **Guard posture**: `GET /guards` lists `permissionPromptAutoResolver` `on-confirmed`
  by default; with `emergencyDisable:true` it reports the disabled posture and the
  tripwire records it.
- **PresenceProxy**: with an `approval-prompt-waiting` snapshot (incl. *after* the
  resolver goes Terminal, menu still present), `PresenceProxy` sends **no** user message
  and records a non-`dead` assessment; a `context-too-long` snapshot still surfaces.

**Tier 3 — E2E (`tests/e2e/`):**

- **"Feature is alive"**: a session whose pane shows the exact CC cd-redirection block is
  **auto-cleared** end-to-end through the production monitoring init path (mirroring
  `server.ts`) — `Enter` sent, pane advances, audit records the clearance. Negative: a
  healthy session is never touched.
- **Safety (defense-in-depth, not a bound — Decision 8)**: with `dangerous-command-guard.sh`
  wired, a denylisted destructive command (`rm -rf /…`) is still blocked by that
  independent guard; the test documents that the resolver answers only the UI-flow prompt
  and changes nothing about the denylist. (Framed as evidence, not as proof bounding the
  bypass risk.)
- **Terminal/drift (both paths, round-3)**: (a) an auto-answerable prompt that Layer 2's
  `Enter` does NOT clear persists past `MAX_ATTEMPTS` → exactly one deduped Attention
  defect, sends stop; (b) a glyph-led menu Layer 2 will NOT auto-answer — `❯` on a
  non-approve option, OR a prose-drifted/unrecognized prompt — persisting on a
  non-generating session is detected by **Layer 3** and raises the **same** Terminal
  defect (proves "never silently stranded" for the cases Layer 2 declines).

## Migration

New agents get the resolver via `init` (wired in `server.ts`, on by code default).
Existing agents get it through the normal server update — and **existing wedged sessions
recover automatically** (round-1 codex#6): the server restart that deploys the update
restarts the monitoring loop, which on its next tick captures every running session's
tail and auto-clears any parked on the prompt. There is **no persisted enable flag to
backfill** (Decision 6) and **no manual activation step**.

- **Agent Awareness (Migration Parity)**: the CLAUDE.md template note (Decision points)
  ships via `migrateClaudeMd` with a content-sniff guard, so existing agents learn about
  the floor + the Terminal defect on update.
- **`emergencyDisable`** is documented in `ConfigDefaults` comments; absent by default
  (absence ⇒ on); the only opt-out, a deliberate visible act.
- **Live-apply**: the resolver lives in the server-side monitor loop, not per-session
  config, so it covers all running sessions as soon as the updated monitor starts — no
  session restart required.

## Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Sessions, their tmux panes, the resolver's per-session state
map, and the resolver audit log are all **per-machine** — a session's approval prompt
exists only on the pane of the machine running it and can only be answered there. There
is **no** replicated state, **no** proxied-on-read surface, and **no** generated URL that
crosses a machine boundary. The Terminal defect is an Attention-queue item, which already
has its own pool semantics; this feature adds nothing cross-machine. A single-machine and
a multi-machine agent behave identically (round-1 integration#7).
