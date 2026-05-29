# Side-effects review — PresenceProxy post-ack Tier-1 suppression

**Scope**: Remove the redundant first-tier standby that PresenceProxy posts
*after* the agent has already acked the user (observed live in the Codey-
over-Telegram dogfooding run). Suppress the Tier-1 MESSAGE on a recent ack while
keeping the tier chain armed so stall detection is unchanged.

**Files touched**:
- `src/monitoring/PresenceProxy.ts` — in `fireTier1`, add a post-ack
  early-return: if `state.lastAckText && state.lastAckAt !== null &&
  state.lastAckAt >= state.userMessageAt`, set `tier1FiredAt`, persist, schedule
  Tier 2, and return WITHOUT sending a message. Removed the prior
  `isPostMessageDeltaAckOnly` placeholder `else if` branch (now subsumed — the
  new check fires earlier and is broader).
- `tests/unit/presence-proxy-race-guard-ack.test.ts` — replaced the
  placeholder-assertion block with three cases: codex-pane suppression,
  ack-gating, stall-detection preservation.
- `tests/unit/presence-proxy-ack-and-baseline.test.ts` — updated the two
  brief-ack tests that asserted "Tier 1 fires a message after an ack" to the new
  "Tier 1 suppressed, chain stays armed" behavior.
- `docs/specs/presence-proxy-ack-and-baseline.md` — Layer C amendment +
  `eli16-overview` frontmatter + amendment provenance.
- `docs/specs/presence-proxy-ack-and-baseline.eli16.md` — NEW (the spec lacked
  the now-required ELI16 overview; created it covering all three layers).
- `upgrades/NEXT.md` — release note (patch bump).

**Under-block (does it ever now FAIL to reassure / FAIL to catch a stall?)**:
- Suppression is strictly ack-gated. With NO ack, Tier 1 fires exactly as
  before (tested: "ack-gating"). So the "first signal of life on genuine
  silence" path is untouched.
- The tier CHAIN is preserved: the suppression sets `tier1FiredAt` (which
  `fireTier2` requires at line ~1102) and schedules Tier 2. So an ack-then-stall
  is still caught at the 2-minute tier and by Tier 3 (tested: "stall detection
  preserved"). This is the critical guard against re-opening the
  "silently-stopped" standby-flood/silence bug this spec originally fixed.

**Over-block (does it suppress something the user WANTED?)**:
- It withholds only the FIRST-tier standby, and only when the agent already
  acked — i.e. only when the message would be redundant with the ack. Tier 2
  (substantive 2-min progress) and Tier 3 (stall) are never suppressed by this
  change.
- Quota-exhaustion detection still runs BEFORE the suppression (placement is
  after the quota block), so an ack-then-quota-stall still surfaces the quota
  message.
- Conversation-mode richer Tier-1 is only skipped when an ack is present;
  without an ack, conversation mode is unchanged.

**Level-of-abstraction fit**: The change lives entirely inside
`PresenceProxy.fireTier1` — the one place that decides the Tier-1 message. It
keys off existing state (`lastAckText`/`lastAckAt`, already populated by the
Layer A ack machinery) — no new fields, no new helpers, no change to the shared
`isSystemOrProxyMessage` / `isBriefAck` classifiers.

**Signal vs authority**: No authority change. The ack remains a SIGNAL (it
withholds a redundant standby; it does not cancel the safety chain). The
authorities are unchanged: a substantive reply cancels the chain; the LLM still
authors any tier message that does fire.

**Interactions**:
- `isPostMessageDeltaAckOnly` stays exported (still unit-tested) but is no
  longer called from `fireTier1`; its placeholder branch is removed. No other
  caller (verified by grep).
- Tier 2/3 logic untouched. Cancel-on-substantive-reply untouched.
- Framework-agnostic: keys off the ack, not the tmux pane — so it fixes codex
  agents (whose pane stream noise defeated the old ack-only-delta short-circuit)
  as well as claude agents.

**Migration parity**: Pure `dist/` code change — no agent-installed files
(settings hooks, config defaults, CLAUDE.md template, hook scripts, skills)
touched. Existing agents pick it up on the normal `instar` package auto-update.
No `PostUpdateMigrator` entry required.

**Rollback cost**: Single-file revert (`PresenceProxy.ts`) + test revert. No
schema/API/on-disk changes.

**Spec**: `presence-proxy-ack-and-baseline.md` Layer C (amendment approved by
Justin, topic 13435, 2026-05-28 — Codey-dogfooding "P1 - yes").
