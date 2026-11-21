---
title: "The owner record on every machine: stored, bootstrapped at Basic, and kept in step over the mesh"
slug: identity-security-piece2b-owner-record-store
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece2b-owner-record-store.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "An Instar Agent Is Always a Multi-Machine Entity; Verify the State, Not Its Symbol; Bounded Blast Radius"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §12 item 2, decision 17, line 129 (everEnrolled); owner-authentication.md §6. The minimum-build fence (lines 360, 456) is piece 2c."
depends-on: "identity-security-piece2a-owner-record-chain (the evaluator)"
lessons-engaged: "a-dark-guard-is-worse-than-no-guard, verify-the-state-not-its-symbol, fix-the-class-not-the-instance"
review-convergence: "2026-11-18T16:31:00Z"
review-iterations: 7
review-completed-at: "2026-11-18T16:31:00Z"
review-report: "reports/identity-security-piece2b-owner-record-store-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) round 1"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\"), §12 item 2, and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# The owner record on every machine: stored, bootstrapped at Basic, and kept in step over the mesh

## Problem statement

Piece 2a defines the owner record and the one function that evaluates it. Piece 2b puts it on every machine:
- it is stored on each machine, never in ordinary state sync (owner-authentication §6);
- at Basic, the lease holder creates it with its machine key (decision 17);
- the agent's machines keep the same entry set over the mesh;
- `everEnrolled` stays sticky, so a deleted record never reads as Basic (umbrella line 129).

2b changes no authority decision yet. Later pieces read owner identity, devices and level from the record; 2b makes it exist, agree and survive. The minimum-build fence (umbrella lines 360 and 456) moves to its own piece, 2c, because it touches leases and proxying (§7).

## Proposed design

### 1. Where things live

- **The record:** `.instar/state/owner-record/entries.jsonl` (0600), written only through this module.
  - The folder is listed in `KEY_MATERIAL_PATHS`, the one list whose four consumers make a path never served by the file routes, excluded from backups, written into `.gitignore` (at init and by the post-update migrator), and classified never-sync. A bearer edit through the dashboard can't swap or trim it, and a restore never brings back an old copy: peers resupply it.
- **The markers and the pin:** `.instar/machine/owner-record-enrolled.json`, `.instar/machine/owner-record-seen.json` and `.instar/machine/owner-record-pin.json`, beside `identity.json`.
  - The **seen** marker is written the first time this machine holds any record, Basic or enrolled. It tells "never had a record" (a legacy install) apart from "had one and lost it".
  - They are in a different folder from the record, so deleting one folder never resets the agent to Basic (§4).
  - `.instar/machine/` is already never synced.
- **No saved "last good" state.** The state is recomputed from the stored entries with 2a's evaluator at boot and after every change, so nothing editable stands in for the record.

### 2. What is stored

- **2a's `keep` set and their ancestors,** each entry with one verifying signature. 2a guarantees that this stored copy evaluates to the same state as the full input.
- **No per-signer daily cap.** A count by day of arrival would make machines store different sets, and it could delay a revocation.
- **The volume a real record needs is tiny:** a few owner keys and machines, a few policies, and TLS entries only when a machine's key actually changes (never on a timer).
- **Spam needs a valid key,** and that is the stolen-key case. A record pushed past 2a's 2,000-entry bound evaluates as `input-too-large`, which holds Sensitive and Serious actions (§5) until the owner's reset. That is a visible forced reset, the limit owner-authentication §6 accepts. Compacting a long record is left behind (see the end).
- **Arrivals must verify first.** An arriving entry goes further only if its signature verifies against a key the record has ever held, or a key added by another verified arrival in the same batch.
  - Arrivals are checked in dependency order at any depth.
  - At most four verifying candidate keys are tried per entry.
  - A self-signed entry counts only where 2a allows one: a genesis, or the first owner key while the record has none.

  Junk never counts toward the bound or the work.
