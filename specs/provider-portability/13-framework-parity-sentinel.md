---
status: proposal
date: 2026-05-18
author: echo
audience: justin
---

# Framework Parity Sentinel — design proposal

## What this is

A sentinel that keeps Instar maximally compatible across frameworks (Claude Code, Codex CLI, future: Gemini CLI, etc.) by detecting drift between framework-specific representations of the same logical resource and either fixing it or surfacing it to the operator.

Concretely: when a user installs Instar with Claude Code, then enables Codex, the sentinel automatically renders the Codex-side mirrors (AGENTS.md, `.agents/skills/`, etc.) so the agent works equivalently in both. When the user adds a skill under one framework, the sentinel mirrors it to the others. When framework-specific files drift apart from their canonical source, the sentinel detects it.

## Research foundation

Three parallel research passes underpin this proposal:

1. **Skill protocol comparison (web research, authoritative docs)** — what does Anthropic's Claude Code spec say, what does Codex CLI 0.130 actually load, where do they diverge?
2. **Substrate gap inventory (in-repo scan)** — every file in Instar that's framework-aware vs the (much larger) set of files that assume Claude conventions silently.
3. **Cartographer + existing sentinel patterns** — so the new sentinel inherits the established shape rather than reinventing.

## Findings that change the design

### Finding 1: Instar's Codex skill path is wrong

- **Instar currently writes:** `.agent/openai/skills/<n>/SKILL.md` (singular `.agent`, provider-namespaced).
- **Codex 0.130 documented path:** `.agents/skills/<n>/SKILL.md` (plural `.agents`, shared across providers).
- **Codex 0.130's actual behavior on `.agent/openai/skills/`:** unverified. Likely loaded as nothing, since Codex's discovery walks the documented path.

Instar may be writing skills Codex never reads. This is the highest-confidence drift in the codebase and it should be confirmed and fixed *before* building the sentinel — otherwise the sentinel's first rule will be encoding a bug.

### Finding 2: Instar's skill frontmatter is silently wrong for both frameworks

- Instar emits `metadata.user_invocable: "true"` (nested under `metadata`, string-valued).
- Claude Code's spec: `user-invocable: true` (top-level, hyphenated, boolean).
- Codex's spec: doesn't surface a `user-invocable` field at all — uses different metadata.

Today's emitter writes a key neither side parses. Fixable independent of the sentinel.

### Finding 3: ~20 places assume `.claude/` without checking framework

Concentrated in: transcript path readers (PreCompactionFlush, TokenLedger, SessionResumeIndex), bootstrap commands (init, setup, CapabilityMapper, scaffold/templates), monitoring scopes (CompactionSentinel, TemplatesDriftVerifier, ScopeCoherenceTracker), user-facing paths (TelegramMarkdownFormatter, telegramRelayPrompt). Most are *latent* — they wouldn't fire on a pure-Claude install but would silently no-op on a Codex install.

Full inventory: 9 framework-aware files (good), ~20 Claude-leaning files (drift candidates), 6 sentinels framework-aware vs 8 not, 3 CLI commands framework-aware vs 7 not.

### Finding 4: The existing cartographer is full-scan, not incremental

`src/core/ProjectMapper.ts` regenerates from scratch on demand; no per-file mtime/sha tracking. Sentinels that need incremental scanning maintain their *own* high-water marks (CommitmentSentinel uses `topicHighWaterMark: Record<topic, lastMid>`; SessionActivitySentinel uses `lastDigestedAt`).

So: the cartographer is the right CONSUMER, not the right STORAGE for staleness. The new sentinel stores its own scan-cursor state.

## The proposal

### Layer 1: Parity Rules (declarative registry)

A new file `src/monitoring/parity/parityRules.ts` exports a static array. Each rule:

```typescript
interface ParityRule {
  id: string;                            // 'identity-shadow', 'skill-mirror', 'hook-mirror'…
  appliesTo: IntelligenceFramework[];    // which frameworks this rule cares about
  source: {
    path: string;                        // canonical or first-discovered path
    discovery: 'canonical' | 'glob';     // single file vs pattern
  };
  targets: Array<{
    framework: IntelligenceFramework;
    path: string;                        // mirror path under that framework
    render: 'identity' | 'rename' | 'transform'; // how source becomes target
  }>;
  validate: (sourcePath, targetPath) => 'in-sync' | 'drift' | 'missing-target';
  remediate: (sourcePath, targetPath) => Promise<void>;
  expectedFrequency: 'on-enable' | 'on-source-change' | 'interval-only';
}
```

Examples:

- **identity-shadow** — source `.instar/AGENT.md`, targets `CLAUDE.md` + `AGENTS.md` + `GEMINI.md`. Already handled by `IdentityRenderer` — rule wraps that for sentinel consumption.
- **skill-mirror** — source `skills/<n>/SKILL.md` (canonical), targets `.claude/skills/<n>/SKILL.md` + `.agents/skills/<n>/SKILL.md`. Skill body is identical; frontmatter renders per-framework (Claude-friendly vs Codex-friendly fields).
- **scripts-mirror** — source `.claude/scripts/<x>` (legacy canonical), targets to confirm under `.codex/scripts/` or whichever convention Codex actually wants.
- **conversational-action-catalog** — when a new SKILL.md mentions a /command, the sentinel appends a one-line entry to AGENTS.md/CLAUDE.md's "Conversational Skills Index" section. This is the higher-layer Justin asked about earlier.

