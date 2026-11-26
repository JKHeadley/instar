# Side-Effects Review — A2A inbound-id ledger: cross-namespace label

**Version / slug:** `a2a-cross-namespace-label`
**Date:** `2026-10-08`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-inbound-id-ledger.md §1 "The same id under another namespace of the same fingerprint is labelled, never suppressed" (an amendment to the converged spec; approved under the operator's standing approval for the agent-comms track, 2026-10-06 18:57, topic 122413). Tracked as ACT-061.

## Summary of the change

Seen in a live two-agent proof on 2026-10-08: a same-machine POST to `/messages/relay-agent` timed out at 10 s, the sender fell back to the relay with the same id and `resend: true`, the relay copy arrived first (row under `unverified:<fp>`, labelled), and the original local copy was processed later under `registry:<fp>`. The ledger's namespaces never read each other, so the late copy went through as a plain new message: the receiving agent saw the same message twice with no warning on the second.

The fix adds a label and nothing else. `InboundIdLedger.admit()` (`src/threadline/InboundIdLedger.ts`), after a successful commit and in the same synchronous tick, calls `hasCrossNamespaceRow(senderKey, messageId)`: at most three primary-key reads for the same `message_id` under the other fingerprint namespaces (`<fp>`, `unverified:<fp>`, `registry:<fp>`, `asserted:<fp>`) of the same fingerprint. The `admitted` result gains `crossNamespace: boolean`, and a persistent counter `crossNamespaceLabelled` is bumped. The three ingress call sites treat `crossNamespace` exactly like `readmissions > 0`: the relay socket (`admitRelayInbound` in `src/threadline/inboundIdLedgerWiring.ts`), `/threadline/messages/receive` (`src/threadline/ThreadlineEndpoints.ts`) and `/messages/relay-agent` (`src/server/routes.ts`) pass the existing `buildResentNotice(false)` text through the existing `resentNotice` option. Two pure helpers define the rule: `fingerprintOfSenderKey` and `crossNamespaceKeys`. Awareness: one marked paragraph in the template (`src/scaffold/templates.ts`), its own sniff-keyed step in `migrateClaudeMd` and a shadow marker (`src/core/PostUpdateMigrator.ts`).

## Decision-point inventory

- Whether an admitted copy carries the resent-copy notice — **modify** — one more trigger (same id, another namespace, same fingerprint) for an existing fixed notice. Invariant: exact fingerprint equality, at most three primary-key reads.
- Admit / duplicate / re-admit an inbound id — **pass-through** — unchanged; the read runs after the decision and cannot feed it.
- Namespace separation (local rows never suppress; verified paths consult verified rows only) — **pass-through** — unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change cannot refuse, drop, delay or re-route a message. The nearest thing to an over-block is an unneeded notice: a copy that is genuinely a different message but reuses another route's id for the same fingerprint gets "resent copy — check this thread's history before replying". Reusing an id for a different payload is already the sender's contract violation (spec §1), and the notice only asks the model to look at the thread.

A second unneeded-notice case, found by the second-pass review: the match is on the row in any disposition, so the earlier row may be a copy that never reached a model (`refused`, `handoff-failed`, or `admitted` by a dead process). Example: the relay copy from an unknown sender is refused by the autonomy gate, then the legitimate local copy — the only one delivered — carries the notice. This matches today's notice on a re-admission after a refusal. The plain notice has no "if history does not show it, treat it as new" clause, so the awareness paragraph now states that rule in terms.

## 2. Under-block

No block/allow surface. What the label still misses, each staying an unlabelled duplicate as today:

- A copy keyed `local:relay-agent:<name>` (the sender is not in the registry and stated no fingerprint) carries no fingerprint and is never matched.
- Two keys whose fingerprints differ only in letter case, or a registry entry that resolves to a different fingerprint than the relay attests (a re-keyed peer).
- The first row was never written (ledger dark, cooling down, broken, unkeyed, a full `unverified:` space), evicted, or pruned.
- The other copy landed on another machine (the §4 windows; ACT-054 owns rows that cross machines).
- Two copies where the FIRST-admitted is dispatched second: the first-admitted carries no label (no other row existed yet); the second-admitted is labelled. The receiving session still sees one labelled copy.

## 3. Level-of-abstraction fit

The read lives inside the ledger, next to the commit, because the ledger owns the key shapes and the rows; the ingress sites only consume one boolean the same way they consume `readmissions`. No ingress re-implements the rule. It uses the existing notice builder and the existing `resentNotice` plumbing rather than a second notice path. It is a cheap deterministic detector feeding an advisory prompt line to the receiving model, which is the reasoning layer that decides whether to answer.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The cross-namespace row is a signal. It is consumed only to add a fixed server string outside the untrusted framing. The other namespace's row is never used to choose an admission, a disposition or an HTTP answer — the property the spec's Know Your Principal rule depends on (an identity only read in a request body never suppresses a verified one) is untouched, and a unit test pins it (a terminal row still dedups only in its own namespace; a forged `asserted:` row leaves the verified row `retryable`).

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The rule is enumerable (four key shapes, exact string equality) and decides nothing; it is listed as an invariant in the spec's "Decision points touched" table.

## 5. Interactions

- **Shadowing:** runs after the admission transaction and cannot shadow it. `duplicate`, `in-flight`, `error` and `unrecorded` results are returned before it and never reach it.
- **Double-fire:** a copy can be labelled for more than one reason (a `resend: true` body, a re-admission and a cross-namespace row). All three produce the same single notice string; it is never appended twice. On the relay socket, §4's peer annotation can still replace the plain notice with the "another of my machines" wording — unchanged.
- **Races:** `better-sqlite3` is synchronous; the commit and the read run in one tick, so a concurrent arrival under another namespace is either committed before (seen) or after (it then sees this row). Both orders label the later admission.
- **Feedback loops:** none. The read writes no row; the counter is in memory and flushed on the existing timer.
- **Content window / gate lookup:** untouched. `relayKnownId` on `/messages/relay-agent` still looks only at the route's own key and the registry-resolved verified key.
- **Fail direction:** a failed read returns `false` and does not call `onDbError`, so a transient read failure cannot start a cooldown that would dark the ledger after an admission that succeeded.

## 6. External surfaces

- The receiving session sees the existing resent-copy notice on one more class of message. Senders see no change: HTTP answers and relay behaviour are identical.
- Authed `/health` → `threadline.inboundIdLedger` gains `crossNamespaceLabelled` (additive; persisted in `ledger_meta` with the other counters — an older build reading the JSON ignores the extra key).
- CLAUDE.md gains one paragraph for new and existing agents, and for Codex/Gemini shadows.
- No schema change, no new index, no new file, no new route, no config key.
- Disclosure: no new one. The label reveals to the receiving session only that a copy of this id was already admitted on this machine for the same fingerprint; the session already receives both copies. A token holder or the relay that knows an id before its verified copy arrives can cause the notice to appear on that verified copy; the copy is still delivered and no history is exposed to the sender (answers are unchanged). Combined effect, stated (second-pass finding): that party can first send its own text on the same thread under an unverified key with the known id, so the genuine verified copy arrives labelled and the history does show an earlier message — a new nudge against answering the genuine copy. The bound is the model checking the history (the earlier text is a different message) and the awareness paragraph's rule; the party needs this agent's token or a seat on the relay path, and no message is lost at the transport. Recorded in the spec's §1 "What the notice can get wrong".
- Operator surface: no operator-facing actions.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, inheriting the ledger's posture: each machine writes only its own rows and the label reads only this machine's rows, because a peer's answer is unauthenticated and the ledger file is per-machine in-flight state. The pool-wide question ("did any of my machines get X?") is already answered by the proxied-on-read `GET /a2a/inbound-ids?scope=pool`, and a marked relay resend is annotated from the bounded peer read (§4). A late copy that lands on a different machine than the first is one of the stated §4 duplicate windows. It emits no user-facing notice (the notice goes to the receiving model inside the injected text, on the machine that received the copy), holds no new durable state, and generates no URLs.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state to clean: the extra counter key in `ledger_meta` is ignored by older code. `threadline.inboundIdLedger.enabled: false` (live) turns the whole ledger off, the label with it. The CLAUDE.md paragraph would stay on updated agents after a revert; it describes a label, so a stale copy costs at most a mistaken expectation, and a revert would remove the template text.

---

## Conclusion

The change is a notice on a message that is delivered either way. The review confirmed it reads after the decision, writes no row, fails toward today's behaviour, and leaves namespace separation intact. One design choice came out of the review: the read is three exact primary-key lookups rather than a scan by `message_id`, so there is no row cap an attacker could fill to hide a match and no new index. Clear to ship behind the existing dev gate.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (fresh context; given the diff, the amended spec, this artifact and the tests — not the author's conclusions)
**Independent read of the artifact: concur**

