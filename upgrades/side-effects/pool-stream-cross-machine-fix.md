# Side-Effects Review — Pool Dashboard Streaming: cross-machine history relay + closed-proxy recovery

**Version / slug:** `pool-stream-cross-machine-fix`
**Date:** `2026-06-11`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required` (no block/allow surface on messaging/dispatch, no session lifecycle, no sentinel/gate/watchdog logic — see Phase-5 assessment in Conclusion)

## Summary of the change

Fixes the two live bugs found during 2026-06-08 live testing of Pool Dashboard Streaming (POOL-DASHBOARD-STREAM-SPEC, converged-approved 2026-06-06), which left a remote (Mac Mini) session tile connecting but rendering a blank terminal, with no recovery until server restart:

1. **Closed-proxy eviction** (`src/server/WebSocketManager.ts` → `peerProxyFor`): a `PeerStreamProxy` that reached `closed` (idle-grace close after the last viewer left, or `machine-unreachable` after the bounded reconnect failed) stayed cached in `peerProxies` forever. A closed proxy ignores every further subscribe by design, while the subscribe handler still answered `subscribed` — so one upstream hiccup (or 60s of nobody watching) made that peer permanently unstreamable, silently. `peerProxyFor` now evicts a closed proxy and creates a fresh one; a fresh user-initiated subscribe is a fresh episode with its own bounded reconnect budget (P19 preserved).
2. **Cross-machine history relay** (`src/server/WebSocketManager.ts` `history` case, `src/server/PeerStreamProxy.ts` `relayFrame`, `dashboard/index.html` `loadMoreHistory`): the scrollback fetch (`{type:'history'}`) had no remote branch — it always called local `captureOutput`, which can only return empty for a session owned by another machine (spec §2.2: capture happens ONLY on the owning machine). The handler now relays history upstream for a remote-subscribed session exactly like input/key, the proxy gained a read-only `relayFrame` (relayInput delegates to it), and the dashboard client sends `machineId` on history requests for remote sessions.
3. **Relayable history miss** (same `history` case): the local "no output" reply was `{type:'error', message}` with NO session field — the peer fan-out drops sessionless frames, so the error could never travel. It now carries `session` + `code:'session-not-found'`, which the dashboard already renders honestly (§2.4).

Files: `src/server/WebSocketManager.ts`, `src/server/PeerStreamProxy.ts`, `dashboard/index.html`, `tests/unit/WebSocketManager.test.ts`, `tests/unit/PeerStreamProxy.test.ts`.

## Decision-point inventory

- `WebSocketManager.peerProxyFor` — modify — get-or-create now evicts a `closed` proxy; routing decision (which proxy serves a peer), not a block/allow decision.
- `WebSocketManager.handleMessage 'history'` — modify — adds the remote-routing branch (same shape as the existing `input`/`key` remote branches); read-only data fetch, no authority.
- `PeerStreamProxy.relayFrame` — add — forwards a read-only frame while the link is active; drops otherwise (same drop semantics relayInput always had).
- `gateWrite` (remote input authority, `poolStreamAllowRemoteInput`) — **pass-through, untouched** — history is read-only and never reaches `gateWrite`; the input default-off security gate is not modified by this change.
- Stream ticket auth (`StreamTicketStore`, `/pool-stream` upgrade) — **pass-through, untouched**.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No issue identified. The change adds no new rejection. The history remote branch only triggers when the client explicitly sent a `machineId` AND that client already holds a live remote subscription for exactly that `(machine, session)` pair (`client.remoteSubs.has(...)`) — a history request for a never-subscribed remote session falls through to the local path and answers `session-not-found`, which is the honest answer (you cannot scroll back a session you are not watching). Local history requests (no machineId) are byte-for-byte unchanged.

---

## 2. Under-block

**What failure modes does this still miss?**

- A history request relayed while the upstream is `connecting` (mid-reconnect) is dropped, not queued — the user's infinite-scroll simply doesn't load that batch and re-fires on the next scroll (the client re-requests on scroll position). Stale queued requests racing a reconnect would be worse. Accepted, documented in `relayFrame`'s contract.
- The history reply fans to EVERY local client subscribed to that (machine, session), not just the requester — same multiplexing behavior the spec defines for all frames (§2.2 "frames relay 1:1"); clients gate rendering on `activeSession`, so a non-requesting viewer at most refreshes its scrollback.
- The 2026-06-07 mint-timeout failure class (wedged ticket mint) is already handled by the explicit 10s timeout shipped in #970, upstream of this change.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The history relay is placed at exactly the layer the spec assigned it: the SUBSCRIBE-side routing chokepoint in `WebSocketManager.handleMessage`, parallel to the existing `input`/`key` remote branches — not a new parallel path. `relayFrame` lives in `PeerStreamProxy` because that class owns "is the upstream link usable" state; the manager owns "is this session remote for this client" state. The eviction lives in `peerProxyFor` (the single get-or-create chokepoint) rather than inside the proxy (e.g. a self-reopening proxy), keeping the proxy's one-shot bounded-reconnect state machine — and its P19 guarantee — untouched.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The change is pure data-plane plumbing (routing read-only frames to the machine that owns the data, and replacing a dead connection object). The ONLY authority in this subsystem — the serving machine's `poolStreamAllowRemoteInput` gate on remote keystrokes — is not touched, weakened, or bypassed: history never reaches `gateWrite` because it is a read, and reads were already permitted to any authenticated peer link (the initial subscribe capture has always shipped full screen content to the peer). No new information becomes visible to any principal that could not already see it.

---

## 5. Interactions

- **Shadowing:** the remote history branch runs BEFORE the local capture path, gated on `client.remoteSubs` — the local path is unreachable only for sessions the client explicitly subscribed remotely, which is exactly the set local capture could never serve (it returned null for them). Nothing that previously worked is shadowed.
- **Double-fire:** none — a history request takes exactly one branch (remote XOR local). Eviction cannot double-open: `peerProxyFor` is synchronous, and only a `closed` proxy (no live transport, no pending timers except a fired/cleared one) is evicted, so no second live upstream to the same peer can exist.
- **Races:** a client disconnect between failAll and re-subscribe calls `dropRemoteSubsForClient`, which looks up the CURRENT map entry — if eviction already replaced the proxy, the unsubscribe lands on the fresh proxy where `unsubscribe()` of an unknown clientId is a documented no-op. An old evicted proxy holds no timers and no transport (failAll/idle-close tear both down), so it is plain garbage, not a leak.
- **Feedback loops:** none — the eviction does not auto-reconnect; it only acts on the next explicit user subscribe, so a permanently-down peer costs one bounded reconnect cycle per user click, never a storm.

---

## 6. External surfaces

- **Other machines:** the serving side of the protocol is UNCHANGED — an updated laptop streaming from a not-yet-updated Mini works (the Mini's serving side always answered history requests arriving on a peer link; the bug was the laptop never sending them). Mixed-version fleets degrade to exactly today's behavior at worst.
- **Protocol:** no new frame types; `history` was already in the documented protocol and in `UpstreamTransport.send`'s doc comment ("subscribe/unsubscribe/input/key/history"). The local history-miss error gains `code` + `session` fields (additive; the dashboard's existing `error` handler renders `code`-carrying frames and still `console.error`s unknown shapes).
- **Persistent state:** none touched. No config, no migrations, no ledgers.
- **Timing:** `relayFrame` depends on the upstream being `active` — bounded, observable via the existing `[pool-stream-connector]` log lines.

---

## 7. Rollback cost

Pure code change in three files with no persistent state: revert the commit, ship as the next patch. During a rollback window the symptom is exactly the pre-fix behavior (blank remote scrollback, no post-hiccup recovery) — degraded, not destructive. No data migration, no agent state repair, no template/hook migration (dashboard/index.html ships in the npm package and replaces wholesale on update).

---

## Conclusion

Review produced one design adjustment: the local history-miss error was originally left sessionless; the relay analysis (§5 fan-out drops sessionless frames) surfaced that it could never travel cross-machine, so it now carries `session` + `code` — that is also what makes the dashboard render it honestly instead of burying it in the console. Phase-5 second-pass assessment: the change touches none of the listed high-risk surfaces (no outbound/inbound messaging block decisions, no session spawn/restart/kill/recovery, no compaction, no coherence gates/idempotency/trust, no sentinel/guard/gate/watchdog logic — the one gate in this subsystem, remote-input default-off, is untouched pass-through), so a dedicated reviewer subagent is not required; the artifact stands on the three-tier test evidence. Clear to ship.

**Phase 1 principle check (recorded):** the change involves no new decision point that gates information flow or constrains behavior — it repairs the data plane of an approved feature to match its converged spec (§2.2 capture-on-owner, §2.4 failure honesty, P19 bounded reconnect). Signal-vs-authority applies as a constraint check only: confirmed no brittle logic gained blocking authority.

**Phase 2 plan (recorded):** built in a FRESH worktree `.worktrees/fix-pool-stream-cross-machine` off `JKHeadley/main` @ `60c4e3a3c` (v1.3.484), canonical remote verified (`JKHeadley → github.com/JKHeadley/instar.git`), per-worktree identity `Instar Agent (echo) <echo@instar.local>`. Acceptance criteria: (a) new unit tests fail on unfixed code for the stated reasons — verified (5 failures: missing relayFrame ×2, ignored re-subscribe ×2 → silent blank, sessionless error ×1); (b) all green with fix; (c) full suite green; (d) live verify on the real laptop+Mini after deploy. Rollback: revert commit (see §7).