Rules are the GAP MAP. Adding a rule is how operators declare a new parity invariant. The registry is small and reviewable — order of 10–20 rules covers the substrate.

### Layer 2: The Sentinel itself

`src/monitoring/FrameworkParitySentinel.ts`. Inherits the standard pattern (EventEmitter + state file + dedup by territory):

- **Construction**: deps include `projectDir`, `stateDir`, `enabledFrameworks` (from config), `parityRules` (the registry).
- **Triggers**:
  1. **On framework-enable** — invoked by `instar route` / config change / new framework binary detected. Runs full scan + remediates.
  2. **On source-change** — chokidar-style filesystem watcher on the rule source paths. Fires the rule's `remediate`. (Skill add → mirror to others.)
  3. **On interval** — every 30 min, scan rules whose `expectedFrequency` includes `'interval-only'`. Catches drift from manual edits.
- **State persistence**: `.instar/state/framework-parity-sentinel.json` with `{ rulesScanned: Record<ruleId, { lastScanAt, lastSourceMtime, lastResult }> }`. Survives restart.
- **Output**:
  - EventEmitter: `parity:gap-found`, `parity:remediated`, `parity:conflict`.
  - DegradationReporter on rule failures.
  - HTTP API: `GET /api/framework-parity/status` (current rule state), `POST /api/framework-parity/scan` (force a full pass).
- **Staleness model** (Justin's "stale" / "new" / "scanned recently" classification):
  - `new`: rule.source matches files the sentinel has never seen.
  - `stale`: source mtime > `lastSourceMtime` recorded in state.
  - `fresh`: source mtime ≤ `lastSourceMtime`. Skip.
  - On interval scans, only `new` and `stale` rules execute.

### Layer 3: Self-knowledge integration

The agent (when receiving a natural-language config request) should be able to *ask* the sentinel about parity state. Two endpoints make this conversational:

- `GET /api/framework-parity/status` returns "what's installed, what's missing, what drifted." Agent uses this when user asks "are we set up for Codex?" or "can I switch to local model" (which requires Codex framework + skill mirrors).
- `POST /api/framework-parity/remediate?rule=skill-mirror` — explicit, auditable, scoped. Agent calls this when user says "fix it" / "set up Codex too."

This is the same shape as `/local-model` — it's the conversational-action substrate Justin asked for, just generalized.

## What ships in phase 1 (verify-first)

Before building the sentinel:

1. **Empirically verify Codex 0.130 path.** Install a skill at `.agents/skills/test/SKILL.md` (Codex documented path) AND `.agent/openai/skills/test/SKILL.md` (Instar's current path). Drive a Codex session that runs `/test`. See which one loads.
2. **Empirically verify Claude frontmatter.** Install a skill with `user-invocable: true` (top-level) and one with `metadata.user_invocable: "true"` (nested). Check which Claude auto-discovers.

Both verifications are 10 minutes each. They lock the FIRST TWO parity rules before any sentinel code lands.

## Phased rollout

| Phase | Scope |
|---|---|
| 0 | Verify Codex skill path + Claude frontmatter via live tests. Fix the silent emitter drift (one PR). |
| 1 | Parity registry + 4 seed rules (identity-shadow, skill-mirror, scripts-mirror, hook-mirror). No sentinel yet — just `npm run parity:scan` CLI that consumes the registry. |
| 2 | FrameworkParitySentinel: on-enable + interval trigger. State file + EventEmitter. `/api/framework-parity/status`. |
| 3 | Filesystem watcher for source-change trigger (skill added under one framework → mirrored to others). |
| 4 | Generalize: agent gains the "conversational-action catalog" appendix; new SKILL.md auto-indexes itself in AGENTS.md/CLAUDE.md. |

## Open questions / where I'd like your input

- **Mirror direction asymmetry.** When skill is added under `.claude/skills/`, do we mirror to `.agents/skills/`? Or treat the canonical source as `skills/<n>/SKILL.md` (already shipping in the repo) and mirror BOTH framework outputs from there? The repo-root `skills/` directory exists today — leaning toward making that the source-of-truth and treating the framework dirs as renderings.
- **Conflict resolution.** Operator edits `.claude/skills/X/SKILL.md` directly. Source-of-truth is `skills/X/SKILL.md`. Sentinel sees drift. Does it (a) overwrite the operator's edit with re-render, (b) overwrite source with operator's edit, or (c) emit conflict + leave both for resolution? Leaning toward (c) — never silently overwrite operator intent.
- **Codex-specific rendering of skill frontmatter.** If Codex needs a sibling `agents/openai.yaml` for tool dependencies, do we encode that in the skill markdown as a special section and have the sentinel extract it? Or keep it framework-specific outside the canonical skill?
- **How autonomous to make remediation.** On framework-enable, should the sentinel auto-fix without asking? Or surface "I detected 4 gaps, want me to fix?" Leaning toward auto-fix for trivially-derivable mirrors (identity shadow, skill mirror) and operator-confirm for anything involving content transformation.

## Estimate

Phase 0: 1 hour (verification + emitter fix).
Phase 1: 3-4 hours (registry + scan CLI + 4 rules + tests).
Phase 2: 4-6 hours (sentinel + state + routes + tests).
Phase 3: 2-3 hours (chokidar watcher).
Phase 4: 2-3 hours (conversational-action layer using the registry).

Total: ~half a day to a full day, gated on Phase 0 verification.
