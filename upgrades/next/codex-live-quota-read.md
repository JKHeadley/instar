# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Codex quota readings are now LIVE. Until now the only source was the session log the codex CLI writes after each completed turn, which has a structural limit: the number is only as fresh as the last time something ran on the account, and a WALLED account — where no turn completes — produces no record at all. That is why an idle account sat on a days-old number and why an exhausted account could show nothing whatsoever.

The codex CLI's app-server protocol exposes `account/rateLimits/read` — the exact call its own `/status` screen makes: a metadata fetch answered by OpenAI's backend without running a model turn. No tokens, no quota, measured at 450–850ms per account. A new reader (`codexLiveRateLimitReader`) speaks the protocol — spawn `codex app-server` against the account's config home, one initialize handshake, one read, kill — and maps the answer into the existing snapshot shape with `source: 'codex-app-server'`.

The quota poller and `GET /codex/usage` try the live read FIRST and fall back to the rollout tail on ANY failure (binary missing, timeout, protocol drift, malformed output), so the worst case is exactly the previous behaviour. The real reader is injected only at server composition (`buildCodexLiveUsageReader`); components built without it — including every test — stay rollout-only, so no test can spawn a real subprocess. Rollback lever: `subscriptionPool.codexLiveQuota: false` forces rollout-only per agent, no release needed.

No routing, placement, load-shedding or swap threshold changed. Those authorities read the same fields — now fresher and more often present, which steers work away from exhausted accounts earlier. The solo-codex load-shed brake (QuotaCollector) deliberately keeps its rollout-only read and both-windows requirement (tracked separately as ACT-018 — loosening a fail-safe deserves its own review).

## What to Tell Your User

Your Codex usage bars are now live. Before, the number could only update when something actually ran on an account, so an idle account showed a days-old reading and an account that had hit its weekly wall showed nothing at all. Now every poll asks Codex directly — the same question its own status screen asks — and that costs nothing: no tokens, no quota. Walled accounts show their true 100% with the real reset time instead of a blank card.

If anything ever goes wrong with the live check, the dashboard quietly falls back to the old log-reading method, so the worst case is a stale number clearly labelled with its age — never a missing or wrong one.

## Summary of New Capabilities

- Live, zero-spend Codex quota via `codex app-server`'s `account/rateLimits/read` — the poller and `GET /codex/usage` are live-first with rollout-tail fallback.
- Walled accounts (which write no rollout records) now report their true utilization and reset time.
- Provenance on every reading: `source: 'codex-app-server'` (live) vs `'codex-rollout'` (fallback), through the pool, the route, and WS5.2 replication.
- Rollback lever: `subscriptionPool.codexLiveQuota: false` (per agent, config-only).
- Hermetic composition: the real subprocess-spawning reader exists only at the server composition root; tests structurally cannot spawn it.
- Agent awareness: template updated for new installs; existing agents receive an append-only CLAUDE.md note via PostUpdateMigrator (content-sniffed, idempotent).

## Evidence

- Live, through the built dist against all five real Codex config homes (2026-09-20): justin@sagemindai.io 100% walled · dawn@sagemindai.io 100% walled (previously structurally unreadable) · headley.justin@gmail.com 100% walled · amrch 86% · adriana 96% — 450–850ms each, all `source=codex-app-server`, zero quota consumed (verified: the walled accounts answered while at 100%).
- Protocol ground truth captured from `codex app-server generate-json-schema` (codex-cli 0.153.4).
- Unit `tests/unit/codexLiveRateLimitReader.test.ts` (13 passing): response mapping, the walled-account marker, foreign-limit-family refusal, windowless and malformed windows, handshake order, and every failure shape → null (initialize refused, read error, silent child hitting the deadline, early child exit, spawn throw), plus the composition factory's both sides.
- Unit `tests/unit/quota-poller.test.ts` (29 passing): live wins with provenance recorded and zero rollout reads; fallback on null AND on throw; `null` reader disables the live path (the rollback lever's semantics).
- Integration + E2E (8 passing): live-first proven through the production AgentServer wiring with an injected fake reader — including wiring integrity (the reader receives the query's codexHome) — plus fallback, auth, and read-only checks.
