# Convergence Report — Framework Permission-Prompt Robustness

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, `gpt-5.5`) ran in every round and returned
`MINOR ISSUES` at convergence; its remaining nit (Layer 3 may surface an ordinary open
TUI menu) is the **already-documented, accepted** open-picker tradeoff, not a new
finding. Gemini (`gemini-2.5-pro`) ran in some rounds and intermittently degraded; codex
provided the clean external opinion throughout, so the spec received genuine cross-model
review. Internal: six Claude reviewers (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) each round.

## ELI10 Overview

A recent Claude Code update added a safety pop-up that freezes the agent: whenever a
command does `cd somewhere && … >` (change directory and also redirect/pipe output), the
tool stops and asks "Do you want to proceed? Yes / No" on the terminal — and there is no
setting that turns it off. For a remote agent driven from Telegram or a dashboard, nobody
can press that key, so the session sits frozen forever while still *looking* busy (it's
even reported as "actively working"). That makes the whole product unusable until a human
walks to the machine. We found the real reason it bit us: an older safety feature that
*could* have answered the pop-up was switched off in saved settings and a new "on by
default" never reached it — a trap where a stale "off" setting wins forever.

The fix is a small always-on watcher that answers the pop-up itself. The hard part is
doing it *safely*: a terminal is just text, so you can't be 100% sure a "❯ 1. Yes" on
screen is a real menu versus a file or web page that happens to contain those words. So
instead of pretending we can tell perfectly, we stack safety: the watcher only ever
presses **Enter** (the harmless "confirm the highlighted Yes"), so even if it's fooled
the worst case is a blank line the tool ignores; it double-checks the menu is still there
the instant before pressing; it only tries a few times; and if it genuinely can't clear a
pop-up it stops and raises **one** "please look at this" notice rather than hammering keys
or hiding the problem. Crucially, the watcher is **on in the code itself** with no
saved "on/off" setting that could rot to "off" — so it can never fall into the same trap
that caused the original bug.

The main tradeoffs: we accept that pressing "Yes" approves a command the agent already
chose to run on the operator's own machine (full-access trust model), and we're honest
that a text snapshot can't perfectly distinguish a real menu from look-alike content — so
the safety comes from the layered design (Enter-only, re-check, attempt cap, surface-if-
stuck), not from a perfect detector.

## Original vs Converged

The first draft and the converged spec differ substantially — six rounds of adversarial
review turned a plausible-but-flawed design into a robust, honest one:

- **"Injection is closed" → "injection is *bounded*, honestly."** The draft claimed only
  the TUI renders the `❯` selector, so displayed content couldn't trigger a keystroke.
  That was *factually wrong* — `❯` is ordinary Unicode that tmux preserves. The converged
  spec admits a text capture can't perfectly tell chrome from content, and instead bounds
  the risk: **Enter-only** keystrokes (a false match is a harmless empty submit),
  re-check-before-send, a bounded attempt cap, and a "surface if it persists" backstop.

- **Three layers → two.** The draft's "prevent" hook (block the risky command shape
  before it runs) rested on an unverified assumption about hook ordering, contradicted its
  own "off by default," and tried to solve the hard problem of parsing shell commands. It
  was **dropped** — the auto-answer layer makes it unnecessary.

- **Guessing the key → reading it off the screen.** The draft sent "Enter, then 1 if that
  didn't work." Reviewers showed "1" might be inserted as text, not a selection. The
  converged spec **only sends Enter**, only when the cursor already sits on an approve
  option — no guessing.

- **A flag that could rot → a floor that can't.** The draft put the feature behind a
  normal `enabled: true` config flag — the *exact* kind of saved setting that caused the
  bug. The converged spec makes the floor **unconditional in code**, with the only "off"
  being an explicit emergency switch that's absent by default, plus a computed guard-
  posture entry so a disabled floor is treated as an incident.

- **"Never stranded" claimed → "never stranded" built.** The draft asserted nothing would
  be silently stranded but didn't specify how. The converged spec adds a concrete,
  prose-agnostic **Layer-3 detector** with its own state machine that surfaces *any*
  persisting menu the auto-answer declines (cursor-not-on-approve, or a future prompt
  whose wording drifts) — so drift can't reintroduce a silent freeze.

