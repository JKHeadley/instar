# Side-Effects Review — an exact repeat of a signed graph peer request gets the first copy's answer instead of a replay refusal

**Version / slug:** `graph-peer-replay-coalesce`
**Date:** `2026-11-17`
**Author:** `Echo (topic 144007, Accept all round 4)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

On 2026-11-17 14:14-14:20 PT (22:14-22:20Z), Accept all on Justin's live Suggested efforts page (1.3.1879) showed "Saved here. Waiting for Mac M5 Pro to confirm." for about 2.5 minutes per change. It then stopped with "Stopped at 2 of 20: changes are not being confirmed right now."

What the logs show:
- The Studio logged `refused a peer observe/custody request: graph-peer-replayed` and `refused a peer frontier/pin request: graph-bootstrap-peer-replay` every minute or two from 22:06Z.
- The M5 logged, at the matching times, `peer call to m_03b30f5b not passing yet: graph-peer-call-timeout`, then the next address, then `graph-peer-call-status-403`. For example, the M5's 22:08:47.491Z status-403 sits next to the Studio's 22:08:48.695Z `graph-peer-replayed`.
- The M5's registry holds three addresses for the Studio: Tailscale `100.124.55.70:4042`, home network `192.168.87.47:4042`, and the Cloudflare tunnel. All three reach the same Studio server.

Cause: both peer senders, `ConversationGraphReplicationRuntime.request()` (`/replicate`) and `ConversationGraphDefault.peerRaw()` (`/message`), sign ONE packet with one random `requestId` and offer it to each resolved address in turn, with a 5 s timeout per address. On the M5 that is the home-network address (tried first), then Tailscale (always skipped: plain http to a CGNAT host, `url-not-allowed`), then the Cloudflare tunnel.

Why the target was slow: the live Studio's event loop blocks for 8-9 s at a time during Accept all, while burning CPU (`SleepWakeDetector ... event-loop BLOCK`, 22:07:30Z and 22:10:58Z, right at the M5's failures; 15 such lines since 21:00Z). While blocked it reads nothing. The M5's first copy waits in the socket and times out at 5 s; the M5 sends the SAME bytes through the tunnel. After the block the Studio processes copy 1 and records its id, then refuses copy 2 as a replay (403). Copy 1's answer goes to a sender that stopped listening. When the block outlasts both attempts (10 s), both copies time out instead (M5 22:07:25Z and 22:07:30Z). Either way the confirmation is lost.

The old guards also refused with the same "replayed" code when the remembered-id window was merely full (4096 / 1024 entries), so a full window looked like a replay in the log.

Fix (Tier 1):
- New `src/server/GraphPeerReplayGuard.ts`: `run(key, hash, work)` runs the work once per `sender:requestId`. An exact repeat (same canonical packet hash) shares the first copy's outcome, waiting for it if it is still running. It gets the same value or the same refusal. A reused id with different bytes is still refused with the old code. When the window is full it refuses with a new, distinct code (`graph-peer-replay-window-full` / `graph-bootstrap-peer-replay-window-full`). Settled answers are kept within a byte budget (32 MB runtime, 16 MB bootstrap). When an answer is too big to keep, a repeat of it is refused, as before. The guard prunes with a full scan (bounded by the entry cap), so a wall clock that steps back cannot strand expired ids.
- Receivers: the `/replicate` route wraps the existing prepare + execute + response signing in `replays.run(...)` and sends the signed response text it returns. `ConversationGraphDefault.receive()` moves everything after authentication, unchanged, into `answer(packet, local)`; non-derived actions go through `seen.run(...)`, derived transport actions (frames, source-v2 sessions) skip the guard as before; `/message` sends the response text. The guard counts kept bytes from that text (`sizeOf`), so it adds no extra serialization. The response is signed over `canonicalHash(request)`, identical for an exact repeat, so the sender accepts it.
- Senders: unchanged. A sender re-offer (offer the same bytes again to an address that timed out, up to 25 s) was built, reviewed, and then REMOVED before the PR: with it, 3 tests in `tests/integration/graph-default-peers.test.ts` failed (a second owner change stayed `recorded-local`), while plain main passed the same file 12/12. Longer sender waits can hold the sender's own work while the receiver waits on it, so the re-offer is not safe as a transport-only change. It is not needed for the live case: the M5 has two usable Studio addresses (home network + tunnel), so answer-sharing alone covers a freeze up to about 10 s, and the live freezes during Justin's run were 8-9 s.

Not changed: the senders, address order, the 5 s per-address timeout, authentication, signatures, skew checks, the wire format, routes and stored state.

## Decision-point inventory

- Peer receive replay check (both routes): it still refuses a reused id with different bytes, and an exact repeat still never runs the work a second time. What changes is that an exact repeat now gets the first answer instead of a refusal. This is a transport-integrity check, not a judgment gate.

## 1. Over-block

Less over-blocking than before: an honest retry of the same signed bytes through another address is now answered,. A target slower than all of a sender's attempts (about 10 s with two usable addresses) still fails the call, and a request read more than 30 s after it was issued fails the receiver's freshness check (`graph-peer-invalid`); the sender's higher-level retry then sends a fresh request, as before. This fixes a slow target, not a hung one. The blocks themselves are a separate fix (spun off, own topic). Remaining refusals are a reused id with different bytes, a full window (now under its own code), and a repeat whose answer was over the byte budget. Those are the same as, or narrower than, before.

## 2. Under-block

An attacker who captures a signed packet and replays it within the 60 s window gets back the same signed answer the legitimate sender already got. They learn nothing new: the response is signed to the original sender, and the original packet and bytes were already on the wire. The work does not run again. After the window, the issuedAt skew check (30 s) refuses the packet, as before. No new under-block for effects.

## 3. Level-of-abstraction fit

The receiver is the right layer: it is the only place that knows whether the work already ran. Giving each address attempt a fresh requestId on the sender side would make every retry run the work again on a slow target. That gives double execution of observe/custody/owner-intent, exactly what the replay check exists to prevent. Request coalescing keyed on the signed id is the standard idempotency-key pattern. The bootstrap `transition` action already keeps a per-request work table of its own (`transitionWork`) in the same spirit.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. The guard holds no judgment authority. It is a deterministic transport-integrity check (same bytes → same answer; different bytes with a reused id → refused), the same class as signature verification. No brittle heuristic gains blocking power.

## 5. Interactions

- `pending` set / close: the runtime still adds the execute promise to `pending` inside the shared work, so `close()` waits for it the same way. A repeat waits on the same promise and adds no new work.
- `withMutation` serialization: unchanged. A repeat does not enter the mutation queue.
- Refusal logging (`lastRefusedPeerRequest`): a repeat that shares a refusal logs the same `action:code` note, which the dedupe already suppresses.
- `transitionWork` (bootstrap `transition`): unchanged. It still keys on sender + command hash under the guard.
- Derived transport actions skip the guard as before. They have their own per-session ordering.
- Senders unchanged, so callers wait exactly as long as before; no change for asleep or down peers.

## 6. External surfaces

Peers see a 200 with a valid signed answer where they used to see 409/403. The wire format is unchanged. Peers on older versions benefit as soon as the RECEIVER has this fix: the fix is on the receiving side, and old senders already re-send the same bytes. A mixed fleet is safe both ways.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the multi-machine path itself. The guard is per receiving process and in memory, by design: request ids live 60 s, and a restart loses the in-flight work anyway. After a restart, a repeat arriving at the new process runs the work as a fresh request, exactly as before the change. No replicated state, no notices, no URLs.

## 8. Rollback cost

Revert the commit. No stored state, migration or config is involved. A hot-fix release restores the old refusal behavior.

## Evidence

- Unit: `tests/unit/graph-peer-replay-guard.test.ts` (6): an in-flight repeat shares the answer while the work runs once; a settled repeat shares it; a reused id with different bytes is refused; a refusal is shared and not re-run; an over-budget answer makes a repeat refused while distinct ids still work; a full window gets its own code; ids are forgotten after the window.
- Integration: `tests/integration/graph-peer-replay-coalesce.test.ts` (2) runs the real runtime transport against a real peer server listening on TWO real addresses with a 6.5 s handler: the call resolves, both posted bodies are byte-identical, the handler ran once; an exact late repeat over HTTP gets 200 with the same answer and changed bytes are refused (409) without running. On plain main both fail (`graph-peer-unavailable`). `tests/integration/graph-default-peers.test.ts` and `conversation-graph-replication-runtime.test.ts` pass with the change.
- Two-machine throwaway (Studio + M5, `~/.instar/test-deploys/accept-all-2b`, with a temporary named tunnel so the M5 holds the live address shape: home network + Cloudflare): on main the Studio logged `graph-peer-replayed` (observe, custody) and `graph-bootstrap-peer-replay` (pin, frontier) and the page sat on "Your agent is still getting your conversations ready" for 15+ minutes; with this change: zero replay refusals in every run, suggestions back about 75 s after the restart. A full Accept all on the rig did not finish in either build: the rig Studio shares the Studio Mac (load average 35-56) and its event loop froze 17-38 s, past what any transport can cover. Removing those freezes is the spun-off event-loop work (PR 3341 is its first slice).

## Second-pass review

(appended below by the reviewer)

Concur with the review.
- Cause confirmed. `request()` (ConversationGraphReplicationRuntime.ts:711-714) and `peerRaw()` (ConversationGraphDefault.ts:294-295) each sign one packet with one requestId and post the same `canonicalJson` bytes to every endpoint, with `AbortSignal.timeout(5000)` per endpoint. The old receive-side maps refused the second copy.
- The guard runs the work at most once per key (GraphPeerReplayGuard.ts:57-77). An entry is never replaced, only pruned. The accounting callback checks `entries.get(key)!==entry`, so an entry pruned while still running leaks no bytes. Both the caller and the `.then(_, noop)` handle the rejection, so nothing goes unhandled. A reuse with different bytes needs a second valid member signature and is still refused (line 61).
- An entry can age out while it is still running, but its repeat would then fail the issuedAt skew check, because the window is exactly 2x skew (runtime `MAX_SKEW*2`, bootstrap 60 s against 30 s). The only gap is the 1 ms boundary: prune drops entries with `at<=cutoff` (line 87), where the old code dropped only `>`. Nit.
- `answer()` (ConversationGraphDefault.ts:337) uses only `packet` and `local`. `tsc --noEmit` passes, so it reads no `member` or `roster` from receive() scope. The `native`/`closed` check is repeated there and is harmless. Derived transport skips the guard as before (line 333-335).
- Runtime route (ConversationGraphReplicationRuntime.ts:168-169): prepareNativeTailClosure, `pending` and withMutation now sit inside the shared work, in the same order as before. A failure in prepare used to consume the id. Now it is cached and shared, which is the same effect.
- Security: /replicate stays behind the bearer token. On the token-less /message route, someone who captures a request could always race it to another address and win the first answer. Sharing the cached answer with a repeat adds nothing beyond that.
- Not concerns, but worth knowing: (a) if the target takes longer than the sender's remaining per-address timeouts, every copy still times out, so this fixes a slow target but not one that hangs. The artifact's "is now answered" should say "when it finishes within the remaining attempts". (b) prune stops at the first entry that has not expired (line 86) and relies on insertion order matching `at`. If the wall clock steps backward, stale entries can linger and count toward maxEntries for a while. The old code scanned every entry. (c) The integration test covers only `/replicate`. `/message` coalescing is covered only by the guard unit test.

Second pass (sender re-offer + response text):

Concern raised: "a down or asleep machine fails fast and costs no extra wait" is not true for a host that silently drops packets, so the artifact overstates the limit and the re-offer adds up to ~20 s per call in that case.
- The re-offer keys on `error.name==='TimeoutError'` (ConversationGraphReplicationRuntime.ts:728, ConversationGraphDefault.ts:301). `AbortSignal.timeout(5000)` fires before undici's 10 s connect timeout, so a TCP connect that HANGS also ends as TimeoutError, not a fast TypeError. That happens for a sleeping Mac whose ARP entry is still cached (macOS keeps it ~20 min), a firewall that drops instead of rejecting, an offline Tailscale peer on an https address, or a hung server process. Each of those addresses is re-offered until 25 s, so one peer call to such a machine takes ~25 s instead of 5 s per address. ECONNREFUSED, EHOSTUNREACH, a tunnel 502/530 and any non-ok status are fast and are NOT re-offered (lines 299/723 `continue` without pushing to `timedOut`). That part is correct, and test 3 covers ECONNREFUSED only. Fix: reword Summary "Senders" and section 5 "Callers inside serialized sections" to "a machine that refuses or is unreachable fails fast; one that silently drops packets, or a hung server, is waited on for up to 25 s per call". Optionally, a test with a black-holed address. No code change needed if 25 s per call is acceptable to the callers (discoverPublication runs peers in parallel; source-v2-status polling at ConversationGraphDefault.ts:276 just retries).
- Loop termination is sound. Round 0 always uses 5 s. Later rounds use `min(8000, deadline-now)`. `break` when `wait<500` implies `now>deadline-500`, so the next `candidates` is `[]` (ConversationGraphDefault.ts:302, runtime:729). Every re-offered attempt takes at least 500 ms, and `continue`'d or skipped addresses never enter `timedOut`. Re-offers start before 24.5 s and end by 25 s, inside the receiver's 30 s skew window (ConversationGraphDefault.ts:331, MAX_SKEW=30000 runtime:70) with about 5 s of clock-difference margin. Only round 0 is unbounded: 6 or more addresses at 5 s each could pass 30 s. That was true before this change too.
- A body read that times out raises the same DOMException TimeoutError from `reader.read()`, so it is re-offered. That is correct: the receiver has the answer cached and returns it fast. In peerRaw, `receivedOK` makes `refusal='response-unverified'` sticky across rounds. A later success still returns, so `refusal` only changes which error is thrown on final failure. No other error inside the try is named TimeoutError, so nothing else is misclassified.
- Mixed fleet, minor: an OLD /message receiver answers the re-offer with 403, and peerRaw maps that to `authorization-refused` (ConversationGraphDefault.ts:299). With a single timed-out address, discoverPublication then sets `peerRefusedJoin` (line 207, `awaitingJoin` wording) where it used to report "unavailable". Section 5's "exactly today's outcome" holds only for targets with more than one address. It is transient and only shows up while the fleet is mixed.
- Response text is fine. `answer()` returns the signed object. `JSON.stringify` matches `res.json` defaults, and `res.type('application/json').send(string)` sends the same bytes with `charset=utf-8` (ConversationGraphDefault.ts:77, runtime:168-173). Both senders read raw bytes and `JSON.parse` them. `receive()` is private and its only caller is the /message route. `sizeOf` counts UTF-16 code units, not bytes. Responses are mostly ASCII/base64, so the budget is approximate but bounded. `tsc --noEmit` passes.
- Coverage gap: the re-offer tests cover only `request()` (/replicate). `peerRaw()`'s re-offer and its `refusal` bookkeeping are untested.

Author response to the second pass (sender re-offer): the concern is fixed in code, not only in wording. Before re-offering, the sender now checks that the timed-out address still accepts a TCP connection within 1 s (`peerAddressAccepts`); a packet-dropping or asleep host fails that check and is not waited on again. The loop is one shared function (`offerSignedRequest`) used by both `request()` and `peerRaw()`, so the reviewer's coverage gap for `peerRaw` is closed by the unit tests on that function. The old-receiver 403 caveat is now stated in section 5. New tests: offerSignedRequest unit cases, peerAddressAccepts, integration (3b) black-holed address under 9 s.

Second pass, round 2:

Concur with the review. The asleep and black-hole concern is resolved in code.
- `offerSignedRequest` (GraphPeerReplayGuard.ts:130-167) keeps the old loop's shape. The first round waits 5 s per address. Later rounds wait `min(8000, deadline-now)`, with `break` below 500 ms and a stop once now is 500 ms or less from the 25 s deadline, so the loop still always ends inside the 30 s skew window. The unit test asserts waits of [5000,8000,8000,4000] adding up to exactly 25 s. Only timed-out addresses that pass `peerAddressAccepts` after round 0 are offered again (line 158-161). A hung server still accepts and is still waited on, as section 5 now says.
- peerRaw conversion (ConversationGraphDefault.ts:299-303): every former `continue` is now `return {ok:false}` with the same side effects. The URL-not-allowed branch sets `refusal`, the credentials-in-URL branch is a silent skip, and the 503 boot-state `starting` branch notes the step without setting `refusal`. The other non-ok branch sets authorization-refused or response-unverified, and a missing reader sets response-unverified. The catch block still notes the step and sets `refusal` when `receivedOK`, then rethrows, so a TimeoutError is still the only thing that marks an address. `refusal` is written inside the closure and drives the final throw at line 303. tsc narrows `let refusal=null` across the closure, but it compiles and the runtime behaviour is correct. request() (ConversationGraphReplicationRuntime.ts:718-731) converts the same way, ending in `graph-peer-unavailable`.
- The `peerAddressAccepts` probe (GraphPeerReplayGuard.ts:106-118) destroys its socket and settles exactly once. Calling `destroy()` with no argument emits no late error, so `removeAllListeners` is safe. A Cloudflare tunnel address always passes the probe, but an asleep origin behind the tunnel answers 502/530 fast, so it never times out and is never re-offered. A busy origin behind the tunnel does time out and is re-offered, which is the intended case.
- Remaining gap, not a blocker: `peerRaw()`'s re-offer and its `refusal` bookkeeping are still covered only through the shared `offerSignedRequest` unit cases. The integration file still exercises `request()` only.

Author note after round 2: the sender re-offer (and its connection check) was removed before the PR, because `graph-default-peers.test.ts` failed 3 of 12 with it while plain main passed 12 of 12. The PR ships the receiver-side guard and the response-text change only, both of which the first and second passes concurred with. Senders are byte-for-byte main.
