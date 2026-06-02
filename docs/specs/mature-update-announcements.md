---
title: "Maturity-aware user-facing update announcements (stop misrepresenting unfinished features)"
date: 2026-06-02
author: echo
status: approved
parent-principle: "Near-Silent Notifications"
review-convergence: internal-multi-reviewer-2026-06-02
approved: true
approved-by: Justin
approved-via: 'Telegram topic 18250 (2026-06-02): "This is perfect. Yes, please proceed." — approving the design + all three recommended fork defaults (silent-by-default polarity, Experimental/Preview/Stable vocabulary, suppress bare patch-level restart narration).'
tier: 2
eli16-overview: mature-update-announcements.eli16.md
decisions-resolved:
  - "polarity → silent-by-default (Fork 1, recommended)"
  - "maturity vocabulary → Experimental/Preview/Stable (Fork 2, recommended)"
  - "restart/ops notices → suppress bare patch-level narration, keep restart-hold warnings (Fork 3 option b, recommended)"
---

# Maturity-aware user-facing update announcements

> **APPROVED 2026-06-02 (Justin, Telegram 18250).** Tier-2 spec per the tiered
> development process. All three forks in §6 resolved to the recommended
> defaults; the design below is the build contract.

## Problem

The agent narrates updates into the user's "Agent Updates" Telegram topic, but
the announcement layer has **zero awareness of feature maturity or user
relevance**. Concretely, three independent paths can post there and none of them
asks *"is this user-relevant? is the feature actually ready? how mature is it?"*:

