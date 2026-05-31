# Side-Effects Review — Correction & Preference Learning Sentinel, Slice 1b

**Version / slug:** `correction-preference-learning-sentinel-slice1b`
**Date:** `2026-05-30`
**Author:** `echo`
**Second-pass reviewer:** `not required` (signal-only, ships dark; see §"Phase 5 trigger check")

## Summary of the change

Slice 1b adds the sentinel loop that consumes the Slice-1a preferences read-surface: a broadened, distinctly-tagged Layer-0 signal family (preference/frustration) excluded from the guardian-failure heat map; a privacy-safe per-topic ephemeral capture → Tier-1 distillation → both-sided deterministic scrub → `CorrectionLedger` hop, fired VOID off the message-delivery path; a 3-pronged restart-proof recurrence gate (`CorrectionAnalyzer`); and a by-construction authority-bounded router (`CorrectionLoopDriver`) that writes explicit preferences via `recordPreference()`, routes infra-gaps to a human-approved `/feedback` proposal, and downgrades policy-relaxation phrasing to the Attention queue. Plus inline `/corrections` routes, a `correction-analyzer` cron template (off by default), boot wiring, and CLAUDE.md awareness.

The loop is **SIGNAL-ONLY** — it never blocks or rewrites an outbound message (that idea, an "EnforcementGate", was explicitly rejected in the approved spec). It ships **dark** behind `monitoring.correctionLearning.enabled` (default false); only the free, metadata-only Layer-0 classification is always-on.

**Files touched:**
- `src/monitoring/HumanAsDetectorLog.ts` (Layer-0 extension; learning-only categories excluded from `summarizeByLayer()`; `deterministicWeight`/`learningKind` exposed; drift-canary counter).
- `src/monitoring/scrubSecrets.ts` (new — shared, extended-coverage scrub) + `src/monitoring/CiFailurePoller.ts` (imports + re-exports it; back-compat preserved).
- `src/monitoring/CorrectionLedger.ts`, `CorrectionAnalyzer.ts`, `CorrectionLoopDriver.ts`, `CorrectionCaptureLoop.ts` (new core).
- `src/server/routes.ts` (inline `/corrections` + `/corrections/analyze`; `RouteContext.correctionLedger`), `src/server/AgentServer.ts` (construct iff enabled), `src/server/CapabilityIndex.ts` (entry), `src/commands/server.ts` (capture-loop boot wiring).
- `src/scaffold/templates/jobs/instar/correction-analyzer.md` (new, off by default), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (agent awareness + backfill).
- `tests/unit/*` (5 logic + 1 wiring), `tests/integration/corrections-routes.test.ts`, `tests/e2e/correction-learning-lifecycle.test.ts`.
- `upgrades/NEXT.md`, this side-effects artifact.

## Decision-point inventory

