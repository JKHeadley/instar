<!-- bump: patch -->
## What Changed

Fourth piece of the context budget's Phase 2 (shadow folding, still switched off): the throwaway session that takes the practice quiz, and the narrow access it needs.

- **`runShadowAnswerer`** (`src/monitoring/foldShadowAnswerer.ts`):
  - starts a one-shot Claude Code session seeded with the restore bundle, under the live session's model;
  - the session has none of the agent's credentials and only the Bash tool, and is bounded in time;
  - its tool-policy marker is written before it starts;
  - it collects the answers, and counts a lookup only when the session's own transcript shows it happened.
- **Spawn options.** `SessionManager.spawnSession` accepts `instarSessionId` (a caller-chosen session id) and `memorySessionToken` (a narrow token, only with `omitAuthEnv`, set after credentials are blanked).
- **Probe token.** `MemoryPrivacy.issueFoldProbeToken` binds the token to a new synthetic place, `fold-probe:<topic>`.
- **Session guard.** That place can reach only its own topic's chunk lookups (`GET /topic/:id/chunks`, `/topic/:id/chunks/:key`), and the chunk handlers re-check it. It is refused everywhere else.
- **Fold-marker hook.** It now allows those two exact lookup paths, for marked sessions only. It reaches existing agents on update.

Nothing starts the answerer yet. Existing spawns are unchanged.

## What to Tell Your User

Nothing changes yet. This is the safe practice session the context budget will use to check that a shrunken conversation still remembers what matters. It can only read that one conversation's older summaries. It switches on later, after testing.

## Summary of New Capabilities

- None user-visible yet. Internal: the shadow answerer, the fold-probe session token, and two spawn options for one-shot confined sessions.

## Evidence

- Unit: `fold-shadow-answerer` (7) covers the marker existing before the spawn, the credential-free spawn with the token, lookup corroboration, kill at the bound, revocation on every path, and refusal of unsafe ids. `session-manager-confined-spawn` (+4) covers the token after the blanking on both lanes, the chosen id, and the refusals. `memory-session-guard` (+17) covers the fold-probe place reaching only its own chunks. `memory-privacy` (+1) and `fold-marker-guard-hook` (+lookup cases) round it out.
- Integration: `fold-probe-token-routes` (3), through the real HTTP pipeline: own-topic chunks pass the guard, another topic and other routes get 403, a revoked token gets 401.
- 845 neighbouring unit tests and 40 integration tests pass. Lint 54/54.
