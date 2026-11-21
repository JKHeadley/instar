# Side-Effects Review — the Gemini API door, its routes, and one spender across machines (gemini payg slices C + D)

**Version / slug:** `gemini-payg-door-and-mesh`
**Date:** `2026-11-20`
**Author:** `Echo (build lane echo-gemini-payg-build)`
**Spec:** `docs/specs/gemini-payg-metered-lane.md` §1, §2, §4.1/§4.3/§4.7/§4.8, §5 (settle table), §6, §10 (approved 2026-11-20)
**Tier:** 2 (money path + multi-machine authority). Size: ~2,300 LOC across 9 new and 6 touched source files, plus 6 test files.
**Second-pass reviewer:** see the end of this file.

## Summary of the change

Everything a paid Gemini call needs except go-live (slice E). Built on slice A (key fence) and slice B (money model). Ships DARK: nothing can spend until a door has a PIN go-live record, a verified price and `releaseState: live`, none of which this change creates.

**C — the door (in-process, never a CLI):**
- `src/providers/metered/gemini-api/`:
  - `geminiApiTransport.ts`: the only network calls. The host is a code constant, the key travels only in `x-goog-api-key`, every error is redacted, and outcomes are classified for the settle table. Timeouts are derived (30s + reserved output ÷ throughput floor, 900s cap). It never retries.
  - `geminiApiKeyReader.ts`: the one named reader. It refuses a plain-config copy and a fingerprint that is not the committed `keyGeneration`.
  - `geminiApiModels.ts`: the door's own table (Neon, Hydrogen). An unknown model is refused, never defaulted.
  - `GeminiApiProvider.ts`: the §5 order is preflight (before any key use), then the exact-value live-secret check, then countTokens (a failure refuses), then reserve, then one call, then settle (actual / full reserve / no-charge / provisional). Text is only from non-thought parts; a non-STOP finish is marked incomplete.
- `src/server/geminiPaygRoutes.ts`:
  - `POST /intelligence/gemini` (E2: loopback + no forwarding headers, `purpose` required, session from the registry);
  - `POST /intelligence/gemini/review` (E1: the spec must be real — realpath under the allowed roots, in `docs/specs/`, sha256 match, payload bound to the spec text, every inlined context doc listed by the spec and a prefix of the real file; Neon, stepping down to Hydrogen only on cap-exceeded/per-call-ceiling);
  - `GET /intelligence/gemini/status`.
  - Shared executors, so a forwarded call runs the same code as a local one.
