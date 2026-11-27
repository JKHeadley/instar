# Side-Effects Review — Threadline direct peer protocol: closed by default, and a handshake is not a grant

## Summary of the change

A security fix from Instar's standing security program (operator, topic 141385, 2026-11-15). The class of problem: the direct HTTP peer protocol on an agent's public URL trusted a trust-on-first-use handshake as if it were a grant. The fix:

- **§0** closes the five direct peer routes (handshake hello/confirm, messages/receive, threads/backfill, blobs) by default. They answer 404 and point the caller at the relay. No Instar code uses them. One switch opens them: `threadline.directPeerProtocol.enabled: true`, read live.
- **§1–§3**, when an owner opens the protocol:
  - A key must already hold a decided trust grant to start a handshake, so a stranger creates no state at all.
  - A paired name keeps its key, and unusable names are refused.
  - A message reaches the router only when the sender's fingerprint holds a decided trust level (`setup-default` profiles are not grants). An ack needs the same level.
  - The sender is recorded by its verified fingerprint.
  - An unreadable pairing store fails closed.
  - The owner can remove a pairing (`DELETE /threadline/pairings/:agent`, bearer).
  - Counters appear on the authed health detail.

Tier 2 (security, published peer protocol). Files: 4 source files (`src/threadline/httpPeerTrust.ts` new, `HandshakeManager.ts`, `ThreadlineEndpoints.ts`, `src/server/routes.ts`), 1 awareness entry, docs (`THREADLINE.md`, spec + ELI16), 2 new test files, 3 edited test files.

Effort: 5 review rounds (cap 6). Round 1 found 2 critical holes in the first fix, and rounds 2 to 4 found more in the opened mode, each fixed. Round 5 is recorded in the convergence report. The design changed three times: grandfathering was dropped after the constitution gate flagged it; the route was then closed by default after the clean-door review; and the grant check moved to the handshake, also after the clean-door review. In proportion for a critical security fix; the rounds were not polishing.

**Rollout:** live for every agent in the next release, with off switches. Operator decision: "Yes, live" [source: telegram 141385, 2026-11-15 14:16 PST], replying to the Chief of Staff's 14:11 ask ("Reply yes, ship it live to send it to every agent at once, or no, go Echo first").

## User-visible effect (Security Fixes Keep the Experience Whole)

**None for the owner.** There is no notice, no new step, and no change to the dashboard or any channel. Peers on the relay or paired by invite are unaffected, because they use a different path. Anything calling the direct routes gets a 404 telling it to use the relay; no Instar code does, and Echo has never had a direct pairing. With the protocol opened, an ungranted sender is refused. That loss falls only on such senders, and it is the critical vulnerability itself. This is a degradation for nobody who uses Instar today.

## Decision-point inventory

1. Direct protocol open or closed (invariant, owner switch, absent or unreadable means closed).
2. Key pin per name (invariant).
3. Unusable names (invariant).
4. HTTP receive admission (judgment-candidate). The floor is admit or refuse-403. The default is refuse. The arbiter is the trust manager through `resolveRelayUnknownSenderTrust`.
5. `from.agent` replaced by the verified fingerprint (invariant).

Full table: spec §"Decision points touched".

## 1. Over-block

- A legitimate outside client of the direct protocol, if one exists, gets a 404. The owner's switch reopens it. Echo has none, and no Instar code is a client.
- With the protocol opened:
  - A peer whose level was set by the operator but whose profile still reads `setup-default` would be refused (safe direction).
  - A reinstalled peer under a pinned name must have the owner remove the pairing.
- On a standby machine, or with the relay off, there is no trust manager, so every sender is refused once opened (spec §Wiring).

## 2. Under-block

These are outside this change and named in the spec under "Remaining exposure":

- The relay path's own unknown-sender check is still observing on the fleet (SEC-019).
- The trust-grant tool and the live config switches accept any local caller as the owner (SEC-018).
- With the protocol opened, a hello carrying a pinned public key can still delay a re-pairing.

## 3. Level-of-abstraction fit

The closing guard sits at the route layer, where the routes are defined. Admission reuses the trust manager and the relay resolver rather than adding a second authority. An earlier baseline design was dropped because it was a second authority.

## 4. Signal vs authority compliance

The guard and admission hold blocking authority with deterministic logic:

- **Closing guard:** exact route list.
- **Admission:** a lookup in the trust manager, the existing authority.

There is no brittle content heuristic. `classifyHttpPeerOperation` reuses the ack stage's own recognisers, so the operation label and the ack decision cannot disagree. Compliant per `docs/signal-vs-authority.md`: the authority is the trust manager's decided level, not a guess.

## 4b. Judgment-point check

Admission is a judgment-candidate with a complete floor (two actions, refuse by default, fails closed on a throwing source) and the trust manager as arbiter.

## 5. Interactions

- The inbound-id ledger, ack stage, homebase relay and router all run after admission, and a refusal reaches none of them.
- The `from.agent` change makes HTTP threads owned by fingerprint, like relay threads.
- Existing tests that exercised the open protocol now open it explicitly and give their sender a grant.
- The `ack-never-acked` fixture now records the peer by its real fingerprint, matching what the path passes.

## 6. External surfaces

This changes the published peer protocol: the five routes now return 404 by default.

- `/threadline/health` is unchanged.
- There is a new bearer route, `DELETE /threadline/pairings/:agent`, not on the public allowlist.
- New authed health fields: `threadline.httpPeerTrust`.
- Refusal logging is throttled to one line per reason per minute.

## 6b. Operator-surface quality

No operator surface changes.

## 7. Multi-machine posture

No new replicated state. Both stores read are already machine-local:

- **Trust profiles:** registered machine-local; they exist only on the relay holder.
- **`relay-tokens.json`:** per-machine relay tokens derived from that machine's own handshake keys (`machine-local-justification: physical-credential-locality`).

Both switches are ordinary config on each machine. The refusal counters are per process.

## 8. Rollback cost

Live, no restart: set `threadline.directPeerProtocol.enabled: true` and `threadline.httpPeerTrust.enabled: false`. Or revert the PR. No data migration.

## Conclusion

Closes the class at its root, the open route, and keeps defence in depth behind the owner's switch. No user-visible degradation.

## Second-pass review (if required)

Required (gate on inbound messaging, trust levels). Three independent review rounds ran. Each had internal reviewers across the six lenses, GPT-6 Astra through the Codex CLI, and a Claude clean-door reviewer. Gemini was unreachable through the review script (not signed in), recorded in the convergence report. The round-3 verdict is recorded below once it is in.

## Evidence pointers

- **Reproduction before the fix**, on a throwaway agent on 127.0.0.1 with no tunnel: a fresh key paired and sent one message, and a session started. Kept private until installed.
- **The same proof on the fixed build:** both a plain and an ack-labelled message were refused with no session, and counters showed on authed health only.
- **Unit tests:** `tests/unit/threadline/threadline-http-peer-trust.test.ts`, plus edited endpoint tests. The 5 related unit files passed (133 tests).
- **Integration:** `tests/integration/threadline/http-peer-trust-wiring.test.ts` (through the real AgentServer), plus edited `inbound-id-ledger` and `ack-never-acked`. These run in Local Verify.
