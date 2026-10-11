# Side-Effects Review — A2A local-route signed envelope

**Version / slug:** `a2a-local-route-signed-envelope`
**Date:** `2026-10-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-local-route-signed-envelope.md (six review rounds; the convergence report records that the review stopped under the builder brief's stop rule, not the two-quiet-rounds rule). Tracking action ACT-067, commitment CMT-706.

## Summary of the change

`POST /messages/relay-agent` (the same-machine A2A route) took the sender's name from the request body. Senders now sign, and the receiver can check.

- **Senders (not gated).** New module `src/threadline/localEnvelopeSignature.ts`. The relay-send name path (`routes.ts`) and `MessageRouter.routeCrossAgentLocal` add a top-level `signature` (base64 Ed25519 over `"instar-a2a-local-envelope-v1\n" + canonicalJSON({ message, transport: { nonce, timestamp, relayChain, originServer, originTopicId } })`) made with the agent's Threadline identity key. `MessageRouter` signs once, before the POST-or-drop branch, and only when `from.agent` is this agent.
- **Receiver, by mode** (`threadline.localRouteSignature.{enabled,dryRun}`, dev-gated, read live):
  - `off`: the field is not read.
  - `dry-run` (default when on): each envelope is verified, counted, logged (`would-refuse`) and written to an audit file; delivery is unchanged.
  - `enforcing` (`dryRun: false`): a failing envelope is refused pre-admission with `401 { error: 'bad-signature', refused: true, retryable, remedy, reason }`; a passing one hands its key-derived fingerprint to the trust check and the ledger key.
- **Key source.** The registry (`known-agents.json`) entry for the sender name; if none, a first-contact probe of the name's registered port (`/threadline/health`) into an in-memory cache. Never a registry write; never a replacement of a held key.
- **Recipient, freshness, replay.** `to.agent` must be this agent; timestamp within −10 / +2 minutes; an in-memory nonce cache (512 per sender inside 4,096).
- **Requirement header.** A request with `X-Instar-Require-Signature: v1` is refused `not-enforcing` unless the receiver is enforcing — in every mode, `off` included.
- **`MessageRouter`.** `relayToAgent` returns `accepted` / `refused` / `unreachable`. A JSON body with `refused: true` (any status) fails the send and is not dropped. Everything else drops as before.
- **Drop pickup.** Takes the mode. Enforcing: an unproven drop is held in place; the boot pass never probes or expires; if anything is held, one second pass runs five minutes later (probe allowed) and deletes unproven drops older than 7 days, with one degradation report.
- **Surfaces.** Authed `/health` → `threadline.localRouteSignature`; unauthenticated `/threadline/health` → `localEnvelopeSignature: { version, mode }`; the route's success answers carry `signature: { mode, verified }` when the mode is not `off`; audit file `logs/relay-agent-signature.jsonl`; `DEV_GATED_FEATURES` entry; CLAUDE.md template + `migrateClaudeMd` section (framework-shadowed); `ThreadlineConfig.localRouteSignature` type.
- `AgentTokenManager.canonicalJSON` is exported (no behaviour change).

## Decision-point inventory

- Admit or refuse a local-route envelope by signature — **add** — invariant (a signature verifies or it does not); enforced only with `dryRun: false`.
- Refuse a request that requires the proof when not enforcing — **add** — invariant; only reached when a sender sets the header.
- Fingerprint handed to the local-route trust check and the ledger `registry:` key — **modify** — name-resolved today; key-derived when enforcing and proven.
- `MessageRouter`: drop or fail after a non-OK answer — **modify** — any failure dropped; now an explicit `refused: true` fails.
- Drop pickup: ingest or hold — **add** — only when enforcing.
- Local-route trust check, inbound-id ledger logic, content window — **pass-through** — not changed.

---

## 1. Over-block

Off and dry-run refuse nothing, with one exception: a request that carries `X-Instar-Require-Signature: v1` is refused in both. No Instar sender sets that header; it is an opt-in by the sender.

When enforcing (a deliberate setting):

- A same-machine sender on an older release (unsigned) is refused; its relay-send messages take the relay, its `/messages/send` messages fail.
- A sender whose identity is missing or locked sends unsigned and is refused.
- A peer that rotated its identity is `signature-invalid` until `threadline_discover` records the new key.
- A sender this agent has no key for and cannot probe (not registered as running, health not answering, no handshake manager on the peer) is `unknown-sender`. After five failed probes in a row the name is probed once an hour. The probe runs before any signature can be checked, so a token holder sending signed-looking envelopes under a name whose server is down can spend those five tries; the hourly retry is what keeps that from lasting.
- A cloned agent home (one key under two names) is `ambiguous-sender` for both names; so is a name with two different keys in the registry.
- An envelope whose signed part is over 1 MB or nested deeper than 64 levels is sent unsigned (the route accepts 12 MB bodies), so an enforcing receiver refuses it as `unsigned`.
- Clock skew cannot occur (one machine), but a message queued more than 10 minutes before delivery is `stale`. No Instar sender queues a signed envelope before POSTing.
- A parked message that cannot be proven is held and, after 7 days, deleted. Today it would have been ingested.
- A sender at 512 live nonces (about 0.7 messages a second for twelve minutes) is `replay-cache-full` until entries age out.

On every agent, in every mode: a `MessageRouter` send answered with `refused: true` now fails where it used to be parked and delivered at the receiver's next boot. Only a receiver with an enforcing check sends that flag (local-route trust enforcing, or this check enforcing), so on the fleet today nothing changes.

## 2. Under-block

- The fleet is `off`: nothing is checked there. Development agents are watch-only: nothing is refused.
- A process running as the same user can read every agent's identity file and sign as any of them.
- The key is trust-on-first-use from an unauthenticated loopback endpoint; a routine `threadline_discover` replaces every recorded key (ACT-072).
- The replay cache is per process: an envelope captured in the ten minutes before a restart can be admitted once in the ten minutes after.
- A paired agent's envelope is valid on each of the recipient's machines for ten minutes, to a caller that also holds that machine's token.
- Thread attribution, the warrants-reply gate and the ack recorder still read the body name (ACT-072).
- Drop pickup has no local-route trust check (ACT-064, existing).
- A receiver replaced by an older release between a consumer's health read and its POST ignores the requirement header.
- Drop pickup skips the freshness bound and the replay cache. A captured signed envelope can be parked again by anyone able to produce a valid drop HMAC, and is ingested once the receiver's store no longer holds that message id. Senders also keep the `signature` in their own stored copy of the message.
- Dry-run drop pickup runs no second pass, so its `unknown-sender` count for drops over-states what enforcing would hold.

## 3. Level-of-abstraction fit

The check sits in the route, at the same pre-admission point as the sibling local-route trust check, and feeds that check its input. The cryptography reuses `ThreadlineCrypto.sign/verify` and the existing canonicaliser. The key source is the receiver's own registry, which same-machine discovery already maintains; the first-contact probe reads the same endpoint discovery reads. The drop directory is the one other way a local envelope reaches the store, so the same verdict function runs there.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is not brittle pattern-matching: an Ed25519 signature check against a key the receiver holds, plus exact comparisons (recipient name, timestamp window, nonce seen). No content is judged.
- [ ] ⚠️ Yes, with brittle logic.

In its default form on a development agent it blocks nothing and produces counters, a log line and audit rows.

## 4b. Judgment-point check

No heuristic at a competing-signals point. The one judgment — when to leave dry-run — is Echo's, on the criteria in the spec's Maturation plan (ACT-074).

## 5. Interactions

- **Local-route trust (sibling):** runs after this check. Enforcing + proven: it is given the key-derived fingerprint as `registryFingerprint`. Dry-run: its inputs are unchanged.
- **Inbound-id ledger:** same; the `registry:` namespace is unchanged, only the value when enforcing. A refused envelope reaches neither the content window nor the ledger.
- **Relay-chain loop check:** now runs after this check; a loop envelope with a bad signature is refused for the signature (when enforcing).
- **Backup routes:** a 401 is already non-admission (fall-through unmarked). The enforcing 503 is not in that set, so its fall-through copy is marked as a resend; the backup-routes spec calls over-marking safe.
- **`res.json` wrap:** when the mode is not `off`, success answers of the route gain a `signature` key. Existing callers read named fields; `relay-send` reads `ok/accepted/delivered/deduped/threadline`.
- **Drop pickup:** the existing structure, duplicate and HMAC checks run first and still delete. A verifier error is caught inside the check and never reaches pickup's deleting catch.
- **Presence heartbeat / discovery:** not touched; the check writes nothing they read.
- **Double-fire / races:** the first-contact probe is single-flight per name. The second pickup pass is one `unref`'d timer, cleared at shutdown.

## 6. External surfaces

- **Other agents:** every Instar agent on this release sends a `signature` field on local envelopes. An older receiver ignores unknown top-level fields (`express.json`, no schema validation on the route).
- **Dawn / the-portal:** the wire format, the config keys, the requirement header and the health advertisement are the contract; the spec carries a fixed test vector.
- **Unauthenticated `/threadline/health`:** gains `localEnvelopeSignature: { version, mode }`. The mode is not a secret; on a mesh-bound agent it is visible to LAN and tailnet peers.
- **Authed `/health`:** new `threadline.localRouteSignature` block.
- **Disk:** `{stateDir}/logs/relay-agent-signature.jsonl` (metadata only, 0600, 2 MB bound). Written only when the mode is not `off`.
- **Network:** when the mode is not `off`, at most one loopback GET of a peer's `/threadline/health` per signed envelope from a name with no key on record (2.5 s cap; five tries per peer per process).

## 6b. Operator-surface quality

No new operator surface. The switch is a config key the agent sets conversationally; the evidence is a log file the agent reads.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** (`hardware-bound-resource`): the route is a same-machine hand-off; the registry entry, the first-contact cache, the replay cache, the probe table, the counters, the audit file and held drops describe processes and files on one host. The signing identity is already unified across a paired agent's machines (nothing here copies it). The config block is per machine; each machine advertises its own mode. The one degradation report (held/expired drops, a closed probe ladder, no identity) is per machine and says nothing about another machine; no user-facing notice, URL or durable state that could strand on a topic transfer.

## 8. Rollback cost

- Live: `threadline.localRouteSignature.dryRun: true` (or removing the key) stops refusing at the next request; `enabled: false` stops checking.
- Held drops are ingested at the next boot once the mode is not enforcing.
- Code revert: senders stop signing. An enforcing receiver on a newer release would then refuse them, so set receivers back to dry-run first. No data migration; the audit file can be deleted.
- The `MessageRouter` refusal classification reverts with the code; no stored state depends on it.

## Conclusion

Clear to ship dev-gated in dry-run. The check refuses nothing until someone sets `dryRun: false`; the three ungated changes are additive or only reachable against an enforcing receiver: senders sign; an explicit `refused: true` is terminal for `MessageRouter`; and an agent with no usable Threadline identity files ONE degradation report the first time it sends a same-machine message (it cannot sign). The flip on Echo is tracked as ACT-074 and reads the audit file, not the counters.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only; given the code, the spec and this artifact)
**Independent read of the artifact: concern raised, then resolved**

First read: "Concern raised". It confirmed the mode logic (off changes nothing but the requirement header; dry-run refuses nothing and changes no downstream input; the proven fingerprint is used only when enforcing), the replay-cache accounting, the single-flight probe, the `res.json` wrap, the hold/expire logic and the timer. It found three defects and four artifact gaps, all fixed before commit:

1. The receiver's `error` / `reason` text reached the sender's log and stored delivery record truncated but not stripped. Now reduced to printable ASCII, 48 characters.
2. The probe runs before the signature can be checked, so forged envelopes under a name whose server is down could close that name for the life of the process. A closed name is now probed once an hour; the false code comment is corrected; the spec's brakes paragraph says so.
3. The signer held one `IdentityManager`, which caches the first identity it loads, while `/threadline/health` reads a fresh one per request. The signer now reads a fresh one per sign.
4. The requirement header matched only the exact string `v1`; a duplicated header (`v1, v1`) or a later version was delivered unproven. Any non-empty value is now a requirement, and one this receiver cannot meet is refused.
5. Artifact: the third ungated change (the no-identity report), two missing over-block rows and the drop-replay under-block are now stated above.

Not changed: the envelope is canonicalised twice per verification (cost only), and `dropsHeld` counts a file on both passes of one boot (the audit rows carry the truth).

---

## Evidence pointers

- `tests/unit/a2a-local-route-signed-envelope.test.ts` — 52 tests.
- `tests/integration/threadline/a2a-local-route-signed-envelope.test.ts` — 19 tests, real route, each mode.
- `tests/e2e/threadline/a2a-local-route-signed-envelope-alive.test.ts` — 6 tests, two real servers.

---

## Class-Closure Declaration (display-only mirror)

The first-contact probe is the one self-triggered action: bounded by a per-name doubling backoff (60 s to 16 min), five failed probes per name per process, 64 names, single-flight, a 2.5 s timeout, and one report when a name closes. The second pickup pass runs once per boot. Nothing else retries, respawns or notifies.