- `crossModelReviewer`:
  - a `gemini-api` reviewer family. It is a thin client of the LOCAL route, active only where the door is configured (the fleet's active set is byte-identical), shares `familyKey: gemini`, and replaces the gemini CLI on such an agent (never a CLI fallback).
  - `ReviewerFrameworkId` widens the registry id without adding `gemini-api` to `IntelligenceFramework` (FD-G3).
- `cross-model-review.mjs` gains `--round`, a loopback door probe, and the spec binding.
- `lint-no-direct-llm-http` gets the one allowlist entry the spec names.

**D — one spender:**
- `src/core/meteredLaneMesh.ts`:
  - the holder call store: once per callId, 30 min / 64 MB retention, polls gated by the origin-generated result token, `settled-result-lost` that never re-dispatches;
  - the origin forwarder: submit then poll, 2s→10s backoff, derived deadline + 60s, three transport failures with no evidence of receipt ⇒ holder-unreachable with resume fields;
  - the designation echo: a fresh nonce, timed on the holder's clock, backoff capped at 20s, one in flight per peer; a backed newer conflicting claim freezes;
  - the 176s failover boot-check helper.
- `src/server/meteredLaneRuntime.ts`: designation (own caps record, else the holder's echo), forwarding, the holder side of the five verbs, stop actions that reach the spender ("confirmed" only from the spender), and the lease input.
- `MeshRpc`: five verbs (`metered-gemini-call`, `metered-gemini-result`, `metered-stop-action`, `designation-echo`, `secret-names`), registered-peer RBAC (the handlers are the gate).
- `commands/server.ts`:
  - the five handlers delegate to the runtime;
  - the lane's transport unwraps `MeshRpcClient` results;
  - both secret-sync sites now get `meteredDesignation` + `selfMachineId` (slice A review note 3).
- `src/server/geminiPaygWiring.ts` builds the money port over slice B's `preflightMeteredCall`/`admitMeteredCall` and the gate's settles, plus the reader, the provider, the runtime and the router.
- `AgentServer`:
  - builds the lane on every machine and mounts the router behind the Bearer middleware;
  - replaces the `poolOn ? null` lease stub with the runtime's echo;
  - starts the echo on pool agents.

**A parent-layer fix found while wiring (blocks this work):** the money gate and the enable surface took their machine id from `config.machineId`, which most agents (including Echo) never set. So every machine of a pool called itself `single-machine`, and every one would have passed the gate's designation check at once: a dual spender. Both now use the mesh id (`meshSelfId`), falling back as before only on single-machine installs.

**Awareness:** `src/data/awareness/gemini-payg-lane.md` (how to ask for a second opinion, read spend, who may stop/raise, no key, no conversations).

## Decision-point inventory

- Provider: preflight-before-key, exact-value secret refusal, `token-count-unavailable`, unknown model, the settle classification (D6, D8; invariants under Rule 4/86).
- Routes: loopback/forwarded-header ingress refusal; E1 spec-reality validation (D14); the Neon→Hydrogen step-down (D9: a deterministic fit, two models).
- Mesh: holder-only call store, result-token ownership, callid-conflict; stop actions reduce-only; designation conflict freeze (D7); forward vs refuse (D11: never a local spend).
- Gate machine id: the designation comparison now uses the real machine id (strictly safer).

## 1. Over-block

- E1 refuses a spec outside the agent home. The cartographer-root allowance (§2) is not wired yet: `reviewRoots` is the agent home only. Echo's worktrees are under the agent home, so Echo's reviews work. A spec in another checkout is refused `spec-outside-allowed-roots` (fail closed). Wiring `CartographerRootRegistry` belongs with whoever next needs a non-home root.
- The E1 context check requires the inlined text to be a prefix of the real file (first 4 KB checked). A context doc edited between assembly and the call is refused `context-not-bound`; rerun the round.
- A request with no live designation answers `money-layer-off` on every machine, by design (fleet default).
- The exact-value secret scan treats every vault leaf and every credential-named env var of 12+ characters as secret. A prompt that legitimately quotes such a value is refused. That is the secrets ruled exception.

## 2. Under-block

- Same-uid sessions share the bearer token and can impersonate a review run or read the vault directly (the spec's stated honest limit). The routes bound a runaway; they are not a defence against a malicious session.
- The echo reply rides the TLS/WireGuard connection to the peer's registered endpoint; it is not separately signed. The holder's nonce is fresh per round and sent in a signed, recipient-bound envelope, so a forged echo needs the nonce plus a position on that connection. Stated as a limit; the one-key fence is the real dual-spender protection.
- The "either direction" echo (a peer pulling a nonce over the holder's tunnel) is not built. The holder pushes only, and `MeshRpcClient` already carries the envelope over whichever peer URL resolves. One-way rope failure can therefore fence a healthy holder. That is the safe direction, and it is the Proportion note's suggested §6 simplification.
- `freezeRequested` on the session-status advert (a stop issued while the holder is unreachable) is not built. Such a stop returns `confirmed: false` and the caller says "stop requested; the spending machine has not confirmed yet". The issuer must retry.
- `release-proof-forward` is accepted by the verb but answered `unsupported-op` until slice E's recorder lands.
- Notices on a designation conflict / plain-config copy go to the server log only; slice E routes them to the spend-alert voice.

## 3. Level-of-abstraction fit

The provider is behind slice B's one chokepoint (`meteredCallEntry`); no new path reaches the gate. The route executors are shared by local and forwarded calls. The mesh logic is transport-independent (pure module + runtime facade), so the 30k-line server files carry only thin hooks.

## 4. Signal vs authority compliance

Blocking authority is limited to the ruled exceptions and recorded governed state: money (caps, freeze, live, caller lists, release state, designation) and secrets (exact key name, exact secret values). Key-shaped text is a recorded signal only. The step-down is a deterministic fit between two models (D9's argued exemption).

## 4b. Judgment-point check

None. Every refusal is an exact test on recorded state or an exact value match.

## 5. Interactions

- **Lease stub replaced.** A pool agent's gate previously always self-fenced (`null`). It now confirms through the holder's echo when this machine is designated. Nothing can spend yet (no go-live).
- **Machine id change.** On a pool agent the probe door's designation is rewritten from `single-machine` to the mesh id on first boot (one audit row). The readiness probe is unaffected (same machine).
- **Reviewer registry.** The fleet's active set is unchanged; `TRUSTED_REVIEWER_FRAMEWORKS` gains `gemini-api` (pin tests updated with the reason).
- **Secret sync.** Metered keys now reach the designated machine only after go-live writes a designation. Today, still nowhere.
- The router mounts before the document-link routes; it owns only `/intelligence/gemini*`.

## 6. External surfaces

- New Bearer routes:
  - `POST /intelligence/gemini`
  - `POST /intelligence/gemini/review`
  - `GET /intelligence/gemini/status`
- Five new mesh verbs. An old peer answers 403 claim-unauthorized, mapped to `peer-version`.
- New awareness text for every agent.
- One new external host, `generativelanguage.googleapis.com`. It is reached only after go-live, and only from the designated machine.

## 7. Multi-machine posture

Exactly the spec's §"Multi-machine posture":
- money authority is single-writer on the designated machine;
- E1/E2/stop actions are proxied to it by signed mesh command;
- the designation is unified by the active echo;
- E3 is skipped off-holder;
- the metered key is machine-local (`machine-local-justification: physical-credential-locality`).

The parent machine-id fix is what makes "designated" mean one machine.

## 8. Rollback cost

Revert restores the lease stub (pool agents self-fence again) and removes the routes and verbs. No state is written by this change except the probe-door designation rewrite (harmless; re-written back by the old code on boot). No money can have moved: nothing here goes live.

## Second-pass review

(appended below by the independent reviewer)

### Reviewer verdict (independent subagent)

Concern raised. I found no path that overspends or leaks the key: preflight runs before the key is used, the reservation is made before the single generateContent call, and a 200 missing `promptTokenCount` or `candidatesTokenCount` books the full reserve. The key travels only in `x-goog-api-key` and is redacted from errors. "Confirmed" comes only from the spender's own `applyStop`. The stop mutators are reduce-only and absolute, so a retry is harmless. All 67 targeted tests pass (unit 44, integration 19, e2e 4). They did not catch the issues below, ranked by severity:

1. **Slice D's transport is never connected in production.** `src/commands/server.ts:31128` calls `_agentServerRef?.meteredLaneRuntime?.setSend(...)` before `_agentServerRef = server` runs (`:36811`). The email forwarder next to it is re-applied at `:36812` for exactly this reason, and this one is not. Result: `send` stays null. The holder's echo never confirms, so it fences. Non-holders never learn the designation, so they answer `money-layer-off`. Stops from other machines never arrive. The failure is safe for money, but §5's "lease stub replaced" claim is false on a real server. Fix: re-apply `setSend` after the server is assigned.
2. **A resubmit returns the result without checking the token** (`src/core/meteredLaneMesh.ts:101-104`). `submit()` on an existing callId with a matching `requestSha256` returns `stateOf(existing)`, and that includes the `done` body. The token is never compared. A callId is not secret (forwarded refusals and `retryWith` both return it). So any registered peer, or a same-uid session on one, can resubmit the callId and read another session's paid result. §6 requires a matching resultToken. Fix: compare `resultTokenHash` and answer `not-yours` when it differs.
3. **A peer-registry failure counts as "single machine"** (`AgentServer.ts`, the `peers` closure catch; `meteredLaneRuntime.ts:317`; `meteredLaneMesh.ts:298`). If `getActiveMachines()` throws, or the coordinator is absent while `sessionPool.enabled` is on, peers is `[]` and `leaseConfirmedAgoMs` returns 0. The holder then confirms itself, although the code comment says this case fences. §6 says unknown fences. Fix: return null for "registry unreadable" and keep `[]` for "no peers registered".
4. **The holder passes the peer's payload straight into `provider.call`** (`meteredLaneRuntime.ts:146`). A forwarded second opinion can carry `e1Slot` (which uses up a review round's pass), any `component` it likes, and `thinkingBudget`. `proofMarker` is dropped only because the wiring's `reserve` happens not to forward it. Fix: rebuild the call from an allowlist of fields.
5. **The secret check scans JSON-escaped text** (`GeminiApiProvider.ts:180`). Secrets containing `"`, `\` or control characters are escaped by `JSON.stringify` and never match, and the vault holds real passwords. Fix: scan the raw prompt and system-instruction strings.
6. **A failed door probe falls back to the gemini CLI** (`cross-model-review.mjs` `fetchGeminiApiDoor`). On an agent whose door is configured, a 3 s timeout or a missing `INSTAR_AUTH_TOKEN` gives `undefined`, and the gemini CLI becomes active again. §2 says "never a CLI fallback". Fix: fail closed when the probe fails.
7. **Minor:**
   - Forwarded reviews book under their own E1 callId, so after a holder restart a poll gets `unknown` until its deadline instead of `settled-result-lost`. Money is still deduped.
   - `lastSeen` is overwritten by any peer's echo whatever its epoch (`runtime:185`).
   - A pending stop is dropped on any refusal other than unreachable, including `not-holder` (`runtime:267`).
   - `sent=true` is set before `fetch`, so a DNS failure books a provisional charge. That over-books (the safe direction), and the `not-sent` outcome can never happen.
   - For the go-live slice: it must write the mesh id as `designatedMachineId`.

### Folded after review (all six concerns + four minors)
1. **Transport never connected** — the lane transport is now kept in `_meteredLaneSend` and re-applied right after `_agentServerRef = server` (beside the email forwarder). Also found while fixing: the review driver's config loader dropped `port`, so its door probe could never run; `port` now passes through.
2. **Resubmit without the token** — `HolderCallStore.submit` answers `not-yours` when the resubmitted `resultTokenHash` differs (test added).
3. **Unreadable registry = single machine** — `peers()` returns `null` for unknown (no identity manager on a pool agent, or a throwing registry); the tracker and the runtime both fence on `null` (test added).
4. **Raw peer payload** — the holder rebuilds a forwarded second opinion from an allowlist (prompt, systemInstruction, model, maxOutputTokens, a `second-opinion:` component); an E1 slot, proof marker, thinking budget or foreign component can no longer ride in (two-machine test added).
5. **JSON-escaped secret scan** — the exact-value check scans the raw system-instruction and content strings (test with a quote, backslash and newline).
6. **Probe failure re-enabled the CLI** — the driver reads the local caps record; where the door is configured, any probe failure (no token, timeout, 404, 5xx) yields `{configured:true, ready:false}`, so the gemini CLI stays excluded.
Minors: `lastSeen` accepts only an equal-or-newer epoch; a pending stop is kept on `not-holder` as well as unreachable; the go-live slice is briefed to write the mesh id as `designatedMachineId`. The forwarded-review restart window (`unknown` until deadline rather than `settled-result-lost`) is accepted: money stays deduped by the E1 callId. The `not-sent` outcome being unreachable is accepted: it only over-books.

### Reviewer re-check

Concur, concerns resolved. One residual issue remains on non-holder machines. It does not block this change, because it puts no money or secret at risk.

I checked each fold against the code:
1. **Transport:** `_meteredLaneSend` is set again after `_agentServerRef = server` (`server.ts:36816`). The `port` passthrough was also added (`cross-model-review.mjs:318`).
2. **Resubmit:** `submit` answers `not-yours` when the `resultTokenHash` does not match (`meteredLaneMesh.ts:104-106`).
3. **Unreadable registry:** `peers()` returns `null` when it cannot read the registry on a pool agent or when the read throws. Both `leaseConfirmedAgoMs` paths treat `null` as fenced.
4. **Forwarded second opinion:** the holder rebuilds it from an allowlist (`meteredLaneRuntime.ts:144-162`). No E1 slot, proof marker or thinking budget gets through.
5. **Secret scan:** it now runs over the raw text parts.
6. **Door probe:** it now reads the right caps file, `<stateDir>/state/routing-spend-caps.json`.
- **Minors:** `lastSeen` is guarded by epoch, and stops refused with `not-holder` are kept.

Tests: 71 pass when I run them (unit 47, integration 20, e2e 4).

**Residual, non-blocking:** fold 6 fails closed only where this machine holds the go-live record itself (`cross-model-review.mjs:356/363/368`). A non-holder learns the door is configured only from its server, through the holder's echo. So on a standby such as the Mama PC, a failed probe turns the gemini CLI back on: no `INSTAR_AUTH_TOKEN`, a timeout, a 404 or an exception. The same happens on any non-OK status, which yields `configured:false`. Suggested fix: persist the echoed designation (for example in `state/`) and treat it as configured locally.

**Residual from the re-check, folded:** a standby now persists the designation it hears (`state/gemini-payg-seen-designation.json`, equal-or-newer epoch only), reloads it at boot, and the review driver treats that file as "configured" — so a failed probe on a standby keeps the gemini CLI excluded too (two-machine test added).

### Main moved: the request-arrival rule (2026-11-20 22:55 PST)
The second Local Verify run failed on `request-arrival-ratchet`, a rule that landed on main while this PR waited. Every local-only test must first ask `mayBeLocalArrival(req)`, so that a request arriving on the same-network listener is never mistaken for loopback. The four local-only checks in `geminiPaygRoutes.ts` (E2, E1, status) and `geminiPaygGoLiveWiring.ts` (key handoff) now ask it first, ahead of `isLoopbackPeer` and the forwarded-header check. That is strictly more refusal and no new access.
