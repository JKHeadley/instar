---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "yes! then we need to do a full, robust audit to fix this whole class of issues since it keeps coming up")
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

This release bundles two independent fixes pending for the next version.

**1. Fleet-wide fix for the silent-403 class.** Every shipped hook, script, Node
helper, and migrator-emitted template that resolves the agent's `authToken` now
survives the secret-externalization refactor. Two related bugs landed together
because both produced the same user-visible symptom (a hook that stops emitting
any output):

- **Auth-token resolution: env-first with a string-type guard.**
  `INSTAR_AUTH_TOKEN` (set by `SessionManager` per spawned session and by
  `JobScheduler` per scheduled job) is checked first. The disk fallback now
  guards `cfg.authToken` against non-string values, so the literal
  `{ "secret": true }` placeholder produced by `SecretMigrator` after
  multi-machine pairing can never leak through as a Bearer token.
- **Port-parse tolerates whitespace.** The `grep -o '"port":[0-9]*'` pattern used
  in every hook required no whitespace between the colon and the number, but our
  prettified `config.json` writes `"port": 4042`. Replaced with a
  whitespace-tolerant pattern + digit-only extraction.

The structural cure includes a unit-tier lint that fails any future
re-introduction of the broken pattern and a migration pass
(`migrateSecretExternalizationSurvivability`) that upgrades deployed auxiliary
scripts without touching custom forks.

**2. Multi-machine session pool: works over the wire now.** Two fixes that make
running one agent across multiple machines actually work end-to-end.

- A real bug: the private channel machines use to send each other commands
  (`/mesh/rpc`) was being blocked by the normal login check before it could even
  verify the message's own signature. Because each machine has its own login
  token, one machine could never present a token the other would accept — so
  every cross-machine action (checking if a peer is alive, handing a conversation
  to another machine, moving one) was silently refused with a 401. That channel
  is already protected by a strong per-machine cryptographic signature, so it now
  correctly skips the token check and relies on the signature. This is the
  missing piece that made a second machine show as offline even when both
  machines could reach each other perfectly.
- The headline "move this to the mini" feature is now wired all the way through.
  Saying "move this to <machine nickname>" (or "run this on <nickname>") in a
  conversation now pins that conversation to the named machine and hands it over,
  so it continues there. Before, the phrase was understood but nothing acted on
  it.

## What to Tell Your User

If your agent recently went silent after compaction — emitting only the
wall-clock-time block and then nothing else, despite a healthy server — the
silent-403 fix restores topic-history injection. No configuration needed; after
auto-update, send yourself a Telegram message in any forum topic and the
response should reference what you actually said.

If you run across two machines: a second machine will now correctly show as
online and become eligible to receive conversations, and you can say "move this
to the mini" (using whatever nickname shows on your Machines list) to hand the
current conversation to that machine — it picks up there. Both machines need to
update for the cross-machine features to work.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Auth-token resolution survives secret-externalization | Automatic. Every shipped script + hook reads `INSTAR_AUTH_TOKEN` env first, then falls back to `config.json` with a string-type guard. |
| Port-parse tolerates JSON whitespace | Automatic. Hooks no longer exit-early when `config.json` is prettified. |
| Lint blocks future 403-class regressions | `tests/unit/secret-externalization-hook-resolver-lint.test.ts` fails on any reintroduction of the broken pattern. |
| Auxiliary-script migration for deployed agents | Existing agents get the fix on next auto-update via `migrateSecretExternalizationSurvivability`; custom forks untouched. |
| Cross-machine command channel works over the wire | Automatic. `/mesh/rpc` is exempt from the API token check and authed solely by its per-machine cryptographic signature, so presence, delivery, and transfer work over the network. |
| Pin a conversation to a machine (`TopicPlacementPinStore`) | Automatic store behind the relocation command. |
| "move this to <nickname>" / "run this on <nickname>" | Say it in a conversation; it pins + hands the conversation to the named machine, which resumes it. |

## Evidence

- 13 new tests across 3 tiers for the silent-403 fix (all green on a full
  `vitest` run); 35 PostUpdateMigrator-* unit files verified clean.
- `tests/unit/mesh-rpc-auth-exemption.test.ts` — the machine command route
  reaches its handler with no token (and ignores a wrong one — the signature is
  the auth); a normal protected route still requires the token.
- `tests/unit/topic-placement-pin-store.test.ts` — pin set/get/clear, durable
  across restarts, tolerant of a corrupt file.
- `tests/unit/transfer-activation-wiring.test.ts` — the recognizer/planner are
  wired on inbound before routing, a transfer sets the pin + releases ownership,
  the pin is passed into placement, and the whole path is dark-gated.
- Found on real hardware (laptop + Mac mini): the mini stayed offline because its
  `/mesh/rpc` returned 401 before the signed envelope was checked; with the
  exemption the cross-machine calls authenticate off the envelope as designed.
- Side-effects: `upgrades/side-effects/secret-externalization-hook-resolver-audit.md`,
  `upgrades/side-effects/mesh-rpc-auth-and-transfer-activation.md`.