- **Layer-0 learning classification** — *new signal*. Deterministic regex; biased toward precision (lone weak rule never fires). Excluded from the heat map by category tag. No authority.
- **`kind` (infra-gap / user-preference / noise)** — *signal*. LLM-set but enum-validated (cannot widen) and ADVISORY for routing only; never blocks or mutates on its own.
- **deterministic-provenance gate field** — *code-determined*. The recurrence gate keys on the Layer-0 weight (code-set), never on `llm_confidence`. An injected prompt cannot steer the gate.
- **policy-keyword filter** — *route-to-human, not veto*. A regex match downgrades to Attention; it does NOT silently block (per the spec's signal-vs-authority P2).
- **routing split** — *pass-through to existing authorities*. `recordPreference()` (Slice-1a primitive), the real `/feedback` route guards, the Attention queue, the Evolution Action / Initiative board (needs-user). No new authority.

## 1. Over-block

No block/allow surface — over-block not applicable. The loop never blocks a message, a tool call, or a user. The strongest action it can take autonomously is writing a preference to `.instar/preferences.json` (which the session-start hook injects as an advisory, envelope-wrapped block) or queuing a human-disposable Attention item.

## 2. Under-block

No block/allow surface — under-block not applicable. The closest analog is a missed learning (regex recall drift); the drift-canary counter exists precisely to make that observable over time, and a missed learning is a lost data point, never an unsafe action.

## 3. Level-of-abstraction fit

Right layer. The new modules sit in `src/monitoring/` alongside the Failure-Learning Loop they are the conversational twin of (`FailureLedger`/`FailureAnalyzer`/`FailureLoopDriver`), mirroring their construction, dedupe-upsert, prune-in-transaction, `toApiView` redaction, and by-construction authority-guard patterns. The capture hop chains onto the same `telegram.onMessageLogged` seam the existing HumanAsDetectorLog / Usher / TopicIntent capture loops use, with the same VOID fire-and-forget + `shouldShed` + per-topic `rateCeiling` discipline. The `/corrections` routes are inline in `routes.ts` (the discoverability-lint allowlist is fixed).

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

**Does this change hold blocking authority with brittle logic?**

- [x] **No — every output is a signal consumed by an existing smart gate or a human.** The loop never blocks/rewrites a message. The by-construction authority guard is re-proven for this loop's two new capabilities (`/feedback` loopback, `recordPreference`): `CorrectionLoopDeps` carries EXACTLY `addAction`, `createInitiative`, `feedbackLoopbackPost`, `recordPreference`, `attentionRoute` — there is no proposal-mint field and no memory-file-write field to forge or misplace. A wiring-integrity test pins the dep surface is exactly those five, and that under "autonomy ON" the loop mints zero proposals and every draft Initiative carries `needsUser: true`.
- The deterministic policy-keyword filter is the one place a regex touches a routing decision, and it does NOT veto — it routes to a human (Attention) per P2. The `/feedback` path traverses the real route's anomaly/quality/length guards (a test pins it refuses to count a blocked POST).

## 5. Interactions

- **Shadowing:** the capture loop chains AFTER the existing TopicIntent/Usher capture loops in the `onMessageLogged` chain; it calls the prior callback first, so it never shadows them. Layer-0 `classify()` is the only thing it runs synchronously on the seam (free, metadata-only).
- **Double-fire:** dedupe is owned by `CorrectionLedger`'s `kind:normalizedLearningHash` upsert (a recurrence increments occurrenceCount, never duplicates). The analyzer's `status:'open'` filter means a routed record is acted on once; the closed-loop verify keys on `dedupeKey`, not the coarse kind, so an unrelated learning in the same regex bucket can't false-reopen.
- **Races:** the capture hop is single-pass per message; the ledger upsert is transactional (occurrence insert + prune + record upsert in one txn). The `LlmQueue` is the sentinel's own instance, so a distill burst cannot starve PresenceProxy/Usher (which share a different queue).
- **Feedback loops:** the `entry.fromUser` gate (not origin threading) is the self-feed guard — the loop never learns from its own outbound text. The loopback `/feedback` POST is bearer-authed to the agent's own route and carries the `X-Instar-Origin: correction-loop` header; it does not re-enter the capture path (capture only observes inbound human Telegram turns).
- **Startup ordering:** the capture loop wires inside the Telegram-up block, after PresenceProxy/TopicIntent/Usher and before `presenceProxy.start()`. The `CorrectionLedger` for the read routes is constructed earlier in `AgentServer` (gated on the flag) so the routes 503-stub cleanly when off.

## 6. External surfaces

- **Other agents on the same machine:** none directly. The infra-gap path's cross-agent consensus is delegated to the existing Rising Tide `/feedback` clustering (single-agent gate-crossing routes a propose-only draft by default; `autoFeedback` is off).
- **Other users of the install base:** purely additive and dark. Existing agents that don't flip `monitoring.correctionLearning.enabled` see byte-identical behavior except the always-on Layer-0 metadata classification, which only grows the existing human-as-detector heat map's metadata (and the new learning categories are excluded from `summarizeByLayer()`, so even that is unchanged).
- **External systems:** **LLM provider egress (disclosed).** When enabled, captured (pre-scrubbed) conversation context is sent to the configured LLM provider for distillation, through the sentinel's own `LlmQueue` (background lane, dedicated daily cap, default 25¢/day per agent). If the operator's provider is unacceptable for this content, the loop stays off — no hidden egress. The `/feedback` loopback (only when `autoFeedback` is on) reaches Dawn's Rising Tide webhook through the real route, carrying the scrubbed summary only.
- **Persistent state:** new `<stateDir>/correction-ledger.db` (SQLite, distilled + scrubbed records only — raw conversation never persists). New `<stateDir>/logs/correction-learning-audit.jsonl` (one metadata line per capture decision, `origin: correction-loop`). Preference writes land in the Slice-1a `<stateDir>/preferences.json` via `recordPreference()`, tagged `provenance: correction-loop` for one-shot bulk removal.
- **Timing:** capture/distill is fully off the delivery path (VOID fire-and-forget); a thrown distill error never propagates. Layer-0 `classify()` adds a single synchronous regex pass per inbound human message.

## 7. Rollback cost

- **Code:** flip `monitoring.correctionLearning.enabled` back to false (or revert the commits). With the flag off, the capture loop is not wired and the `/corrections` + `/preferences/session-context` routes 503; records stay inert.
- **Persistent state:** the `correction-ledger.db` and audit JSONL stay on disk but are read by nothing while disabled. Preference entries written by the loop carry `provenance: correction-loop` so a single filter against `.instar/preferences.json` removes exactly the loop's contributions, leaving any human-authored ones intact.
- **Agent state repair:** none required. Removing the ledger db is safe (absent file ≡ no records).
- **User visibility during rollback:** none. The feature is dark by default; turning it off returns to the always-on Layer-0 metadata classification, which is invisible.

Total rollback time: under 1 minute (flip one config flag).

## Conclusion

Signal-only, dark-by-default, off the hot path, with the by-construction authority guard re-proven for both new capabilities and the privacy boundary (both-sided deterministic scrub + metadata-only persistence + disclosed LLM egress) enforced in code. No new blocking authority is introduced. The change mirrors the established Failure-Learning Loop architecture and reuses existing authorities (preferences endpoint, `/feedback` route guards, Attention queue, Evolution/Initiative board) rather than minting new ones.
