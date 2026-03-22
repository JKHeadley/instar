# Track B: Evolution System Granularity

## Summary
Evolution is architecturally all-or-nothing (single config flag), but practically configurable through job definitions and prompt editing. The post-action-reflection hook fires unconditionally. API endpoints return 503 when evolution is disabled, blocking manual skill usage. The action queue is operationally coupled to the evolution system despite architectural independence.

---

## B1: Can subsystems be enabled independently? [VERIFIED]

**Location:** `src/core/types.ts:792-805`

**No granular toggles.** `EvolutionManagerConfig` has:
```typescript
{
  stateDir: string;           // required
  autoImplement?: boolean;    // optional
  maxProposals?: number;      // retention limit
  maxLearnings?: number;
  maxGaps?: number;
  maxActions?: number;
}
```

In `InstarConfig` (types.ts:1422): `evolution?: EvolutionManagerConfig` — optional, but binary.

**However:** `src/commands/server.ts:2840-2845` always instantiates `EvolutionManager` with a comment: `"// Set up evolution system (always enabled — the feedback loop infrastructure)"`. This means the evolution system is always created when configured — there's no per-subsystem on/off.

---

## B2: Can jobs be disabled individually while keeping data collection? [VERIFIED]

**Location:** `src/commands/init.ts:2027-2111`

**Yes.** Each evolution job has an `enabled` field in `.instar/jobs.json`:
- `evolution-review` (line 2027): `enabled: true`
- `insight-harvest` (line 2056): `enabled: true`
- `commitment-check` (line 2087): `enabled: true`

Set `enabled: false` on any job to disable it.

**But:** The `post-action-reflection` hook (PostUpdateMigrator.ts:2167-2275) fires regardless — it never checks evolution config. It injects prompts like "Did this teach you something? → /learn" after significant actions (git commit, deploy, npm publish, etc.).

---

## B3: Does evolution-review auto-implement? [VERIFIED]

**Location:** `src/commands/init.ts:2027-2054`, `src/core/EvolutionManager.ts:254-288`

**The standard job is human-reviewed.** The prompt says:
> "Review pending evolution proposals, evaluate their merit, and implement approved ones."

Steps: evaluate → PATCH status to approved/rejected/deferred → if approved, implement → PATCH status to implemented.

**Separate auto-implementation path:** `processProposalAutonomously()` (EvolutionManager.ts:254-288) only runs when:
- `autonomousEvolution` AND `autonomyManager` are wired
- AND autonomy profile is set to `'autonomous'`

This is NOT the default scheduled job behavior.

---

## B4: Can evolution-review triage-only (no implement)? [INFERRED]

**Yes, by editing the job prompt.**

The `execute.value` field in `.instar/jobs.json` is a plain text prompt. Modify it to stop after the approve/reject/defer step and omit the "then implement it" instruction. Since jobs are just prompts executed by Claude, this is fully customizable.

No built-in toggle — requires manual prompt editing.

---

## B5: Does post-action-reflection fire regardless of evolution config? [VERIFIED]

**Location:** `src/core/PostUpdateMigrator.ts:2167-2275`, `src/commands/init.ts:2994,3425`

**Yes, unconditionally.** The hook:
- Is installed during init with no conditional check
- Registered in `.claude/settings.json` PostToolUse unconditionally
- Never reads evolution config at runtime
- Fires after significant actions (git commit, deploy, npm publish, docker, curl)
- Injects evolution prompts (/learn, /gaps, /evolve, /commit-action)

**No way to disable without removing from settings.json manually.**

---

## B6: Can manual evolution skills work if evolution is disabled? [VERIFIED]

**Location:** `src/server/routes.ts:4605-4782`

**No.** All evolution write endpoints check `ctx.evolution`:
```typescript
if (!ctx.evolution) {
  res.status(503).json({ error: 'Evolution system not configured' });
  return;
}
```

Affected endpoints:
- `POST /evolution/proposals` (line 4605)
- `POST /evolution/learnings` (line 4658)
- `POST /evolution/gaps` (line 4720)
- `POST /evolution/actions` (line 4778)

Read-only endpoints return empty arrays gracefully.

---

## B7: Action queue independence [VERIFIED]

**Location:** `src/core/EvolutionManager.ts:493-601`, `src/server/routes.ts:4766-4817`

**Architecturally independent** — separate file (`action-queue.json`), separate methods (`addAction()`, `updateAction()`, `listActions()`, `getOverdueActions()`), separate API endpoints.

**Operationally coupled** — all action endpoints guarded by `if (!ctx.evolution)`. Cannot use action queue without evolution enabled.

---

## B8: What model does evolution-review use? [VERIFIED]

**Location:** `src/commands/init.ts:2033,2062,2093`

| Job | Model | Configurable? |
|-----|-------|---------------|
| `evolution-review` | `opus` | Yes, via `model` field in jobs.json |
| `insight-harvest` | `opus` | Yes |
| `commitment-check` | `haiku` | Yes |

All jobs have a `model: ModelTier` field (types.ts:65-66) editable in `.instar/jobs.json`.
