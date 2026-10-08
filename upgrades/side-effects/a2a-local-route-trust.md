# Side-Effects Review — A2A local-route trust

**Version / slug:** `a2a-local-route-trust`
**Date:** `2026-10-08`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-local-route-trust.md (one review round; approved under the operator's standing approval for the agent-comms track, 2026-10-06 18:57, topic 122413). Tracking action ACT-056.

## Summary of the change

`POST /messages/relay-agent` (the same-machine A2A route, `src/server/routes.ts`) handled every sender as `verified`, because it passed no trust level and `ThreadlineRouter` defaults to `verified`. The relay gate (`InboundMessageGate` step 4) refuses a sender with no trust profile. The route now resolves the sender's trust from the same `AgentTrustManager` (`ctx.unifiedTrust.trustManager`) and applies the same operation-permission check. The decision lives in a new pure module, `src/threadline/localRouteTrust.ts` (reads only, writes nothing).

The check runs after the bearer-token, envelope and relay-chain-loop checks and BEFORE the content window and the inbound-id ledger. Three modes, read live per request from `threadline.localRouteTrust`:

- off (`enabled` omitted on a non-development agent, or `false`): today's behaviour, nothing counted;
- dry-run (the default when on): every message delivered as today; a would-refuse verdict writes one `[relay-agent-trust] would-refuse` line and counts;
- enforcing (`dryRun: false`): a sender whose level may not perform the operation gets HTTP 403 `{ error: 'insufficient-trust', refused: true, retryable: false, operation }` (no trust level in the body); an allowed sender is delivered and the router is given the resolved level, capped at `verified`, through a new `opts.localTrustLevel` (used only in the live-inject grounding text) and the warrants-a-reply gate input.

No trust manager wired: handled as today and counted (`noTrustManager`). A throwing lookup: counted; delivered in dry-run, HTTP 503 `trust-unavailable` when enforcing. Registered in `DEV_GATED_FEATURES` (`a2aLocalRouteTrust`); counters on the authed `/health` under `threadline.localRouteTrust`; `ThreadlineConfig.localRouteTrust` type; CLAUDE.md template + `migrateClaudeMd` section "A2A local-route trust" (framework-shadowed). No ConfigDefaults entry.

## Decision-point inventory

- Admit or refuse a local-route message by sender trust — **add** — invariant: the trust manager's level-to-operation table; enforced only with `dryRun: false`.
- Which identity the lookup keys on — **add** — invariant: registry fingerprint, then body-asserted fingerprint, then a fingerprint-less profile stored under the name. A profile that belongs to a fingerprint is never reached by its display name.
- The trust level stated to the receiving session on a local delivery — **modify** — `verified` today; when enforcing, the resolved level, never above `verified`.
- `InboundMessageGate` (relay gate) — **pass-through** — not changed; its `getAllowedOperationsByFingerprint` call is reused.

---

## 1. Over-block

Only when enforcing (`dryRun: false`, a deliberate operator setting). Then:

- A legitimate same-machine agent that has no trust profile on the receiver is refused on the local route. Measured on the development machine: most same-machine pairs have no profile. A sender using `relay-send` with a connected relay falls through to the relay and is still delivered (first contact is accepted by the relay's `unknown-sender` branch); a sender with no relay connection, or one using the plain `MessageRouter` cross-agent path, is not delivered. This is why the default is dry-run.
- A legitimate agent whose registry entry on the receiver is stale (it regenerated its identity) is refused locally even though its real fingerprint is trusted. The relay leg, which carries the proven fingerprint, accepts it (e2e test).
- A `verified` sender whose object body carries `type: 'task-request'` (or any operation above its level) is refused. The relay gate refuses the same message.
- When enforcing and the trust lookup throws, the message is refused with a retryable 503.
- An object body whose `type` is present but not a non-empty string is refused at every level when enforcing (the relay gate refuses it too).
- A sender whose trust was granted to a fingerprint, but whose envelope carries no fingerprint and whose name the registry cannot resolve, is refused when enforcing: the profile is not reachable by display name. `relay-send` always puts the sender's fingerprint in the envelope, so this affects only other callers.

In dry-run and off, nothing is refused.

## 2. Under-block

- A caller that can read this agent's token file and names a peer the agent trusts avoids the refusal: the route cannot authenticate the sender. Before this change every caller avoided it.
- With no trust manager wired (relay off, relay standby, or unified-trust init failed) nothing is checked. Counted, and visible as `trustManagerWired: false`.
- The relay gate's rate limits, payload-size limit and credential-ingestion branch are not applied on the local route.
- A refused message may still arrive over the relay, where a first-contact sender skips the relay gate (existing behaviour, recorded on ACT-067).
- Dry-run refuses nothing; a dev agent left in dry-run forever is unprotected. The spec's dark-window (7 days) bounds that.

## 3. Level-of-abstraction fit

Right layer. The authority for "may this peer perform this operation" is `AgentTrustManager`; this change calls it and re-implements none of its table. The route is the only place the local path can be gated before admission (the router runs after the response is sent). The pure module mirrors `backupRoutes.ts`, so tests exercise the same code the route runs.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is not brittle pattern-matching: it is a deterministic lookup in the trust manager's enumerable level-to-operation table, the same hard-invariant check the relay gate already holds.
- [ ] ⚠️ Yes, with brittle logic.

The check judges no message content. Its inputs are a profile's level and an operation name; the table is enumerable and owned by the trust manager. This is the "hard invariant" class the principle allows a deterministic check to block on. In its default (dry-run) form it blocks nothing and only produces a signal (log line + counter) for the operator.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Admission by trust level is an enumerable invariant (four levels, a fixed operation table). The one judgment — when to leave dry-run — is declared a judgment-candidate in the spec's `## Decision points touched` and belongs to the operator.

## 5. Interactions

- **Shadowing:** the check runs before the content-hash window and the inbound-id ledger. A refused message therefore writes no ledger row and reserves no window (integration tests assert both). It runs after the 401, 400 and loop-409 answers, which are unchanged.
- **Double-fire:** none. The check sends nothing. One log line per would-refuse/refuse verdict.
- **Races:** the counters are plain in-process integers; the check holds no shared state and writes none to the trust manager.
- **Feedback loops:** a sender refused locally falls through to the relay (`relay-send`). With `a2a-backup-routes` on, that fall-through is marked `resend: true` because a 403 is not in that spec's proven non-admission set. The mark only changes the wording of a receiver notice; no retry loop exists (one fall-through per send).
- **Warrants-a-reply gate:** its `trustLevel` input is `verified` as before unless enforcing, where it is the capped resolved level.
- **Inbound-id ledger keying:** the registry fingerprint is now resolved once and shared; the ledger key is unchanged (`relayRegistryFp` is still null when the ledger is dark, and the asserted fingerprint keeps the body's case for the key).
- **Extra work per request:** with the feature on and the ledger dark, one extra synchronous read of `known-agents.json` (size-capped by `resolvePeerFingerprintByName`). With the ledger on, the read already happened; with the feature off, nothing is added but one mode read.

## 6. External surfaces

- **Other agents on the same machine:** when enforcing, a new 403/503 answer from this route. `relay-send` already treats any non-OK local answer as "fall back to the relay". `MessageRouter.relay` reads only `response.ok` and reports failure.
- **Install base:** none by default (dark on the fleet).
- **External systems:** none.
- **Persistent state:** none written.
- **Authed `/health`:** a new `threadline.localRouteTrust` block. The unauthenticated `/health` does not carry it (tested).
- **Operator surface:** no operator-facing action is added. Leaving dry-run is a config value the agent sets conversationally; granting trust uses the existing `threadline_trust` tool.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The route is loopback only: its caller is a process on the same machine holding that machine's token file. The check reads the trust manager of the machine it runs on, the same object that machine's relay gate reads, and adds no store of its own, so whatever trust state replicates into the trust manager (verified-pairing results do today) reaches the check automatically. A relay standby builds no trust manager; there the check is a counted no-op, visible as `trustManagerWired: false`. Counters are per machine and not merged: the profiles a machine would refuse on are its own.

User-facing notices: none. Durable state: none. Generated URLs: none.

## 8. Rollback cost

- **Live:** `threadline.localRouteTrust.enabled: false` (read per request, no restart) restores today's behaviour; `dryRun: true` stops refusing and keeps counting.
- **Hot-fix:** pure code change; revert and ship a patch.
- **Data migration:** none; nothing is stored.
- **Agent state repair:** none. The CLAUDE.md section is informational.
- **User visibility:** none in the default mode.

## Conclusion

The review changed the design in four ways: the level stated to the session is capped at `verified` (a claimed identity must not raise it); `wouldRefuse` is described as attempts, not as working traffic; the parity claim is narrowed to "same profile and operation, same answer"; and the spec states that a relay leg may accept a message the local route refused. Testing also surfaced that a first-contact relay sender skips the relay gate; that is left unchanged and recorded on ACT-067. The change is clear to ship dev-gated in dry-run. It must not be enforced on the fleet until same-machine agents have a way to hold profiles for each other.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only; given the code and this artifact, not the conclusions)
**Independent read of the artifact: concur**

Concur — no blocking findings. Verified against the code: with the feature off the route is identical (the ledger key is unchanged; one mode read is the only new work); dry-run has no refusal path and leaves the downstream trust level at `verified`; both the 403 and the 503 return before the content-window reservation and the ledger admit, so the `finally` block has nothing to release and nothing reaches the inbox; the registry fingerprint wins over the asserted one; the stated level never exceeds `verified`; nothing writes to the trust manager; the log line sanitises peer text; a deterministic level-to-operation lookup holding block authority is acceptable under signal-vs-authority.

Non-blocking findings, all resolved in this change:

1. A name lookup could reach a fingerprint-keyed profile by its display name when the caller left the fingerprint out — resolved: the name step now accepts only a fingerprint-less profile whose own name is the sender name (unit + integration tests).
2. `getProfile` scans display names while `checkPermission` reads the direct key — resolved by the same rule; `allowed` is computed from the profile found.
3. An object body with a non-string or empty `type` classified as `message`, where the relay gate refuses it — resolved: it maps to an operation name no level allows.
4. A sender named `constructor` or `__proto__` hit an inherited property and threw — resolved: the name step checks the profile's shape, and the no-profile answer no longer keys on peer-supplied name text (tests).
5. An upper-case asserted fingerprint resolved to untrusted — resolved: lower-cased for the lookup only.
6. The 403 body disclosed the claimed identity's trust level — resolved: the field is removed.

The reviewer also asked for two facts to be recorded, now in sections 1 and 5: the extra registry read per request, and the refusal of an unusable `type`. The reviewer did not check the claim that a 403 fall-through is marked `resend: true`; it was then checked against `classifyFallthrough` in `src/threadline/backupRoutes.ts` (403 is not in the non-admission set, so it is marked).

---

## Evidence pointers

- `tests/unit/a2a-local-route-trust.test.ts` — decision logic against a real `AgentTrustManager`, mode resolver, log line, migration parity.
- `tests/unit/threadline/ThreadlineRouter.test.ts` — `localTrustLevel` in the live-inject grounding.
- `tests/integration/threadline/a2a-local-route-trust.test.ts` — the real route in every mode.
- `tests/e2e/threadline/a2a-local-route-trust-alive.test.ts` — production boot path, real relay.
- Risk check, development machine, 2026-10-08: of three agents with threadline state, one lists three same-machine agents and holds one trust profile, one holds one profile, one has no trust-profiles file.

---

## Class-Closure Declaration (display-only mirror)

No self-triggered controller and no agent-authored-artifact defect — not applicable. (The defect is in route code; the check runs only inside an inbound request and fires no restart, spawn, notify or retry.)
