# Side-Effects Review — the dashboard never loses a reply quietly (native-conversation-any-machine-access slice 3e)

**Version / slug:** `ncb-3e-input-durability`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent general-purpose subagent (see below)`

## Summary of the change

Tier 2 (spec `docs/specs/native-conversation-any-machine-access.md`, converged and approved; this PR builds slice 3e only). Source: 3 new modules (`src/server/InputIdLedger.ts`, `src/server/dashboardInputAwareness.ts`, `dashboard/console/input-model.js`) and 7 changed files (`WebSocketManager.ts`, `PeerStreamProxy.ts`, `routes.ts`, `templates.ts`, `PostUpdateMigrator.ts`, `dashboard/console/sessions.js`, `console.css`); about 700 added source lines. Tests: 4 new files, 3 extended, across all three tiers. One build pass; the spec's review rounds belong to the spec.

What it does (F5: a reply typed in the dashboard session view did not arrive, and the box had already cleared):

- **Serving side (`WebSocketManager`).** Every subscribe answers `input_caps` first (`inputAck: 2`; `remoteInput` is `dashboard.poolStream.allowRemoteInput` for a peer link, `true` for a local browser). An `input`/`key` frame may carry `clientInputId` (`/^[A-Za-z0-9_-]{16,64}$/`, validated before echo; malformed → `invalid-input-id`, never typed). With an id: known id → the original `input_ack` on the connection it came in on, no write (a repeat that arrives mid-write waits for the original ack); unknown id + `retry: true` → `input-retry-unknown`, not typed; else record → write → ack with the id. Every refusal echoes the id. Id-less frames keep today's path exactly.
- **`InputIdLedger`.** Seen ids per session (newest 256, in memory), counters per session (`evicted`, `retryUnknown`, `repeated`, bounded to the most recent 1024 sessions) and totals; ids of sessions no longer running are dropped every 5 s.
- **Relay side.** `PeerStreamProxy` keeps the last `input_caps` per session for the current link, synthesises `{ inputAck: 1, remoteInput: null }` when an older serving machine answers a subscribe with `subscribed` and no caps, clears all caps on any link change, and `relayInput`/`relayFrame` return whether the frame was sent. `WebSocketManager` replays cached caps to a tab that subscribes late, remembers which tab sent each pending id (bounded 4096; dropped on the answer, when the tab closes or unsubscribes, and when the link to that machine drops — Left behind 16), passes an id-carrying answer to that tab alone (an answer whose sender left is dropped), and answers `peer-stream-lost` with the id when the relay did not send.
- **Console (`input-model.js` + `sessions.js`).** The box waits for `input_caps` ("Connecting to that machine…"); read-only with the refusal sentence when remote input is off; sends with an id; keeps the text marked sending and clears it only on `input_ack { success: true, clientInputId: <its id> }`, however late. A first send that certainly typed nothing (refused before any write, unknown session, or never relayed) gives the text back with its sentence. A write that failed (`success: false`) may have typed part of the text, so it stays an unresolved card with the "could not type" sentence, Copy and Discard, and the session is asked. After 8 s with no answer the message moves above the box as "Not confirmed yet" (Send again only with `inputAck: 2`; Copy; Discard). Once per message the console types the spec's fixed `[dashboard] …` line into the session with a fresh id (waiting for the next `input_caps` if the link is down). Against `inputAck: 1` frames go without an id, the draft is unresolved at once, an id-less ack clears nothing, an id-less refusal shows its sentence and keeps the draft. Keys carry an id and only report.
- **Counters route.** `GET /sessions/dashboard-input-status` (bearer) → `inputIdsEvicted`, `inputRetryUnknown`, `inputIdsRepeated`, per-session counts, `allowRemoteInput`, `idsPerSession`, `relayPendingAnswers`. No text, no ids.
- **Awareness.** One CLAUDE.md paragraph ("Dashboard reply box:") telling sessions what the `[dashboard]` line is and how to answer it; template for new agents, content-sniffed migration plus framework shadow for existing ones.

The legacy dashboard page (`dashboard/index.html`) keeps its id-less path, as the spec says.

## Maturation plan row (from the spec)

| Slice | State at release | Rollback | Review | Proof that promotes it | Kill criteria |
|---|---|---|---|---|---|
| 3e dashboard reply box | live, every agent; remote input itself stays off by default | by version (dashboard files ship with the package) | Echo, 2026-11-25 | the two-server integration set, the two-client case, and the live proof at both screen sizes | text typed into a session twice; a draft cleared by anything but an acknowledgement with its id; a sentence that sends the person to check anything. Any one: roll back |

Rungs: test-agent-live (throwaway pair, remote input on only there, a serving machine on the previous release) before the release is published; dev-agent-live on Echo's pool from the release day, window ending at the 2026-11-25 check; fleet the same release with no gate; dark-window none; ladder not applicable (no flag, rolls back by version). Graduation reads the new counters route: at least one retry answered from a known id (`inputIdsRepeated`, else `unmeasured`), no session with both `evicted` and `retryUnknown` above zero, no feedback of text typed twice.

## Decision-point inventory

- What clears a draft — add — invariant: only an `input_ack` with `success: true` carrying the draft's id.
- Repeated `clientInputId` / unknown flagged retry — add — invariant: a known id is never written again; an unknown flagged retry is never written.
- Send control without dedupe — add — invariant: "Send again" only under `inputAck: 2`.
- Seen-id retention (256) and the 8 s label — add — judgment-candidates within the floors above; counters are the evidence.
- `allowRemoteInput` gate — unchanged (default off); its refusal now carries the id.

---

## 1. Over-block

- A flagged retry whose first try reached the machine but was forgotten (restart, or more than 256 newer ids for that session) is refused `input-retry-unknown`. The text stays on screen with Copy; the person can send it as a new message. This is the spec's accepted cost (Left behind 5): the floor prefers a refused retry to a possible double write.
- A malformed id is refused rather than typed. Only the console sends ids, and it makes valid ones; an old console sends none and is unaffected.
- Against an older serving machine every dashboard message is "not confirmed" and its session receives one extra line per message (Left behind 18). Accepted: the alternative is clearing on an acknowledgement that may belong to another tab.
- The box is disabled until `input_caps` arrives. A local session gets it in the same tick as `subscribed`; a remote one when the link is up, which is also when typing can work at all.

## 2. Under-block

- An `input_ack` with `success: true` means `sendInput` returned true (tmux accepted the keys), not that the model read them. Same as today; the session line covers the gap only when an ack is missing.
- A relayed answer whose browser tab disconnected is dropped; the reconnected tab learns the outcome only by "Send again" (which gets the original ack) or the session's own answer. Covered by the integration case.
- An older serving machine's id-less refusal is applied to the newest unresolved draft of that tab; with remote input off every input is refused, so the sentence is right; a `session-not-found` from another tab's input could be shown on this tab's draft. Effect: a sentence, never a cleared draft or a resend.
- Seen ids live in memory: a server restart forgets them; the floor (unknown flagged retry is refused) holds.

## 3. Level-of-abstraction fit

Dedupe sits on the serving machine, the only place that writes into the pane, keyed by session and id (the spec rejects per-connection keys because a relayed input arrives on a peer link that is new after every drop). The relay only routes answers and says what it did not send. The decision about a draft lives in a pure browser model with injected effects, which the console uses unchanged and the integration tests drive over real sockets. No new frame type beyond `input_caps`; the session line is an ordinary `input` frame (spec item 5: no new server path).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes, with invariant floors only. The new refusals (`input-retry-unknown`, `invalid-input-id`) block a terminal write on enumerable, deterministic facts (id unknown on a flagged retry; id not matching the format), declared invariants in the spec (basis irreversible-consequence: terminal input cannot be untyped). No brittle heuristic holds blocking authority: there is no text matching, no timing judgment that blocks (the 8 s mark changes a label only), and the r3 transcript text search was not built.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

Two values are judgment-candidates with floors and an arbiter, as the spec declares: 256 ids per session (floor: an evicted id refuses its retry and cannot cause a second write) and 8 s before "Not confirmed yet" (floor: the label changes no state). Evidence: `inputIdsEvicted`, `inputRetryUnknown`, `inputIdsRepeated` on the new route. Arbiter: Echo at the 2026-11-25 check.

---

## 5. Interactions

- **Existing protocol clients.** Id-less `input`/`key` (legacy dashboard page, iPhone app relay routes, older consoles) take the unchanged path. `input_caps` is an extra frame on subscribe; the legacy page and older consoles ignore unknown frame types (verified: `dashboard/index.html`'s frame switch has no case for it; the console's `onMessage` default is `break`).
- **Fan-out.** Id-carrying `input_ack`/`error` frames from a peer are no longer fanned to every tab; all other peer frames are. Id-less frames keep fanning (older machines' acks), which the console ignores for clearing.
- **Shared seen-id ledger.** A local browser and a peer link writing to the same session share the per-session id space; ids are random 24-character strings, so cross-sender collisions are not a case (spec item 3).
- **Session line.** It is one more `input` into the session; it can interleave with the user's own next message in the pane exactly as two dashboard messages can today.
- **Pending-answer map vs proxy lifecycle.** The proxy drops a session's caps on its last unsubscribe; an answer for a session nobody here watches is filtered by the proxy before it reaches the relay map, so it cannot leak to another tab.

---

## 6. External surfaces

- **Other machines of the agent.** The `/pool-stream` protocol gains `input_caps` (serving → relay) and optional `clientInputId`/`retry` (relay → serving). Mixed versions: a new relay with an old serving machine synthesises `inputAck: 1`; an old relay with a new serving machine forwards `input_caps` to tabs as an unknown frame (ignored by old consoles) and rebuilds input frames without the id, so the serving machine takes the legacy path.
- **Sessions.** A session may receive the fixed `[dashboard]` line; the CLAUDE.md paragraph tells it what the line is and how to answer.
- **Operator surface.** The console's session composer: new sentences (fixed in the spec, FD-15), a draft card above the composer with Send again / Copy / Discard. No new operator action that needs a phone surface; the console is already phone-width.
- **Persistent state.** None. Seen ids and counters are in memory; drafts are browser memory for the page's life.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The composer stays where it was and stays free for a new message; an unresolved message sits directly above it with "Send again" (primary style) first when it is safe.
2. **Zero raw internals as primary content?** Yes. The card shows the person's own text and a plain sentence. The `clientInputId` appears only inside the line typed into the session (the spec requires it there), never on the card.
3. **Destructive actions de-emphasized?** Yes. Discard is a quiet button after Copy, never above the text.
4. **Plain language + phone width?** The sentences are the spec's fixed wording, none asks the person to check anything (unit test asserts no "check"/"look at"). The card wraps text (`overflow-wrap: anywhere`, capped height with scroll) and uses the existing 44px button classes; the live proof at 390x844 and 1280x728 is the spec's dev-agent-live rung.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Seen input ids: machine-local BY DESIGN** (`machine-local-justification: hardware-bound-resource`, as the spec declares). They guard writes into one tmux pane on one machine and live in that server's memory.
- **Cached `input_caps` and pending answers on the relay: machine-local BY DESIGN.** They describe the relay's own live link and its own browser tabs; they are rebuilt by the next subscribe.
- **Drafts:** browser state in one tab, not agent state.
- **User-facing notices:** none emitted by the agent. The session line goes into one session once per draft, from the tab that typed it, so there is no one-voice question.
- **Durable state / URLs:** none.
- **Status surfaces:** `GET /sessions/dashboard-input-status` is this machine's answer only (it says so in the route comment and the awareness paragraph tells the agent to read it on the machine running the session). No pool scope: the counters are per-serving-machine observability for the maturation check.

---

## 8. Rollback cost

Pure code change, no flag (the spec ships 3e live and rolls back by version). Revert and ship a patch: no persistent state, no config, no migration to undo. The CLAUDE.md paragraph added by the migration stays in existing agents' files after a rollback; it is accurate only while the line exists, so a rollback should also remove it (one content-sniffed removal). During a rollback window mixed versions behave as described in §6.

---

## Conclusion

The slice builds §3e items 1 to 7 as written, with two refinements recorded here for the spec owner: (1) the relay synthesises `inputAck: 1` on an older machine's `subscribed` answer rather than on "any other first frame", because a straggling `output` from a previous subscription on a live link could otherwise mark a current machine as older; (2) a first send that certainly typed nothing (refused before any write, unknown session, or never relayed by the relay) puts the text back in the box with its sentence instead of a card, since the spec's controls in item 5 apply to unresolved drafts and these are not unresolved. A `success: false` acknowledgement is NOT in that set (the second pass found `rawInject` can fail after a partial paste): it stays unresolved and the session is asked. Only the spec's fixed sentences are shown; while the session line is in flight the card reads the "could not confirm that either" sentence until the line's own acknowledgement arrives. The review changed four things (below).

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context; read the diff, spec §3e, FD-10, FD-15, the decision points, posture, maturation plan and Left behind)
**Independent read of the artifact:** concern on first read; all four resolved

- **A failed write could be typed twice (real).** `success: false` returned the text to the box as "Not sent", so the person's next send had a new id, but `SessionManager.rawInject` returns false after a possible partial paste. Fixed: `success: false` keeps the draft as an unresolved card (`WORDS.failed`, Copy/Discard) and the session is asked. Test: "a write that failed may have typed part of the text …".
- **Frames could reach the wrong composer (real).** A local and a remote session with the same tmux name shared frames, so a local `input_caps` could give an older machine's composer "Send again". Fixed: a frame with `machineId` goes only to that machine's remote composer; one without goes only to local composers (`sessions.js` `inputFrame`).
- **Pending answers on a dropped link (stated).** Fixed: the relay clears a machine-and-session's pending entries when the proxy reports the link lost or unreachable. Test: "a dropped link clears the pending answers …".
- **A sentence outside FD-15.** Removed: the in-flight wording is gone; only the spec's fixed sentences are shown.

**Re-check (same reviewer, after the fixes): "Concur with the review."** One non-blocking note: for the moment the session line is in flight (normally under a second) the card already reads "I tried to ask … could not confirm that either", the accepted cost of showing only the fixed sentences.

Verified sound by the reviewer: id recorded before the write and repeats answered from the record; unknown flagged retry never typed; nothing without the draft's own id clears it; "Send again" gated on `inputAck: 2`; the session line at most once per draft; caps cleared on every link or subscription change and replayed late; refinement 1; legacy id-less clients unchanged.

---

## Evidence pointers

- Unit: `tests/unit/console-input-model.test.ts`, `tests/unit/WebSocketManager.test.ts` (§3e block), `tests/unit/PeerStreamProxy.test.ts` (§3e block), `tests/unit/console-sessions.test.ts` (composer waits for caps, clears only on its id), `tests/unit/dashboard-input-awareness-migration.test.ts`.
- Integration: `tests/integration/dashboard-input-durability.test.ts`.
- E2E: `tests/e2e/dashboard-input-durability-alive.test.ts`.
- Follow-up commit: the neighbour unit lane's `tests/unit/no-silent-fallbacks.test.ts` counted two new `catch` blocks; both report the failure to the sender (`input_ack success:false`, or `peer-stream-lost`), so they carry the `@silent-fallback-ok` marker with that reason. Comment-only.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable to the defect half. Self-action half: the console's session line is a one-shot notify fired on its own when a draft becomes unresolved. Convergence: the control edge is "draft unresolved → one line"; steady-state bound is one line per draft, ever (the `ask` state moves none → waiting/sent → acked/failed and never back; the line itself is never retried and never followed up); settling brake is that the line is only ever triggered by a person's own send, so with no new sends it fires zero times. Covered by `tests/unit/console-input-model.test.ts` ("the session line is never sent twice", "waits for input_caps … then sent once").
