# Side-Effects Review - Relay Scope Detail

**Version / slug:** `relay-scope-detail`
**Date:** `2026-07-26`
**Author:** `Codex`
**Second-pass reviewer:** `not required`

## Summary of the change

This change narrows the human-readable claim made by `src/core/instarChannels.ts` for the `threadline-relay` channel. The runtime state is unchanged: a connected server-process relay client still reports `working`, and a disconnected server-process relay client still reports `broken`. The detail text now names the measured subject as the server-process relay client and states that another process, notably the MCP tool path, owns its own relay client state. `tests/unit/channel-registry-claims.test.ts` adds real-builder coverage for that scope and pins the existing `mutual-ssh` caveat as the precedent.

## Decision-point inventory

- `src/core/instarChannels.ts` `threadline-relay` probe detail - modify - the registry detail now names the server-process relay client as the subject of both working and broken readings.
- `src/core/instarChannels.ts` `threadline-relay` cost text - modify - the static cost text now notes that another process can hold a different relay state.
- `tests/unit/channel-registry-claims.test.ts` relay-scope assertion - add - the test verifies the real resolved channel output names the server process, MCP tool path distinction, and no send-delivery promise.
- `tests/unit/channel-registry-claims.test.ts` mutual-SSH exact assertion - modify - the test now pins the existing caveat exactly so the precedent cannot be weakened silently.

---

## 1. Over-block

No block/allow surface - over-block not applicable. The change does not reject inputs, deny operations, alter admission, or change any runtime state transition.

---

## 2. Under-block

No block/allow surface - under-block not applicable. The remaining failure mode is informational: a caller could still ignore the scoped detail and treat `working` alone as a send guarantee. That is outside this small wording fix; the row now provides the precise caveat needed for callers that read details.

---

## 3. Level-of-abstraction fit

This is at the registry-claim layer. The registry already owns the prose that explains what each probe measured, and the defect was in that prose rather than in the relay client, server route, or MCP implementation. The change does not add a detector or authority; it makes the existing low-level signal name its scope honestly.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No - this change produces a signal consumed by an existing smart gate.
- [x] No - this change has no block/allow surface.
- [ ] Yes - but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] Yes, with brittle logic - STOP. Reshape the design.

This change has no blocking authority. It changes explanatory text attached to an already-existing channel probe result.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The change does not decide between conflicting live signals; it labels one signal's subject more precisely.

---

## 5. Interactions

**Shadowing:** No new check runs before or after another check. Existing callers still receive the same channel ids, states, and directions.

**Double-fire:** No new event, retry, notification, send, or recovery path is introduced.

**Races:** No shared mutable state is added. The probe still reads the injected `relayStatus()` function exactly once per resolution.

**Feedback loops:** No feedback loop is changed. The registry output may influence human or agent choice of channel, but this patch only clarifies what the output means.

---

## 6. External surfaces

`GET /channels` and any internal consumer of the channel registry will show clearer prose for `threadline-relay`. Other agents and users may see the updated detail text after upgrade. No external systems are called. No persistent state, database row, ledger, or memory file is changed. No operator-facing action is added; the dashboard/API display remains a read-only informational surface for this row.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface - not applicable. This change touches no dashboard renderer, approval page, grant/revoke form, or secret-drop form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: relay client connection state is a per-process and per-machine runtime truth. The registry should report exactly the process it measured rather than pretending the value replicates across machines or sibling processes. The change emits no user-facing notices, holds no durable state, and generates no URLs.

---

## 8. Rollback cost

Hot-fix release: revert the text and test changes, then ship the next patch. There is no data migration, no agent state repair, and no persistent cleanup. During rollback propagation, users would only lose the more precise registry wording.

---

## Conclusion

The review found no side-effecting runtime behavior. The implementation keeps the existing `working` and `broken` verdicts while making their subject explicit. The only visible change is clearer registry prose, backed by unit tests that fail if the scoped relay claim or the existing mutual-SSH scope caveat is weakened.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

Second-pass review is not required for this Tier 1 wording-and-test change.

---

## Evidence pointers

- `./node_modules/.bin/vitest run tests/unit/channel-registry-claims.test.ts tests/unit/user-channel-liveness.test.ts`
- Falsification restored the old relay detail and confirmed the relay-scope test failed on the missing server-process subject.
- Falsification shortened the mutual-SSH detail and confirmed the exact-precedent assertion failed.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect - not applicable.