1. **Auto-restart narration** — `AutoUpdater.gatedRestart()` /
   `handleDampenerBatch()` (`src/core/AutoUpdater.ts:755,812,815,869`). Hardcoded
   operational lines ("Just updated to v… Restarting…"). Already silent on idle
   restarts (`src/core/AutoUpdater.ts` ~782: "No active sessions — silent
   restart"), but narrates on every active-session restart regardless of whether
   the version carries anything a user cares about.
2. **Agent ship-narration** — `POST /telegram/post-update`
   (`src/server/routes.ts:6165`). Passes a junk/tone gate (`checkOutboundMessage`)
   but nothing about feature readiness.
3. **Upgrade-guide notification** — `UpgradeNotifyManager.buildPrompt()`
   (`src/core/UpgradeNotifyManager.ts:196-258`). A short session reads the
   release's upgrade guide and composes a warm blurb. Its prompt literally says
   **"Lead with the biggest USER-VISIBLE feature"** with no maturity concept —
   this is what dressed up the infancy-stage Gemini CLI PR (#693) as a finished
   feature: *"🎯 Gemini agent setup just got more reliable … No action needed on
   your end."* The framing implied a working, mature capability and a minor
   improvement, when Gemini support is in its infancy.

**The irony:** maturity is *already tracked internally*. Every staged feature has
a rollout stage derived purely by observation — `deriveRolloutStage()` in
`src/core/featureRollout.ts` returns `dark | dry-run | live | default-on`. Gemini
support ships effectively `dark`. That signal exists; it is simply never
connected to what the user sees. The user-facing layer has no idea the thing it
is announcing ships disabled.

This is a production-maturity problem: rapid updates are fine and will continue,
but the *user experience* of update announcements must (a) be quiet about things
that are internal/infra or not user-relevant, and (b) tell the truth about how
ready a feature is when it does speak.

## Goals

- **Silent by default for the user.** Most updates are infra; the user should
  hear nothing about them. A user-facing announcement becomes an *explicit
  promotion*, not the default.
- **Honest maturity framing.** When a feature *is* announced, the message conveys
  its readiness (experimental / preview / stable) instead of a uniform victory
  lap.
- **Decide at authorship, not at announce-time.** The user-announcement decision
  is authored when the release's upgrade/migration notes are written — not
  improvised later by whatever short session happens to compose the blurb.
- **Structure informs, the author decides, the decision is audited** (the "Body
  and the Mind" constitution article). The already-known rollout stage becomes a
  *signal* that flags incoherent announcements; a human/LLM still makes the call.

## Non-goals

- **No change to agent-facing detail.** The upgrade guide and migration notes the
  *agent* consumes (Step 2 memory update; `PostUpdateMigrator`) stay fully
  detailed and verbose. This spec adds a *user-facing editorial layer on top* —
  it never thins what the agent learns.
- **Not reducing update frequency.** Frequent updates continue. This governs
  *announcements*, not the cadence of shipping.
- **Not a new maturity-tracking system.** We reuse the existing
  `deriveRolloutStage()` observation as the signal; we do not invent a parallel
  tracker.

## Decision

Introduce a structured **user-announcement block** in the release's upgrade guide
(`upgrades/<version>.md`) — the single artifact that already drives the
user-facing message. Each notable change in a release gets an explicit entry
declaring its audience and maturity; **absence of a `user` entry means no user
message is composed at all** (silent). The announcement-composing layer becomes a
*renderer* of that decision rather than an improviser.

```yaml
---
user_announcement:
  # DEFAULT: nothing here reaches the user. Each `audience: user` entry is an
  # explicit promotion authored when the release notes are written.
  - audience: user            # user | agent-only  (agent-only never reaches a user message)
    maturity: experimental    # experimental | preview | stable
    headline: "Early Gemini CLI support"
    body: "Starting to support Gemini-backed agents. Landing piece by piece — not ready for general use yet; I'll tell you when it is."
---
# (detailed agent-facing guide prose continues below, unchanged & verbose)
```

## Design

### D1 — Upgrade-guide announcement block (the authored decision)

- The upgrade guide gains an **optional** YAML front-matter key `user_announcement`
  (a list of entries). Parsed by a small pure helper
  `src/core/upgradeAnnouncement.ts` → `parseUserAnnouncement(guide): AnnouncementEntry[]`
  with fields `{ audience: 'user'|'agent-only', maturity: 'experimental'|'preview'|'stable', headline: string, body: string }`.
- Back-compat: a guide with **no** front-matter parses to `[]` → which, under the
  silent-by-default polarity (§6 Fork 1), means **no user message** for that
  release. (Existing guides are historical; this only affects future releases.)
- The prose below the front-matter is untouched and remains the agent-facing
  guide consumed by the memory-update step.

### D2 — `UpgradeNotifyManager`: render the decision, don't improvise

Rewrite `buildPrompt()` (`src/core/UpgradeNotifyManager.ts:196`) and the
`notify()` flow (`:122`):

- Parse `user_announcement` from the pending guide.
- **If there are no `audience: user` entries → skip Step 1 entirely.** Still run
  Step 2 (MEMORY.md update — consumes the full detailed guide) and Step 3
  (`instar upgrade-ack`). This is the silent-by-default flip: the agent still
  *learns* the capability; the user just isn't told.
- **If there are `audience: user` entries**, the prompt composes *only* from those
  entries, and the offending line *"Lead with the biggest USER-VISIBLE feature"*
  is **removed**. Each entry's `maturity` drives framing + a badge:
  - `stable` → confident "here's a new thing you can use right now" framing, no badge.
  - `preview` → "available to try, still rough around the edges" + a **Preview** badge (🧪).
  - `experimental` → "early, not ready for general use; I'll tell you when it is" + an **Experimental** badge (⚗️). Never implies completeness.
- The composed message still obeys the existing voice rules (conversational, no
  jargon, no version numbers in headers) and still routes to the Agent Updates
  topic via the reply script.

### D3 — Release authoring: default to agent-only + a forgot-block guard

In `scripts/analyze-release.js` (the `--draft-guide` path already exists and
writes `upgrades/NEXT.md` with `auto-draft-unreviewed` markers the publish gates
reject until reviewed):

- When drafting, **auto-populate `user_announcement` entries from the change
  classification but default every entry to `audience: agent-only`.** Promotion to
  `audience: user` is a deliberate human edit. This is the structural opt-in —
  nothing reaches the user unless the release author lifts it. Because the draft
  scaffolds the block, an un-reviewed block is SAFE (it announces nothing).
- **Forgot-block author guard (Body-and-Mind — structure informs, author
  decides):** in the analyzer's main (validation) path, when a release ships
  user-relevant changes (feature/enhancement) but the guide carries **no
  `user_announcement` block at all**, emit a NON-BLOCKING advisory: *"this
  release has N user-relevant change(s) but no `user_announcement` block —
  nothing will be announced; add one if any change is user-ready, otherwise the
  silence is correct."* It fires only on the block's total absence (the
  `--draft-guide` scaffold means absence implies the scaffold was bypassed), so
  it is low-noise. The author decides; it never blocks.
- Coherence between the chosen maturity and the feature's rollout stage lives at
  the authoring layer (the human sees the rollout stage when promoting an entry);
  it is intentionally NOT a separate code path, to avoid a brittle headline→flag
  map in CI and to keep `upgradeAnnouncement.ts` focused purely on the notify
  path.

### D4 — Restart/operational notices (separate class)

Operational restart lines are *not feature news*; they are a different class and
get handled per §6 Fork 3 (recommended: suppress the bare patch-level "Just
updated… restarting" narration; keep the *restart-hold* warnings, which are genuinely
useful — "your active work is holding a restart"). No change to the cascade
dampener (it already coalesces) or the idle-silent path.

### Where the pieces live

| Piece | File | Change |
|---|---|---|
| Parse + frame + assemble helper | `src/core/upgradeAnnouncement.ts` (new) | pure `parseUserAnnouncement()`, `frameByMaturity()`, `renderAnnouncementBrief()`, `stripAnnouncementFrontmatter()`, `serializeUserAnnouncement()` |
| Compose gating | `src/core/UpgradeNotifyManager.ts` (`buildPrompt`) | skip-when-no-user-entries; maturity framing; drop the "biggest user-visible feature" line |
| Hoist + merge | `src/core/UpgradeGuideProcessor.ts` (`process`) | lift each guide's block to byte 0 of the concatenated pending guide; no-op when none carry a block |
| Release authoring | `scripts/analyze-release.js` | `--draft-guide` auto-fills entries as `agent-only`; main path emits the forgot-block advisory |
| Restart notices | `src/core/AutoUpdater.ts` + `src/commands/server.ts` (Fork 3) | suppress patch-level narration; preserve handshake verification via empty `deferredNotification` |
| Agent awareness | `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (`migrateClaudeMd`) | maturity-honesty guidance for new + existing agents |

## Safety / blast radius

- **Fail-safe direction is silence, not spam.** A parse failure or missing block
  yields *no user message* (never a malformed or duplicated one). Worst case is a
  release the user isn't told about — recoverable with a later note — versus
  today's worst case of a misleading announcement.
- **Agent learning is untouched.** Step 2 (MEMORY.md) consumes the full guide
  regardless of announcement entries, so capability awareness never regresses.
- The coherence check is a **warning**, never a hard publish block — it cannot
  wedge a release.

## Testing (all three tiers — Testing Integrity Standard)

- **Unit — helper** (`tests/unit/upgrade-announcement.test.ts`):
  `parseUserAnnouncement` on (a) no front-matter → `[]`, (b) `agent-only`-only →
  no user entries, (c) mixed audiences, (d) malformed YAML → `[]` (fail-safe),
  (e) unknown audience/maturity dropped. `frameByMaturity` badge/caveat per rung.
  `serializeUserAnnouncement ↔ parseUserAnnouncement` round-trip with special
  YAML chars. `stripAnnouncementFrontmatter` identity-when-absent + body-preserve.
  Both sides of every boundary.
- **Unit — compose** (`tests/unit/upgrade-notify-maturity.test.ts` + the updated
  `UpgradeNotifyManager.test.ts`): a guide with no `user` entries → **Step-1
  SKIP**, Steps 2/3 still run, old "biggest user-visible feature" line gone; an
  `experimental` entry → prompt carries the experimental framing + badge,
  composes only from the brief. The brief reflecting the parsed front-matter is
  the wiring proof that `buildPrompt` invokes the real parser.
- **Unit — processor hoist** (`tests/unit/upgrade-guide-processor.test.ts`):
  multi-guide merge lifts blocks to byte 0 (parser reads them); no-op when no
  guide carries a block (byte-identical, no leading front-matter).
- **E2E** (`tests/e2e/upgrade-guide-lifecycle.test.ts`): production guide →
  pending-guide file → notify path; the announce branch fires only with a
  user-facing entry (feature is *alive* through the real pipeline).
- **Release-analyzer** (`tests/unit/analyze-release-announcement.test.ts`):
  `--draft-guide` fills entries as `agent-only`; the emitted block round-trips
  through the parser to ZERO user-facing entries; the main-path forgot-block
  advisory fires when a user-relevant guide lacks the block and stays quiet when
  it carries one.
- **Migration parity** (`tests/unit/PostUpdateMigrator-maturityHonesty.test.ts`):
  `migrateClaudeMd` backfills the maturity-honesty section for existing agents,
  idempotently, and the template emits the same marker for new agents.
- **AutoUpdater Fork 3** (`tests/unit/graceful-updates-phase2.test.ts`):
  patch-only bump suppresses narration but still restarts; a minor+ bump still
  narrates.

## Migration parity

- **New agents**: get the new `UpgradeNotifyManager` / `UpgradeGuideProcessor`
  behavior in `dist` and the maturity-honesty CLAUDE.md guidance from
  `generateClaudeMd` — no config needed (behavior is in code).
- **Existing agents**: the runtime behavior is shipped code delivered via the
  normal npm update — no `.claude/settings.json` / `.instar/config.json`
  migration required. The silent-by-default polarity takes effect for the *next*
  release's guide.
- **CLAUDE.md guidance (required)**: `PostUpdateMigrator.migrateClaudeMd` backfills
  the **Maturity honesty** section into existing agents' CLAUDE.md (content-sniffed
  on the marker the template emits, idempotent). Without this, deployed agents
  would keep self-narrating ships the old (overselling) way — an Agent-Awareness /
  Migration-Parity gap. Covered by `PostUpdateMigrator-maturityHonesty.test.ts`.

## Agent Awareness

Update the CLAUDE.md template (`src/scaffold/templates.ts → generateClaudeMd()`):
the "Agent Updates topic" section gains a note that user announcements are now
*opt-in + maturity-tagged*, authored in the release's upgrade guide, and that
experimental/preview features are labeled as such (so an agent narrating its own
ship via `/telegram/post-update` mirrors the same honesty and does not imply a
dark feature is finished).

## 6. The three forks — RESOLVED

> Approved by Justin (Telegram 18250, 2026-06-02): "This is perfect. Yes, please
> proceed." All three resolved to the recommended defaults below; they are the
> build contract.

**Fork 1 — Polarity → SILENT-BY-DEFAULT.** Each user announcement is an explicit
`audience: user` promotion; absence of a `user` entry composes no user message.
The single biggest lever on the noise, and it makes "the user hears about it" a
deliberate act.

**Fork 2 — Maturity vocabulary → EXPERIMENTAL / PREVIEW / STABLE.** Three clear
rungs that map onto the existing rollout stages (`dark`→Experimental,
`dry-run`/`live`→Preview, `default-on`→Stable) while staying user-friendly.

**Fork 3 — Restart/operational notices → SUPPRESS BARE PATCH-LEVEL NARRATION,
KEEP RESTART-HOLD WARNINGS.** The restart-hold warnings ("your work is holding a
restart") are genuinely useful; the bare patch-bump "Just updated… restarting"
line is pure noise and is suppressed (the idle-silent and cascade-dampener paths
are unchanged).