- **A verified flood holds, visibly.** A flood past 2a's bound can only come from a real key (a stolen one). It is kept up to 2,500 entries, so the record reads `input-too-large` and holds, here and after a restart, until the owner's reset.
  - Past that cap, only an owner key's revocation of a key the record holds is kept, and at most 50 of them.
  - A result with no genesis (for example, its machine left the registry) never replaces what is stored.
- **Only evaluated entries are stored.** Arriving entries are evaluated together with the stored ones; only the resulting `keep` set and its ancestors are written.
- **A flood of TLS entries can't grow it.** 2a keeps only each machine's latest TLS entry, and nothing may build on a TLS entry.
- **Out-of-order arrivals.** An entry whose parent is missing is held in a pending set (at most 500 entries, dropped after 1 hour), and its parents are pulled from the sender.

### 3. Bootstrap at Basic (decision 17)

- **Who creates it.** A machine writes the genesis (`level: 'basic'`, `agentProducible: true`) with its machine key only when all of these hold:
  - it holds the lease (`coordinator.getSyncStatus().leaseHolder` is this machine) and no split-brain is reported;
  - it has no record, or a record that fails and never enrolled (for example, the genesis machine's key rotated or it left the registry), and no enrolled marker of its own;
  - every registered active peer answered a pull in this boot with no record **and no marker naming this agent**. A peer's record that fails and never enrolled counts as "no record", because the peers usually hold the same broken record. Any such marker blocks bootstrap, checked before the honour filter of §4, so a machine that lost its record can't be overtaken by a fresh Basic one. An unreachable peer means wait. Retries back off: 15 minutes, doubling to a 6-hour ceiling.
  - **A breaker after 24 hours.** Retries stop, and one degradation report names the silent machine.
  - **What re-arms it:** that machine is heard from again (any signed mesh message), the machine registry changes, or the server restarts.
  - At Basic nothing is lost while it waits, because Basic is today's behaviour.
  - A peer on an older build answers "unknown command". That proves only what the peer's protocol supports, not what it holds: it may have been enrolled and then downgraded. So it counts as "not answered", and bootstrap waits until every machine runs this build. Waiting at Basic loses nothing.
- **A machine with no machine identity, or a lone machine with no lease holder** (a single-machine agent), creates no record in 2b. At Basic the record has no job yet: Basic is today's behaviour.
  - The first owner enrolment (piece 3) creates whatever is missing, in one flow: the machine identity, then the genesis, then the owner key.
  - This is written into piece 3's requirements in the build plan, not left implicit.
- **No pin at Basic.** While the record is Basic (`everEnrolled: false`), there is no pin, and 2a's tie rule (lowest machine id) settles two geneses. Two lease holders in turn (one partitioned, then the other) therefore converge on one genesis when they meet. At Basic the record is agent-producible anyway, so nothing is lost.
- **An unpinned genesis must come from a registered machine.** While no genesis is pinned (the record is Basic), a candidate genesis is considered only when its machine id and public key match a machine in this agent's registry (`.instar/machines/<id>/identity.json`). Otherwise it is dropped before evaluation, so a peer can't invent a lower-id genesis under a fresh key, and the registry bounds how many candidates there are.
  - **The check stops at the pin.** A pinned genesis is never re-checked against the registry, so a later machine-key rotation can't invalidate an enrolled record. After the pin, trust rests on the record and the pin alone, not on the registry, which travels through ordinary sync (owner-authentication §6).
  - When the registry changes, unpinned candidates are evaluated again.
- **Choosing the genesis.** When geneses compete, a machine prefers one whose record is enrolled (`everEnrolled`) over a Basic one, and uses the tie rule only between equals. So an enrolled record is never replaced by a Basic one with a lower machine id.
- **The pin is written at the first owner key.** When a machine first evaluates `everEnrolled: true`, it pins that record's genesis. From then on a different genesis is foreign. A machine joining later pins at the join handshake (the pairing piece), never on whatever a peer sends first.

### 3a. Where the bounds come from

Each bound is a cost floor taken from a measurement, never a judgment about content. Every time one is hit it is counted in `GET /owner-record`, never silently.

| Bound | Source |
|---|---|
| 2,000 entries | 2a's input bound. 2a's code review measured a 2,000-entry chain at 0.54 s and about 217 MB. A real record holds tens of entries: owner keys, machines, a few policies, one TLS entry per machine. |
| 500 entries or 2 MB per push or page | a quarter of the bound per message. 2a caps an entry at 8 KB, and real entries are under 1 KB. |
| Pending entries waiting for a parent: 500 entries and 2 MB **in total across all peers**, kept 1 hour | one page of out-of-order arrivals. A parent normally follows in the same page or the next; one hour is four 15-minute pull cycles, so a missing parent is asked for four times before the pending entry is dropped and pulled again from scratch. |
| A pull cycle: at most 4 pages (2,000 entries, the bound) per peer | a full record in one cycle; more than that can't be a valid record. |
| One push per peer every 10 s | keeps one peer within one evaluation's cost. |
| Evaluation: one at a time for the whole machine, at most every 5 s; at most once a minute when the input is over 500 entries | bounds the verification work across all peers together. At most 500 entries cost about 35 ms (scaled from the measured quadratic cost). Above that, a 2,000-entry evaluation's 0.54 s once a minute is under 1% of the event loop. A real record never gets near 500 entries; that size means a stolen key is flooding it, a forced reset in any case. (Build note: this replaces the worker thread first planned, for the same bound with less machinery.) |
| A reserved lane for revocations | a push gets the lane only if it carries a revocation that passes a cheap check against the last evaluated state: its signature verifies against a key valid now, and its target is a key valid now. Such a push skips the per-peer limit and the 5-second wait and is evaluated next. Anything else, including junk revocations, takes the normal queue, so a peer can't use the lane to force evaluations. At most 50 revocations per push are checked. |

### 4. everEnrolled is sticky

- **The marker.** Once a machine evaluates `everEnrolled: true`, it writes the marker, naming the agent, this machine and the genesis.
  - The marker only ever makes things stricter. A readable marker naming this agent means "enrolled".
  - An unreadable marker, or one naming another agent, is not taken as proof of enrolment. The gate reports it as `hold` with reason `enrolment-unknown`, because the state can't be verified. Holding is the safe answer to an unknown, and `GET /owner-record` names the mismatch.
  - So it needs no signature, and a machine-key rotation can't invalidate it.
- **Enrolled with no usable record.** On a machine with the marker, a missing, empty or failing record:
  - holds Sensitive and Serious actions and allows viewing (umbrella line 129);
  - pulls from peers;
  - never bootstraps.
- **Peers keep it too.** Every pull reply carries the replier's marker (`enrolled: true|false`). A machine that lost both files learns the record again from any peer that kept it.
- **Three outcomes, never two.** The gate tells verified never-enrolled, enrolled and unknown apart:
  - **Never enrolled, verified locally:** a record that never enrolled (ok or failing), or no record and no seen marker (a legacy install on its first boot of this build). Reads as Basic at once, even with a peer asleep. Basic grants nothing beyond today.
  - **Enrolled:** this machine's marker, or an honoured peer marker. Uses the record, or holds if it is unusable.
  - **Unknown:** no record but a seen marker (the record was lost), or an unreadable or other-agent marker. Holds Sensitive and Serious actions and allows viewing until every peer answers. If none is enrolled, the result is Basic; otherwise the record is pulled. Piece 1's local access link still works while held, because a hold refuses only Sensitive and Serious actions.
  - **If a silent peer never returns,** retiring it is itself a Serious action, which is held. The way out is the umbrella's §9 administrator-prompt reset on this machine; `GET /owner-record` says so and names the silent machine. The only waiting is before writing a genesis (§3). So a never-enrolled agent with one machine offline keeps working after a restart.
- **A peer's marker counts only when it checks out.** A pull reply's marker names the agent and the genesis. It is honoured only if:
  - it names this agent, and
  - its genesis is one this machine holds, or one another peer holds in a record that evaluates `everEnrolled: true`.

  An honoured marker, while this machine's record is absent or Basic, makes the machine hold and pull. Any other peer marker (a copied `.instar/machine/` folder, another agent's marker) is reported in `GET /owner-record` and changes nothing. So one stray file can't lock a never-enrolled agent.