Verdict: the code is a label only — no path drops, refuses, delays or re-answers a message, and the read cannot start a cooldown; all three `ledger.admit` sites consume the flag and the notice reaches the pipe, listener and router paths on the relay socket; real key pairs for one peer match byte-for-byte (32 lowercase hex on every route). No blocker. Findings raised and how each was resolved before commit:

1. *Threat statement undersold a combined effect* (an unverified party sends its own text first, so the genuine verified copy arrives labelled with history that does show an earlier message). Resolved: stated in the spec's §1 "What the notice can get wrong" and in §6 here; the awareness paragraph now says a notice is a prompt to look, and no earlier copy of the same message in the history means it is new.
2. *The label can land on the only delivered copy* (the earlier row was `refused` / `handoff-failed` / dead-epoch). Resolved: added to §1 here and to the spec; same behaviour as today's re-admission notice.
3. *"Those lists never decide for each other" was false for the local route's bare answer on a terminal verified row.* Resolved: reworded in the template, the migrator, the spec and the ELI16 to "an identity I did not verify never stops a message".
4. *Shadow migration was only grepped.* Resolved: a test now runs the real shadow migration on an `AGENTS.md` that already carries the ledger section and checks the paragraph lands exactly once.
5. *Counter wording.* Resolved: the paragraph says "counts each such admission"; noted under Evidence pointers.
6. *Missing unit cases.* Resolved: added a letter-case miss, a full `unverified:` space, and the relay in-flight wait's re-run admission.
7. *`crossNamespaceKeys()` outside the `try`.* Resolved: moved inside.
8. *The paragraph did not name the relay-vouched identity.* Resolved: it now lists all three kinds.
9. *No-router `/messages/relay-agent` stores with no notice* — inherited (true of every notice today, and production always wires a router); unchanged.

---

## Evidence pointers

- `tests/unit/a2a-inbound-id-ledger.test.ts` — "cross-namespace label" block (12 tests).
- `tests/integration/threadline/inbound-id-ledger.test.ts` — the live sequence through the real routes (4 new tests + 1 extended).
- `tests/e2e/threadline/inbound-id-cross-namespace-alive.test.ts` — production controller + real listening server.
- With the read disabled, 10 of the new tests fail on the missing notice (checked before commit).
- Note: `crossNamespaceLabelled` counts admissions where the match was found, not deliveries; it also counts a copy that a later gate then suppresses.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in ledger code (a missing label across namespaces), not in a prompt, hook, config, skill or standards text, and the change adds no self-triggered controller.
