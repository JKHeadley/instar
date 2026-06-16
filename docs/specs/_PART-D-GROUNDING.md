# Part-D grounding (recentUserMessage promotion) — ready for the spec revision + build

## The fact that invalidates Part B as-converged
- Part B's D8 agreement-invariant (spec lines 94-104) requires gating injection on "the SAME recentUserMessage(topic, window) predicate ReapGuard's open-commitment KEEP-probe already uses."
- BUT that predicate is a STUB: `recentUserMessage: () => false` at src/commands/server.ts:13530 (spread into ReapGuard @~13556 + SessionReaper @~13584). So ReapGuard's open-commitment KEEP-veto is INERT, and reusing the stub ⇒ GAP-B injection never fires (D8 always false).

## Part D design (to add to the spec, then focused re-converge, reaper-class review)
- Promote `recentUserMessage(topicOrThread, windowMs)` from the stub to a REAL query:
  - `messageStore.queryInbox(agentName, { threadId })` EXISTS (src/messaging/MessageStore.ts:166 → Promise<MessageEnvelope[]>); live usage at server.ts:11988 `messageStore.queryInbox(config.projectName, { threadId })`.
  - Predicate = "an inbound USER message on the topic within windowMs (default = ReapGuard staleCommitmentWindowMs, 8h)". Must filter to INBOUND user messages (not agent/system). Ground the MessageEnvelope shape (direction/role + timestamp field) before implementing.
  - topic→threadId mapping: confirm how topicId resolves to the queryInbox threadId (see the 11988 callsite + how server maps topic↔thread).
- SHARED by ReapGuard Gate-I (KEEP) AND the new GAP-B eligibility (D8) → they AGREE → no 2026-06-13 loop.

## Risk analysis (the reaper-class review must engage)
- This is a LIVE ReapGuard KEEP-behavior change: today the KEEP-probe is inert; making it real means ReapGuard now KEEPS sessions that have an open commitment AND a recent user message. Direction = SAFE (keeps likely-in-use sessions; never reaps something active).
- Magnitude: NARROW — only sessions with BOTH a qualifying open commitment AND an inbound user msg < window. Bounded by the window.
- Watch: (a) async — queryInbox is async; ReapGuard's KEEP-probe signature must accommodate (today it's sync `()=>false`). Decide: make the probe async (and ReapGuard awaits it) OR pre-compute recency into a sync snapshot. Grounding needed on ReapGuard's call site (sync vs async). (b) cost — one queryInbox per reap candidate; bound it. (c) fail-open: a throw ⇒ predicate returns false (no KEEP, no inject) — matches D7.

## Build sequence (delegate to a FRESH-CONTEXT subagent, like provider-fallback's build)
1. Add Part D section + the above risk analysis to docs/specs/autonomous-registration-guarantee.md (after Part C).
2. Focused re-converge of Part D (adversarial + lessons/foundation reviewers — the loop-risk catchers). Re-stamp the convergence tag (iteration++).
3. /instar-dev build the FULL feature (Part B + Part D recentUserMessage + Part A surface + Part C stopGate + 3-tier tests) — dev-gate + dryRun via monitoring.resumeQueue; Phase-5 second-pass REQUIRED (reaper).
4. Commit through gate (husky must be wired: `npm run prepare`; parent-principle present; decision file committed; no orphan-deferral negations; release-note no backticks in user sections — ALL the provider-fallback CI-ratchet lessons apply).
5. Push + `gh pr merge <PR> --repo JKHeadley/instar --squash --auto`.

## CI-ratchet pre-clear checklist (learned this session on #1187, apply BEFORE push):
feature-delivery-completeness (track any new migrateClaudeMd marker in legacyMigratorSections); eli16-pr-gate (PR body needs `## ELI16 —` + ≥200 prose chars BEFORE any sub-heading; edit body via `gh api PATCH repos/.../pulls/N` not `gh pr edit` — token lacks read:org); decision-audit (wire husky, gate commits the decision file); repo-invariants (no backticks in release-note "What to Tell Your User"/"Summary"); docs-coverage (this feature adds NO route → neutral); migration-parity-hooks.

## KEY DE-RISKING INSIGHT (added after grounding — changes the risk posture)
The 2026-06-13 catastrophic loop = REAP (ReapGuard KEEP says stale) + REVIVE (eligibility says fresh) → disagreement → loop. The loop REQUIRES the revival path to fire. In this feature, the revival path (the GAP-B commitment-evidence injection) ships DARK/dryRun (monitoring.resumeQueue dev-gate). With injection dark, **no revival happens ⇒ no loop is possible, even if recentUserMessage is live.** The recentUserMessage promotion alone only changes ReapGuard's KEEP behavior in the SAFE direction (keeps a recently-messaged session that's likely in use) — worst case is mild resource-retention pressure, NOT a loop. So the reaper-class catastrophic risk is CONTAINED by the dark injection: ship recentUserMessage live + injection dark, soak, then enable injection only after the dark soak confirms KEEP/eligibility agree on real data.
CONSEQUENCE: the build is less dangerous than first framed — the focused Part-D re-converge should VERIFY this containment (injection genuinely dark; recentUserMessage KEEP change is safe-direction + bounded), and the build can proceed once a fresh-context pass confirms the recentUserMessage sync-vs-async wiring (ReapGuard's probe signature) and the inbound-user-message filter on MessageEnvelope.

## FOCUSED RE-CONVERGE OUTCOME (3 reaper-class reviewers) — corrections applied
- decision-completeness: CONVERGED (0 new user-decisions; window reuses staleCommitmentWindowMinutes 480/8h @ ConfigDefaults.ts:153).
- containment CONFIRMED SOUND (adversarial + lessons, grounded @ ResumeQueueDrainer.ts:311-317: `if(isDryRun()) return blocked:'dry-run'` returns BEFORE the spawn block; ResumeQueue ships dryRun:true) ⇒ injection-dark = loop structurally impossible.
- **F1 (BUILD-BLOCKER, FIXED):** Part D was grounded on the WRONG store — `MessageStore.queryInbox` is the Threadline A2A store, NO Telegram user messages. CORRECTED to `TelegramAdapter.getTopicHistory(topicId, limit)` → LogEntry[] (sync, in-memory tail cache, @ TelegramAdapter.ts:3529). Build filters LogEntry → inbound-user entries, newest timestamp < window. (Building on queryInbox would have re-created the inert-predicate bug.)
- **F2/F2a (FIXED):** recentUserMessage feeds FIVE live sites, not one — ReapGuard.ts:137 (standalone ~30min recency KEEP, recentUserWindowMs), :149 (commitment KEEP 8h, the D8 one), :221/:239 (terminate-path mirrors), + SessionReaper.ts:489 (staleIdle INVERSION `!recentUserMessage`). The stub @ server.ts:13530 spreads into BOTH ReapGuard + SessionReaper. ALL un-stub safe-direction (keep-more). Risk section now names all five.
- sync→async concern DISSOLVED — getTopicHistory is synchronous (cached array), so no async race; the KEEP-probe stays sync.
- REMAINING before build: one LIGHT confirmation round on the corrected Part D (optional — corrections directly address named findings) → re-stamp convergence tag → then /instar-dev build per the build sequence above. Build must ground the LogEntry direction/role + timestamp field names against TelegramAdapter before implementing the inbound-user filter.