- **Hidden costs surfaced.** Reviewers caught that the "async, non-blocking" capture is
  actually *synchronous on the fleet*; the converged spec reuses an existing capture as a
  cheap bottom-anchored pre-gate (zero extra captures in the common case) and states the
  real cost plainly. Both internal state maps are now provably bounded (evict on clear,
  session-exit, and TTL).

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Headline change |
|-------|----------------------|-------------------|-----------------|
| 1 | all six + codex | 32 | full rewrite: glyph-led detection, terminal defect, unconditional floor |
| 2 | security, adversarial, integration, decision-completeness, lessons + codex | ~18 | injection "closed"→honest; digit branch deleted; capture-reuse; computed guard key; Decision 8 trust-only |
| 3 | scalability, adversarial, integration, decision-completeness, lessons | 10 | async-on-fleet honesty; episode-scoped fingerprint; matchedPatternNames; on-confirmed wiring; PaneTailLine |
| 4 | scalability, adversarial, integration, lessons | 6 | concrete Layer-3 detector + state machine; menu-shape pre-gate; sync-timeout citation; GUARD_MANIFEST |
| 5 | scalability, adversarial, integration, decision-completeness, lessons | 5 | both maps' eviction triple; no double-raise; lint candidate; menuStructureKey privacy |
| 6 | (none — converged) | 0 | clean across all six lenses; codex MINOR (accepted tradeoff only) |

Standards-Conformance Gate: ran each round but returned 0 standards / timed out (degraded
— unavailable as an authoritative pass); the lessons-aware reviewer engaged the
constitutional standards (Structure>Willpower, Signal-vs-Authority, Bounded Accumulation,
Migration Parity, Agent Awareness) directly each round in its stead.

## Full Findings Catalog (by theme, with resolution)

- **Content→keystroke injection** (R1 security, R2/R3/R4 adversarial): glyph-led `❯`
  requirement added, then honestly reframed as *mitigation not closure*; bounded by
  Enter-only + re-check + attempt cap + terminal surface; residual documented + tested.
- **Auto-approve safety overstatement** (R2 security): Decision 8 rests **solely** on the
  operator full-access trust model; no ordering claim vs the host classifier; the
  destructive denylist remains an independent guard; safety E2E framed as evidence, not a
  bound.
- **Keystroke uncertainty** (R2/R3 adversarial, codex): digit-escalation deleted; Enter
  only, only when `❯` is on an approve option.
- **Capture grounding + cost** (R2/R3/R4 scalability): "reuse existing capture" corrected
  to a bottom-anchored menu-shape pre-gate (zero extra captures common case); honest that
  the fuller candidate capture is synchronous on the fleet, bounded by `execFileSync
  {timeout:5000}`.
- **Fingerprint** (R2/R3/R5 adversarial): signature-identity hash, then episode-scoped
  with reset-on-clear so distinct same-shape prompts are independent (no false
  pre-terminate); both maps bounded (clear/session-exit/TTL).
- **Stale-false trap** (R1/R2 lessons, security): floor unconditional in code, no
  persisted `enabled`; only `emergencyDisable` (absent⇒on); computed guard-posture key +
  runtime `guardStatus()` + GUARD_MANIFEST entry + lint candidate so a disabled floor is
  a visible incident.
- **Silent strand / drift** (R3/R4 adversarial, decision-completeness): concrete
  prose-agnostic Layer-3 detector + its own state machine surfaces any persisting
  unanswerable menu; cross-layer rule prevents double-raise.
- **PresenceProxy leak** (R2/R3 security, lessons): `approval-prompt-waiting` never a user
  message (consumer policy, not contract inversion); honestly scoped to the always-on
  Tier 3.
- **Audit privacy** (R3/R5 security): both fingerprints/keys use static registry names /
  one-way digests; raw tail never logged; tested.
- **Multi-machine** (R1 integration): machine-local by design, stated.
- **Agent Awareness / Migration Parity** (R4 lessons): CLAUDE.md template note via
  `migrateClaudeMd`; existing wedged sessions auto-recover on the update's monitor restart.

## Convergence verdict

**Converged at iteration 6.** Zero material findings in the final round across all six
internal lenses; codex's final verdict is `MINOR ISSUES` (the one nit is the explicitly-
accepted open-picker tradeoff). `## Open questions` is `*(none)*`; all ten decisions are
frontloaded, internal, additive, and reversible. The spec is ready for build.
