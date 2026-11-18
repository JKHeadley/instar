# Round 4: decision-completeness + lessons-aware review of draft 4

Spec: `docs/specs/windows-one-file-extender.md` (draft 4, head `88e4e8291`). Read only. I read the spec, both reviewer templates, `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (P2, P8, P17-P24 and Part 2), the registry articles named below, `docs/specs/mac-qr-pairing.md` §5 and its multi-machine posture, `site/src/pages/api/pair-drop/[id].ts`, `src/users/MemoryPrivacy.ts:441-452`, `src/users/MemoryAudience.ts:239-241`, `src/core/SessionManager.ts:8490-8521`, and the session-input routes (`src/server/routes.ts:13067`, `src/server/mobileSessionTerminalRoutes.ts:442`). There are no `.instar/memory/feedback_*.md` files on this agent.

## Round-3 findings: did draft 4 resolve them?

Decision completeness, round 3 (4 DESIGN):
1. The done line is a side-loaded unsigned build against the throwaway and Echo, with signing, the public link and SmartScreen moved to a release gate after approval. **Resolved** (Maturation plan; Live tests).
2. Android was dropped from done and is tracked by the Android lane. **Resolved** (Surfaces; Frontloaded Decisions).
3. Parking on a long outage. **Resolved differently**: a 7-day breaker now drops attempts to hourly, never gives up on its own, and shows the tray state. This meets P19's brakes and the Eternal Sentinel's "escalates once" condition.
4. Remote-control detection is now a warning and not a block. **Resolved**.
- Precision: the Disk Steward is the file-size arbiter (resolved). The 8 s wait is a decision row (resolved). The manifest address is named (resolved). The load numbers are now a PC-reported window plus one reserved slot (resolved). **Still open**: the remote-control program list has no stated contents or source. "Completed one `computerExtenders` sync" replaced round 3's "current", and it is still not defined (see P-4).

Lessons-aware, round 3 (5 DESIGN):
1. Caller carrier: a new server-issued owner-interactive token kind is specified. **Partly resolved.** One layer down, the token does not separate a job from an owner session on the same OS user (D-3).
2. Remote-control list as a signal. **Resolved**.
3. App required versus *The Person Decides*. **Resolved as process**: the exception is named and routed to Justin's approval ask, with the reason grounded (see "Constitution flags" below). One precision item is left (P-6).
4. Raise from the phone alone. **Resolved** (the app raise is phone-only and the PC verifies the presence signature).
5. Parking. **Resolved** (see 3 above).
- Precision: the reason for excluding teams and the follow-up owner are stated (resolved). The Android owner is named (resolved).

## Constitution flags from the live gate (engaged)

**The Person Decides (app mandatory).** I checked the reason against the source. Today, an operator session or a Telegram button proves the conversation, not a person. The app's presence signature is the only human-presence proof the agent cannot produce itself. No dashboard WebAuthn approval exists. The cost is real: admission gives command over a person's computer. *Mobile-Complete Operator Actions* is met, because every owner action is on the phone. The article says "neither is required", so this is a true exception. The spec routes it the right way, to Justin's ratification in the approval ask, and does not quietly reinterpret the article. That is acceptable. What remains is in P-6.

**Always a Multi-Machine Entity (home binding).** State is unified: `computerExtenders` and `computerAudit` replicate, and every machine knows the home machine and forwards to it. Amendment 1 (single-machine survivability) conserves information, not resources. A PC that only one machine's key can drive is a resource, so losing it while the home machine is down is a resource loss, not an information loss. That passes. The declared justification, `physical-credential-locality`, is true but it is not the real reason. A pinned key *set*, with phone-countersigned additions, would also be "keys the agent cannot add to on its own". The actual reason the failover is not automatic is that moving the PC grants command of it to a different key. That is the irreversible-consequence class, which needs the person. The owner-signed move is the right remedy. The gap is that nothing drives the person to the move (D-4). Wording fix: P-5.

## DESIGN findings

### D-1: Decision rows contradict draft 4's own additions (move, phone orders)
- Section: Decision points touched; Tests (Integration).
- Problem: "Whether a PC removes itself" says *only* a revocation row signed by the pinned home key triggers removal. Draft 4 added a phone-signed Remove on the orders slot that "runs the remover", and the person can Disconnect or uninstall from the PC. "Which machine holds a PC" says "the home machine that minted its code". After a move, the home machine is not the minting machine. The Integration test repeats "it removes itself only on the signed row". A builder who writes tests from the invariant rows would refuse the phone-order path and pin the wrong home machine after a move.
- Fix: removal triggers become (a) a revocation row signed by the current pinned home key, (b) a Remove order signed by the pinned phone presence key, and (c) the person's own Disconnect or uninstall on the PC. The holder becomes "exactly one: the current home machine (the minting machine, or the latest phone-signed move with the highest `moveSeq`)". Align the Integration test wording with both.

### D-2: The beacon and orders slots on the drop can be occupied by whoever knows `d`, including the agent itself, so the "about two minutes" claim has nothing that carries it
- Section: Address beacon; Owner orders that do not depend on the home machine; foundation `pair-drop/[id].ts`.
- Source: in the drop, the first writer wins (`if (await store.get(...)) return 409`). Storage is best-effort Runtime Cache, which is non-durable, per region, and can evict before the TTL (mac-qr-pairing §5). The slot names are derived from `d` and the window. `d` is the PC's public key. It is shown in the QR on the PC's screen, and the home machine and every agent session that can read `computerExtenders` hold it.
- Problem: the orders path exists to act against a home side that keeps a PC working against the owner's order. The agent on that side can compute every future orders slot and occupy each one with junk at one write per 2 minutes, which is far under the 60-a-minute firewall limit. The owner's Remove would then never reach the PC. The same applies to the beacon: "delay reconnection by a window" is understated, because squatting can delay it in every window. Eviction alone also breaks the bound without any attacker.
- Fix:
  - Name the orders slot from a secret only the phone and the PC hold. It can be set in the sealed hand-off: the phone generates it and seals it to `k`, so the home machine never sees it. The beacon slot is named from a PC/home secret.
  - The phone itself re-publishes each window. A machine re-publishes only when the phone handed it that slot.
  - Restate the bound as "usually within about two minutes; best effort; the tray Stop is the guaranteed path".
  - Add an integration test where a squatter holds the computed slot.

### D-3: "Jobs refused" for `/computers` does not hold one layer down: same-user sessions can read or drive an owner session
- Section: Who may call; Decision row "Who may call /computers — invariant; irreversible-consequence".
- Source: session tokens reach a session as `INSTAR_AUTH_TOKEN` through `tmux -e` (`SessionManager.ts:8521`). Any process of the same OS user can read that through tmux or the process environment. Every job keeps the full bearer token, and the bearer authorizes `POST /sessions/:name/input` (`routes.ts:13067`). A job that has read a hostile email can therefore type that text into the owner's interactive session, or read that session's token. The stated guarantee ("a hostile email read by a job cannot become a command on the PC") is a claim with nothing in the code that carries it.
- Fix, either of two:
  - (a) Downgrade the row to what holds, a label against accidental use. Add "content another session types into your conversation" to the residual risk in the consent text.
  - (b) Make it hold. Refuse bearer-originated `/sessions/:name/input` into a session that holds a computers token. Pass the token by a channel other sessions cannot read, or run jobs inside the existing memory-privacy sandbox.

  Also frontload whether the owner session's `INSTAR_AUTH_TOKEN` is *replaced* by the new token or the token is *added* in a separate variable. A replacement would cut owner sessions off from every bearer route, and a builder would have to stop and ask.

### D-4: When the home machine is offline, the agent's behaviour and the choice of home machine are not decided
- Section: Pairing hand-off ("the machine it is talking to ... becomes the home machine"); Moving a PC; Agent side (`home-offline`).
- Problem: the home machine is whatever machine the phone happens to be talking to. That may be a laptop that sleeps, while an always-on machine (the lease holder) exists. When a call gets `home-offline`, the spec does not say what the agent does. The only path forward is a "Move" item the person must find on the app's PC page. *Self-Heal Before Notify* allows this ask, because the agent cannot heal it without the person. But *Operator handoff* and *The Person Decides* require the agent to bring the one-tap action to the person. A builder would stop to ask both questions.
- Fix: frontload two decisions.
  - (1) The phone mints on the machine that the pool marks always-on or lease-holding and that has a reachable address. The phone shows which machine that is, and the person can pick another.
  - (2) On `home-offline` for an owner-conversation call, the agent sends one message in that conversation with a prefilled "Move <PC> to <machine>" approval link. It sends this once per outage and does not repeat it while the outage lasts.

  Add a decision row for the "not seen for an hour" threshold.

### D-5: Re-publish loops on the home side have no breaker (P19)
- Section: Address beacon; Owner orders.
- Problem: the home machine publishes a beacon record every window for as long as a PC is not connected. Consider a PC that was uninstalled while offline: its best-effort "leaving" message was lost, so the home machine publishes forever, one paid write every 2 minutes. An order's receiving machine re-publishes "until the home machine's confirming row replicates back". If the home machine is retired and never returns, that loop never ends either. The PC side has a breaker; the home side has none.
- Fix: put P19 brakes on the home side. Beacon publishing follows the same 7-day/hourly breaker as the PC. An order re-publish stops when a move, a confirming row or a revocation lands, or after the breaker. Add a sustained-failure test with a permanently absent PC.

### D-6: Two decisions not taken in the spec: the fleet bill on Justin's Vercel plan, and widening an operator-approved exception
- Section: Address beacon "Cost"; Owner orders "Cost"; Frontloaded Decisions.
- Source: mac-qr-pairing §5. Justin approved the drop as an exception to decentralized-by-default, for pairing only: "dumb, short-lived, optional ... holds nothing for more than a minute or two". It is billed per read and write on the existing Vercel Pro plan.
- Problem: draft 4 turns the drop into a standing control channel. Every connected PC reads once a minute, forever, and every disconnected PC is written once every 2 minutes. The orders path also makes the drop load-bearing for a safety property, not optional delivery. This is money on Justin's account that scales with the fleet: at the §5 price band, 10,000 connected PCs is about 430 M reads a month, roughly US$170-280 a month. It also widens the scope of an exception he ratified. Neither is in the Frontloaded Decisions or the four-part ask. Money and operator-ratified exceptions are never cheap to change after the run.
- Fix: add a Frontloaded Decisions entry that states the per-PC and the fleet-scale cost, and states the widened drop scope (standing beacon and orders, not only pairing). Add both as named items in Justin's approval ask, next to the app exception and the signing request.

## PRECISION findings
- **P-1 (P24): which part of an oversized result is kept.** Command output keeps its "first part". The evidence for a command (the error, the exit summary) is usually at the end. Default to head and tail for stdout and tail for stderr, or justify keeping the head. The overflow is disclosed in-band and fetchable, so nothing is cut silently.
- **P-2: name clipping in the scam warning.** Agent, owner and PC names are clipped to 40 characters, and the person's Connect decision reads those names. Show the cut with an ellipsis, as P24 requires disclosure.
- **P-3: fixed values with no decision row.** These are missing from Decision points: the 60 s orders poll, which sets the "two minutes" bound; the "not seen for an hour" Move prompt; the 15 s sign-in notice; and the contents and source of the remote-control list, which is a signal and cheap to change.
- **P-4: the restart sync is undefined, with a hole.** "Completed one `computerExtenders` sync" needs a definition, for example "reached the lease holder's replication high-water mark". The "or is the lease holder" short-circuit also has a hole. If the restarted home machine takes the lease, it admits the PC without seeing a pending-revocation row that another machine wrote while it was down. App revocations are covered by the phone orders; console revocations are not. Require a sync with every reachable peer within a bounded wait, or route console Remove through the phone orders too.
- **P-5: the machine-local justification gives the wrong reason.** Restate it as: the live socket has one endpoint at a time, and failover to another key grants command of a person's computer, so it needs the owner's move (irreversible-consequence). `physical-credential-locality` is a consequence of that choice, not the reason for it.
- **P-6: the app exception is not recorded where tooling can see it.** Put it in frontmatter (for example `constitution-exceptions: [The Person Decides — app required for PC admission]`) so the approval artifact records Justin's yes or no. Also name the four parts of the "one four-part request": only two (the Azure subscription and the ID check) are listed.
- **P-7: no measurement of the person's journey.** The graduation step, "the model review reads it ready", has no data on whether people reach their goal. Record the steps of the pairing funnel (link opened, QR shown, redeemed, approved, first call) and where people abandon (Cancel at the warning, SmartScreen), so the 8 s and 30 s waits and the journey can be judged.
- **P-8: quick-tunnel limits not checked.** The default fleet address is a quick tunnel. Check and state Cloudflare's published limits for quick tunnels: it is a testing product with no uptime promise, and it limits concurrent requests. Confirm that a long-lived WebSocket is within those terms. This is unverified here.

## Fixed-limit contest

| Limit | Claimed basis | Evidence / counterexample | Verdict |
|---|---|---|---|
| Connect wait, 8 s / 30 s | judgment-candidate. Floor: never instant, warning always shown. Arbiter: the person (Cancel). | The arbiter cannot shorten the wait, so it acts as a floor. Counterexample: an owner connecting their own PC loses 8 s, a small cost. The planned review data (timings from live proofs) cannot measure scam interruption. | Cleared as an advisory default (P-7 for evidence). |
| Typing idle wait, 30 s | judgment. Floor: never over a full-screen app. Arbiter: the person's sub-option. | Courtesy, not containment. The person can lift it. | Cleared |
| Command time, 2 min | judgment. Arbiter: the calling session. Floor: Stop and the Job Object. | No ceiling, so it rejects no legitimate long command. | Cleared |
| Inline result, 1 MB | judgment. Arbiter: the caller. Floor: nothing is cut. | The overflow ticket is disclosed in-band. The end kept is wrong (P-1). | Cleared, with P-1 |
| Chunk and frame size, 256 KB | protocol constant | Resume by offset. It does not limit how much is moved, so no counterexample. | Not a behaviour cap |
| Drop window, 120 s | external-constraint | `SLOT_TTL_SECONDS = 120` in code, and an operator-approved invariant of §5. | Valid |
| Orders poll, 60 s | none stated | Sets the owner's out-of-band revocation latency, and has a cost (D-6). Counterexample: a PC under active misuse, but the socket path is immediate while the home machine is reachable. | Needs a row (P-3) |
| Breaker at 7 days, then hourly | judgment with floor and arbiter, reviewed with disconnect data | Satisfies P19 and the Eternal Sentinel conditions on the PC side. The home side has no breaker (D-5). | Cleared (PC side) |
| Sign-in notice, 15 s | none | A UX constant. It is not a limit on what the agent may do. | Advisory, P-3 |
| Audit page, 100 rows | none | A paged cursor. It does not cap the data. | Not a cap |
| Name clip, 40 characters | derived from the 2,048 cap (about 1,100 characters at most) | Arithmetic shown. Display truncation needs disclosure (P-2). | Valid, with P-2 |
| Sealed blob, 2,048 characters | external-constraint | `MAX_BLOB_CHARS = 2048` in code. The phone refuses an oversized seal and does not truncate. | Valid |
| Device signature window, 60 s | existing scheme | `MobileDeviceKeys.ts:16-17`, reused. | Valid |
| Backoff 1 s to 5 min, heartbeat 30 s with 2 missed pongs, one quick-call slot | protocol and liveness floors | Standard protocol floors. No legitimate case is rejected. | Cleared |
| "Not seen for an hour" Move prompt | none | Only decides what the app shows first. | Needs a row (P-3, D-4) |

No contested limit is a circular invariant. None is rejected.

## Decision points and Maturation plan format (task e)
- Every invariant row carries `basis` and `evidence`. Two rows have evidence that the draft-4 text contradicts (D-1). One row's evidence has no carrier (D-3).
- Every judgment-candidate row has a floor and an arbiter. "How many calls run at once" has no default, but the PC-reported window is the arbiter, which is acceptable. Missing rows: P-3.
- The Maturation plan has test-agent-live, dev-agent-live, fleet, a graduation criterion, a ladder and a dark window with an owner. The format is complete. The graduation step depends on Justin's third machine and on the paid signing request. Both are tracked as commitments or asks, which is acceptable.

## Decision completeness
- `## Open questions` is present and empty. The two items that genuinely need Justin's yes or no (the app exception, and signing with its cost) are correctly placed at the approval boundary, before the run. D-6 adds two more items for that same boundary.
- Cross-boundary work: the app lane has a contract file, a commitment and a build number on the completion list, so it has a route. Android, team sharing, the same-network address and relay addresses are each tracked as items on the easy-setup project with named owners, and none is in the done line. Acceptable.
- The remaining stop-and-ask points are D-3 (whether the token replaces or is added), D-4 (where the home machine goes, and what the agent does when it is offline) and D-6 (the money and the widened exception).
- Cheap-to-change-after: the spec writes no explicit cheap tags. Six judgment defaults are de facto cheap behind the dark window: 8 s/30 s, 30 s idle, 2 min, 1 MB, 7 days, and the remote-control list. Each was contested against the non-cheap taxonomy, and none touches money, identity, a published interface or a lasting external effect. All six are cleared.

## Experience fit
- Goal: Justin, message 4609198818115544. "a single file that can be run on a Windows machine that gives an agent access", as the way other than the Instar app.
- Ordinary journey: link, run, pick a mode, scan in the phone app, an 8 s wait, Connect, Face ID. Steps outside it: a person without the iPhone app installs and pairs it first. A new publisher sees SmartScreen's first-run warning; the page explains it, and it is a personal step.
- Verdict: this delivers the outcome. The file is one file and holds no secret, nothing needs an administrator, and every owner decision is a phone tap.
- Contrasting cases. The same PC with the home machine asleep: today the person must discover "Move" on their own (D-4). The same request worded differently ("look at my screen" or "take a screenshot"): one grant covers both, with no repeat ask. A different consequence (raise to Full control): it asks again with Face ID, which is correct. An audience change (a job instead of a conversation): it is refused only nominally (D-3).
- Trust article: the approval is per PC and per mode, and the person chose the mode. Coverage matches the record. No needless repeat asks were found. How many times people are asked, and where they drop off, is **unmeasured** (P-7).

design: 6, precision: 8; frontloaded 13, cheap 6, contested-cleared 6
