# Side-Effects Review — Cold-Start Lifeline Fallback (G1)

**Version / slug:** `coldstart-lifeline-fallback`
**Date:** `2026-06-26`
**Author:** `echo`
**Tier:** 1 (enhances an EXISTING always-on user-notice on the inbound cold-start
failure path; reuses the already-merged "Agent Is Always Reachable" standard #1288;
no new authority, no new gate, no protocol/security change)

## Summary of the change

G1 (the user-facing arm) of the constitutional standard **"The Agent Is Always
Reachable"** corollary (2), *no silent resource rejection*. When a user messages a
topic and the system genuinely cannot start (cold spawn) OR restart a session for it,
the existing catch already sent a generic notice — but it (a) did not point to the
Lifeline, (b) did not hand a copy-paste debug message, and (c) leaked dev jargon
("increase maxSessions in your config"). This change extracts a pure, unit-tested
message builder (`src/messaging/ColdStartFallbackReply.ts`) that classifies WHY the
start failed (`session-limit` / `resource-pressure` / `start-failure`) and composes a
plain-English reply with the Lifeline pointer + a pre-written copy-paste debug block,
and wires it into BOTH inbound failure paths in `src/commands/server.ts`. Migration
parity: a `migrateClaudeMd` section (existing agents) + a `generateClaudeMd` template
section (new agents) so any agent can explain the behavior. Files:
`src/messaging/ColdStartFallbackReply.ts` (new), `src/commands/server.ts` (two catch
sites), `src/core/PostUpdateMigrator.ts` (CLAUDE.md section), `src/scaffold/templates.ts`
(template section), plus three test files (logic, wiring-integrity, migration).

## Decision-point inventory

- The two inbound failure catches (`onTopicMessage` cold-spawn `.catch` and restart
  `.catch`) — **pass-through**. They already FIRED a notice; this only changes the
  *content* of the message (and replaces the string-match branch with the classifier).
  No control-flow change: still one `telegram.sendToTopic(topicId, …)` on failure.

## 1. Over-block

**No block/allow surface — not applicable.** The change produces a user-facing message
on an already-failing path; it never blocks, delays, or rejects any session, message,
or spawn. The spawn/restart decision is entirely unchanged (the failure already
happened by the time the builder runs).

## 2. Under-block

**Not applicable** — no gate. The closest "miss" is a misclassified reason word, which
only changes the wording (the notice still fires and still points to the Lifeline). The
classifier is a SIGNAL (help text), not authority — both sides of each classification
branch are unit-tested.

## 3. Level-of-abstraction fit

Correct layer. The failure reason (the thrown error) and the delivery primitive
(`telegram.sendToTopic`, `telegram.getLifelineTopicId`) are both already in scope at the
catch site; composing the message there — via a pure builder that has no I/O — is the
right level. The builder is isolated in `src/messaging/` so it is unit-testable without
standing up the server.

## 4. Signal vs authority compliance

The reply is **pure signal** — a help message on a deterministic delivery path. It
carries zero blocking authority: it cannot hold, delay, or release a session. The
session's fate is decided entirely by the unchanged `SessionManager.spawnSession`
throw. This is the signal-vs-authority split the principle demands.

## 5. Interactions

- **Deterministic path (deliberate):** delivery is the direct `sendToTopic`, NOT the
  LLM tone gate — per the standard, the notice must not be blockable by the very
  pressure it reports (a tone gate failing closed under load would swallow it).
- **Double-fire:** unchanged. The existing `spawningTopics` guard + the single `.catch`
  still fire at most one notice per failed attempt.
- **Same-topic-is-lifeline:** handled — when the failing topic IS the Lifeline, the
  message does not tell the user to go elsewhere (tested).
- **No-lifeline-configured:** degrades to "why + honest retry guidance" (tested).

## 6. External surfaces

- **User:** the agent's own Telegram topic — same `sendToTopic` primitive, same
  topic, same priority as the message it replaces. No new external call shape.
- **No new config, route, hook, or credential.** Always-on (the standard forbids
  dark-shipping reachability); the only "surface" change is better message text.

## 7. Rollback

Pure code + docs. Reverting the commit restores the prior generic notice. No state
migration to undo (the CLAUDE.md section is idempotent and additive).
