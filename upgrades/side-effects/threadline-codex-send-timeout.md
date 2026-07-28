# Side-Effects Review — Threadline Codex send timeout duplicate fix

**Version / slug:** `threadline-codex-send-timeout`
**Date:** `2026-05-30`
**Author:** `instar-codey`
**Second-pass reviewer:** `Darwin`

## Summary of the change

This change makes the MCP `threadline_send` tool default to fire-and-forget delivery acknowledgement instead of waiting synchronously for a peer reply. The root cause came from live Codey evidence: local delivery to Echo succeeded, but the MCP tool call stayed open because `waitForReply` defaulted to `true`; Codex's tool layer timed out at about 30 seconds and retry-shaped duplicate sends followed. The changed runtime file is `src/threadline/ThreadlineMCPServer.ts`, with regression coverage in `tests/unit/threadline/ThreadlineMCPServer.test.ts`, explicit synchronous-reply e2e coverage in `tests/e2e/threadline/ThreadlineMCPE2E.test.ts`, an interop contract update in `docs/specs/THREADLINE-NETWORK-INTEROP-SPEC.md`, and regenerated manifest metadata in `src/data/builtin-manifest.json`.

## Decision-point inventory

- `threadline_send` MCP schema default — modify — omitted `waitForReply` now means "ack delivery and return" rather than "hold the tool call open for a synchronous reply."
- `threadline_send` explicit synchronous mode — pass-through — callers that set `waitForReply: true` still use the existing reply waiter and timeout semantics.
- Threadline interop documentation — modify — the documented MCP schema now matches the runtime default so downstream implementations do not preserve the old synchronous default accidentally.
- Threadline MCP e2e tests — modify — scenarios that assert reply messages in history now request `waitForReply: true` explicitly.

---

## 1. Over-block

No block/allow surface — over-block not applicable. This change does not reject any message or caller; it changes only the default waiting behavior when the caller omits an optional boolean.

The closest compatibility risk is behavioral: a caller that omitted `waitForReply` while implicitly depending on the old default will no longer receive a synchronous `reply` field. That caller can restore prior behavior by sending `waitForReply: true`. Existing tests that require replies already set `waitForReply: true`, and the tool description now states the default explicitly.

---

## 2. Under-block

This does not add a duplicate-send idempotency layer. It fixes the observed Codex retry trigger by returning promptly after accepted delivery. Duplicate sends caused by a caller explicitly setting `waitForReply: true` with a tool harness timeout shorter than the requested wait can still occur. That is intentional: explicit synchronous waits remain available for workflows that truly need request/response behavior.

This also does not protect non-MCP direct HTTP callers that implement their own retry loop without idempotency. The `/threadline/relay-send` API already treats omitted `waitForReply` as false; the bad default lived at the MCP schema boundary.

---

## 3. Level-of-abstraction fit

The fix is at the right layer: the wrong behavior was an MCP tool default, not local delivery, SpawnLedger, the relay, or the reply waiter itself. Adding dedup deeper in transport would help a broader class later, but it would not remove the immediate Codex-specific timeout trigger. Changing only the MCP default preserves explicit synchronous reply semantics while making reply-worker sends safe by default.

This is not a detector or a new authority. It is API-default hygiene at the boundary where model tool calls become HTTP sends.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority.

No brittle detector or blocking path is added. The change removes an accidental synchronous wait from the default send path; it does not decide whether content should be sent, surfaced, suppressed, or trusted.

---

## 5. Interactions

- **Shadowing:** The MCP default feeds `deps.sendMessage`, which posts to `/threadline/relay-send`. The HTTP route already waits only on truthy `waitForReply`, so the changed default aligns the MCP layer with route behavior instead of shadowing it.
- **Double-fire:** The prior default created a double-fire risk by holding the tool call open past Codex's MCP timeout after delivery had already succeeded. The new default removes that retry pressure for omitted `waitForReply`.
- **Races:** No shared state is introduced. Existing reply waiters, pending wait maps, and inbound reply resolution remain used only when the caller explicitly asks to wait.
- **Feedback loops:** The change reduces the retry loop where a timed-out tool call led the model/harness to issue the same `threadline_send` again.

---

## 6. External surfaces

- **Other agents:** Agents receiving Codex-origin Threadline replies should see fewer duplicate identical messages. Agents that rely on a synchronous response from `threadline_send` must set `waitForReply: true`.
- **Interop readers:** The Threadline network interop spec now documents the new default. Implementers reading the spec should see the same default the MCP server enforces.
- **Users:** Telegram topics that mirror agent chatter should see less duplicate inter-agent spam.
- **External systems:** No relay protocol, Telegram, Slack, GitHub, or Cloudflare surface changes.
- **Persistent state:** No migration or state write shape changes. Existing conversation, outbox, and Threadline stores keep the same schema.
- **Timing:** The default tool call now returns as soon as delivery is accepted instead of waiting up to `timeoutSeconds`; explicit waits retain the old timing.

---

## 7. Rollback cost

Rollback is a small code revert: restore `waitForReply` default to `true` and ship a patch. No data migration or agent state repair is needed. The rollback risk is reintroducing Codex duplicate sends when the tool harness times out before the reply waiter returns.

---

## Conclusion

This is clear to ship as a targeted default correction. It addresses the live Codey duplicate-send root cause without weakening transport validation, changing the relay protocol, or removing explicit synchronous request/response capability.

---

## Second-pass review (if required)

**Reviewer:** Darwin
**Independent read of the artifact: concern raised, then resolved**

Darwin's second-pass concern was that `docs/specs/THREADLINE-NETWORK-INTEROP-SPEC.md` still documented `threadline_send.waitForReply` with `"default": true`, which would let downstream agents or implementers continue relying on the old synchronous default. Resolved by updating that interop schema to default `false` with an explicit note that callers should set `true` only when a synchronous reply is required.

---

## Evidence pointers

- `npm test -- tests/unit/threadline/ThreadlineMCPServer.test.ts` — 45 tests passed, including the new omitted-`waitForReply` regression.
- `npm test -- tests/e2e/threadline/ThreadlineMCPE2E.test.ts` — 15 tests passed after making synchronous-reply scenarios explicit.
- `npm run test:smoke` via pre-push — passed the affected smoke set before the Threadline-scoped e2e gate exposed implicit synchronous-wait test assumptions.
- `npm run lint` — passed.
- `npm run build` — passed; `sign-lockfile` warned that no local signing key is configured, which is the documented transitional local-dev state.

## Post-main-merge verification

After `origin/main` advanced to `1.3.116`, this branch merged main cleanly and regenerated `src/data/builtin-manifest.json` so the manifest version matches the release base. Re-verification after that merge: `npm test -- tests/unit/threadline/ThreadlineMCPServer.test.ts tests/e2e/threadline/ThreadlineMCPE2E.test.ts` passed 60/60, and `npm run build` passed with the same local signing-key warning described above.