- **This machine's own marker** always counts, because it only makes things stricter. If it names another agent, the mismatch is reported. The way out is the umbrella's §9 administrator-prompt reset on this machine; a Basic agent has no owner key to sign anything else.
- **The case it can't stop.** On a single machine, an agent that deletes both folders has changed its own records. The umbrella accepts this below Locked box.

### 5. What each state means for callers

| 2a status | Callers (piece 3 on) | Storage |
|---|---|---|
| `ok` | use level, keys and policies | keep accepting entries |
| `contested`, `owner-lost`, `no-valid-key`, `record-invalid`, `input-too-large` | hold Sensitive and Serious actions, allow viewing, tell the owner what the reset fixes | keep accepting entries, never fall back to an earlier state |
| a record that never enrolled (ok or failing), or no record and no seen marker; no own or honoured enrolled marker | Basic (today's behaviour) | bootstrap per §3; a failing never-enrolled record is replaced (below) |
| no record but a seen marker, or an unreadable or other-agent marker | hold until every peer answers, then Basic if none is enrolled | pull |
| no record or a Basic record, with this machine's marker or an honoured peer marker | as the failing row above | pull, never bootstrap |

2b ships one function, `ownerRecordGate()`, that returns `{ act: 'basic' | 'record' | 'hold', enrolment: 'never' | 'enrolled' | 'unknown', state, reason }`. Every later piece reads it rather than re-deriving this table.

#- **Replacing a failing Basic record.** The new genesis carries `replaces: <old genesis id>` in its body (2a accepts extra genesis body fields; a test checks this).
  - Each machine checks the claim itself: it accepts `replaces` only if the genesis named fails and never enrolled **on that machine**. Otherwise the new genesis is just another candidate under the tie rule. Each machine that adopts it discards the old genesis's entries and keeps the old id on a local exclusion list (`.instar/state/owner-record/excluded-geneses.json`), so the tie rule can never pick it again, whatever the failure was (a registry mismatch, `input-too-large`, or any other). Only a genesis that never enrolled can be replaced: an enrolled record is pinned (§3) and a pinned genesis is never excluded.

### 6. Keeping machines in step (mesh)

- **Two new mesh commands,** each a signed envelope:
  - `owner-record-push { entries }`: offer entries;
  - `owner-record-pull { have: string[] }`: ask for entries the sender lacks.
- **Paging.** A pull reply carries at most 500 entries and a cursor, and the puller asks again until done.
- **Who may send them:** any registered, active peer of this agent, verified by the envelope signature like every mesh command. The receiver judges each entry itself with 2a's evaluator, so a peer's word grants nothing.
- **Cost bounds** (lesson of #3369, an event loop stalled by heavy work; the figures are in §3a):
  - a push is at most 500 entries and 2 MB, otherwise it is refused whole;
  - entries already held (by id and signature) are dropped before any work;
  - at most one push per peer every 10 seconds is processed, and the rest are answered "busy". A push that carries a revocation is never answered "busy": a revocation burst is a handful of entries, and delaying one is worse than the work;
  - evaluation is single-flight, at most once every 5 seconds, and at most once a minute for inputs over 500 entries.
- **When:**
  - after a local change, push to every peer, retrying with backoff;
  - at boot and every 15 minutes, pull from each peer.
- **Visibility.** Each peer's last confirmed head appears in `GET /owner-record`, so the owner can see which machines have a revocation (§6's honest limit).

### 7. Not in 2b: the minimum-build fence (piece 2c)

Umbrella line 360 says the record carries a minimum build; updated machines refuse leases, proxying and the record to a machine below it, and enrolment at Phone or above waits until every machine is at the build. That changes the fenced-lease and proxy paths, which need their own review. So it becomes **piece 2c**:
- the minimum build is a record policy (`minimumBuild`);
- the build is reported in the signed mesh heartbeat;
- refusals cover leases, proxying and record pushes and pulls.

**Piece 3's enrolment requires 2c.** This is written into the build plan. 2b alone grants nothing, because it reads as Basic or holds.

### 8. Read route

- `GET /owner-record` (agent token) returns:
  - the gate verdict, status, level, `everEnrolled`, `agentProducible`, forked and contested, owner key ids;
  - pending and held counts, the marker and pin state, and each peer's last confirmed head;
  - peers that report a different genesis, or a marker while this machine has none, named so the mismatch is visible;
  - never a private key.

## Decision points touched

- **The gate's table** (§5): basic, record or hold, by record status, markers and peer answers — invariant; basis: irreversible-consequence; evidence: umbrella line 129 (a deleted record never reads as Basic).
- **Bootstrap only on the lease holder after every peer answered** (§3) — invariant; basis: external-constraint; evidence: umbrella decision 17, review rounds 1 to 4.
- **Unpinned genesis selection** (a registered key, enrolled beats Basic, then the lowest machine id) — invariant; basis: external-constraint; evidence: decision 17's tie rule.
- **Arrivals must verify against a known key; a verified flood holds** (§2) — invariant; basis: irreversible-consequence; evidence: the code review's probes p1, p5 and p6.
- **Cost bounds** (§3a) — judgment-candidate; floor: evaluation stays bounded, a revocation is never held back; arbiter: Echo; evidence: the measured cost of 2a.

## Multi-machine posture

Each machine keeps its own copy and judges every entry itself; signed mesh commands carry entries between machines. Bootstrap and readiness belong to the lease holder. A machine that can't reach its peers stays on what it has and says so in `GET /owner-record`.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Enrolled here | a marker file | the record evaluated `everEnrolled` on this machine | the marker names this agent and genesis; a mismatch holds as unknown | marker and record both deleted on a single machine (accepted below Locked box) |
| Never enrolled | no record, no seen marker | a legacy install's first boot | peers' answers before any bootstrap | a lost record without a seen marker |
| A peer has the record | its pull reply | its head, status and marker | heads compared in status | a silent peer (backoff, breaker, `waitingOn`) |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | A throwaway agent on this build boots, and `GET /owner-record` answers 200 with Basic (proof file in the build folder). The mesh exchange between machines is exercised by the unit tests' in-memory three-machine mesh. | `security.ownerRecord.enabled: false` |
| dev-agent-live | After throughput installs the build on Studio and M5, the lease holder bootstraps the record at Basic. `GET /owner-record` on each machine shows one genesis and matching heads. | the same switch |
| fleet | Ships on: at Basic it grants nothing, and nothing reads the gate until piece 3. | the same switch, or revert |

## Tests and evidence

- **Unit:** the store (bootstrap, sticky enrolment, the three outcomes, genesis choice, storage and signatures, paging, replacement, the code-review regressions) and the sync (bootstrap over the mesh, backoff and breaker, peer markers, lease moves, enrolment reaching every machine, bounds, the revocation lane, heads, machine-list changes).
- **Integration:** `GET /owner-record` over HTTP: 503 when off, 401, Basic, then record, then hold.
- **E2E lifecycle:** the server.ts wiring, the route alive at 200 over a real machine identity, the mesh handlers answering, 503 when off.

## Maturation plan

- **ladder:** not applicable: ships on with no staged switch (it grants nothing until piece 3 reads the gate); the stages below are evidence steps.
- **test-agent-live:** a throwaway boot proof before the PR merges; the multi-machine exchange in the unit tests' three-machine mesh.
- **dev-agent-live:** after install on Echo's machines, read `GET /owner-record` on each and confirm one genesis and matching heads.
- **fleet:** with the release, since at Basic it changes nothing an owner can see.
- **graduation criterion:** every machine of a multi-machine agent reports the same genesis and head within one pull cycle.
- **dark-window:** none; it ships on.

## Open questions

None.

## Left behind

- Reading owner identity and devices from the record (piece 3 onward).
- The owner's reset.
- The minimum-build fence (piece 2c, §7).
- Compacting a long record (an owner-signed checkpoint). Not needed at real volumes; a spammed record is a visible forced reset (§2).

## Review history

- **Round 1 (7 design, 2 precision), applied:**
  1. No pin at Basic; enrolled beats Basic; pin at first owner key or join; bootstrap only when every peer says "no record".
  2. A machine with no identity creates no record until piece 3's enrolment.
  3. The marker and pin live apart from the record; nothing found at boot is unknown until peers answer.
  4. No daily cap; spam past the bound is a visible forced reset.
  5. Push bounds, a rate limit per peer, single-flight worker evaluation.
  6. The fence becomes piece 2c, and piece 3 requires it.
  7. A state table plus one `ownerRecordGate()`; no saved last-good state.
  - Precision: the marker is unsigned and stricter-only (rotation-proof); missing parents are held and pulled.
- **Round 2 (4 design, 1 precision), applied:**
  1. A genesis must match a registered machine's id and key.
  2. Pull replies carry the marker, and a peer's marker makes this machine hold.
  3. Peer answers gate only bootstrap, never the Basic verdict.
  4. TLS flood: 2a keeps only each machine's latest TLS entry, and nothing may build on one (landed in 2a as commit 3bf3287a6).
  - Precision: paged pulls; store only after evaluation; foreign-genesis peers reported; older peers count as "none" for bootstrap.
- **Round 3 (2 design), applied:**
  1. The registry check applies only to unpinned (Basic) candidates; a pinned genesis is never re-checked, so a key rotation can't break an enrolled record.
  2. A peer marker counts only if it names this agent and a genesis that is held, or enrolled at another peer; anything else is reported. This machine's own marker clears only through the §9 administrator reset.
- **Round 4 (1 design, 1 precision), applied:** a failing record that never enrolled reads as Basic, and the lease holder bootstraps a fresh genesis (no stuck hold at Basic). Any peer marker naming this agent blocks bootstrap, checked before the honour filter.
- **Round 5: converged.** Precision applied: a peer's failing never-enrolled record counts as "no record" for bootstrap; a replacement genesis names the one it replaces, and every machine discards and excludes it.
- **Constitution check:** fit with the parent principle. Three standards answered:
  - **Judgment Within Floors:** §3a gives each bound's measured source, every hit is counted, and revocations bypass the rate limit.
  - **Verify the State, Not Its Symbol:** an unverifiable marker is reported as `enrolment-unknown` and holds, and a local-only Basic verdict is marked `basis: 'local-only'`.
  - **No Unbounded Loops:** the bootstrap retry backs off from 15 minutes to a 6-hour ceiling, with one degradation report after 24 hours.
- **Cross-model (GPT-6.2 Astra), 3 findings applied to 2b.** Its other findings re-reviewed piece 1, which is already built and reviewed.
  - **Three gate outcomes:** a seen marker tells a legacy install from lost files, and unknown holds until peers answer. An older peer counts as "not answered", not as "none".
  - **Bounds across all peers:** a pending budget for the whole machine, a page cap per pull cycle, one evaluation at a time, a reserved revocation lane capped at 50, and a breaker with explicit re-arm conditions.
  - **A plain-language summary fix:** older builds are fenced in 2c, not here.
- **Round 6 (1 design, 2 precision), applied:**
  - The revocation lane admits only a revocation that passes a cheap check: it verifies against a key valid now, and its target is a key valid now. Junk takes the normal queue.
  - §9 is named as the way out of an unknown hold.
  - Each machine checks `replaces` locally.
- **Round 7: converged.** One precision note accepted as is: a revocation signed by a key on an unmerged branch isn't from a key valid now, so it takes the normal queue. It is delayed by the rate limits, never lost.
- **Code second pass, applied before commit** (6, 2, 2, 1, 1 and 1 defects over six rounds; each is a regression test). The changes that touch the design:
  - arrivals verify before they count;
  - a verified flood holds rather than wiping or being refused;
  - a separate queue for revocations;
  - `replaces` only for the genesis this machine holds;
  - storage keeps every ancestor;
  - each peer's head is reported;
  - any signed mesh message re-arms the breaker.
