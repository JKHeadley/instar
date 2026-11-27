# Side-Effects Review: a forged answer can no longer make a machine send the agent token to a peer

**Version / slug:** `sec114-no-forced-signed-read-fallback`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`
**Authority:** Chief of Staff security program, 2026-11-18 13:53 PST (handoff aa684371): yes to this interim mitigation under SEC-114.

## Summary of the change

The three signed pool reads (a session list, a transcript, pool history) ask the other machine over the signed mesh first. They fall back to sending the agent token when the answer says the machine can't serve that read: `no-handler`, an older-version `claim-unauthorized`, or an old-shape history answer.

Mesh answers are not signed, so a party on the network path between two machines can forge that answer and get the token sent over the same path (SEC-114, active form).

**This is an interim mitigation that raises the cost of the attack. It is not a guarantee.** No version source is signed: the capacity advert also arrives in an unsigned answer.

The rule is a ratchet:
- **Recording.** This machine records, in `state/peer-version-floor.json` (machine-local), the highest version it has ever seen for each peer, from every source the pool registry reports (the coherence advert and the registry's hardware version). It never lowers that record.
- **Refusing.** Once a peer has been seen at 1.3.1740 or later (the release that serves all three reads), the fallback to it is refused, whatever the answer says. A remembered "needs the token" is not honoured either, because it could itself have come from a forged answer.
- **Why a forged version doesn't help.** It can only raise the record, which causes refusals (the safe direction). It can never reopen the fallback.
- **Reporting.** Each refusal is counted (`fallbacksRefused`). It is raised as a degradation (`poolSignedReads.bearerFallbackRefused`) at most once per machine and kind of read per 15 minutes, so a real breakage is visible without flooding.

**What it leaves open:**
- A peer never seen at a serving version by any source, which is an attacker present from the first sighting.
- Reads outside these three, and every write.

**The full fix** is signed mesh answers, piece 4's next design under SEC-114.

Files: `src/core/poolSignedReads.ts` (the rule and `PeerVersionFloor`), `src/server/routes.ts` (the three callers, the floor, the bounded report), and the tests.

## Decision-point inventory

The bearer-fallback rule in `signedThenBearer`: one new deterministic precondition: the peer's version floor (the highest version ever seen for it).

## 1. Over-block

A peer once seen at 1.3.1740 or later that later really answers `no-handler` would now fail that read instead of falling back. That happens with a broken build, or a rollback below 1.3.1740, which the ratchet doesn't forget. All three verbs ship from 1.3.1740, so a correct build never does this. When it happens, the degradation names the machine and the read, and the view shows that machine as failed rather than silently sending the token.

## 2. Under-block

The mitigation does not cover these:
- A peer never seen at a serving version (an older build, or a machine not yet heard from) still gets today's fallback.
- Reads outside these three, and every write, still carry the token.

The full fix is signed mesh answers, the next spec in piece 4 under SEC-114.

## 3. Level-of-abstraction fit

The rule sits in the one function that decides the fallback, and is applied by its three callers with one shared reader of the advert version.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No: a deterministic check over an enumerable input (a signed version string against a constant).

## 5. Interactions

- **`SignedReadCapability.status` / `GET /pool/signed-reads`:** gains `counts.fallbacksRefused`.
- **A new machine-local file,** `state/peer-version-floor.json`. It is written only when a value rises.
- **The degradation reporter:** one new feature name.
- **No change to:** the mesh envelope, the verbs, or the bearer path itself.

## 6. Rollback

Revert the commit. The file `state/peer-version-floor.json` is left behind and read by nothing.

## 7. Evidence

- **Unit** (`tests/unit/sec114-signed-read-forced-fallback.test.ts`, 8 cases):
  - the version boundary, exactly at 1.3.1740 and just below;
  - `no-handler` refused for a serving advert and still falling back without one;
  - an older advert's `claim-unauthorized` still falling back;
  - an old-shape history answer refused;
  - a remembered "needs the token" ignored only for a serving advert;
  - a timeout never falling back, either way.
- **Regression:** `tests/unit/topicHistoryPull.test.ts`, `signedPoolReads-awareness-migration.test.ts`.
- **Unit, further cases:**
  - the floor only rises (from either source), ignores garbage, and survives a restart;
  - a static check that all three route callers pass the floor and the reporter.
- **Integration** (run by Local Verify): a new case in `tests/integration/pool-reads-signed.test.ts`. A peer seen at 1.3.1800 answers `no-handler` through the real route: the answer is 502, `bearerReads` is 0 and `fallbacksRefused` is 1. The existing fallback cases already use 1.3.1700 peers and are unchanged.

## Second-pass review

An independent reviewer subagent read the diff cold. **Round 1: DO NOT CONCUR**, on three points:
1. **The "signed advert" claim was false.** The advert also arrives in an unsigned answer and could be lowered. Replaced by the persisted ratchet over every source, and the wording corrected to "raises the cost".
2. **The degradation report could flood** on every poll, for every peer and kind. Now bounded to once per machine and kind per 15 minutes.
3. **Tests missing:** a self-reported-only case, and proof the routes pass the floor. Added: the floor test, the static wiring check, and the integration case.

**Round 2: CONCUR.**
- **Verified:** the floor never lowers; the existing integration fallback cases are unchanged (each case has its own state folder and uses 1.3.1700 peers); writes happen only on a rise; `versionGreater` is a strict greater-than; the report bound is right.
- **Low, left for later:** a peer's floor can't be reset except by deleting the file. That is fail-safe for the token. A reset from the owner's phone belongs with the signed-answers work.
- **Fixed:** stale "signed advert" wording.
- **Run:** the reviewer's own test run waited behind the merge gate. My local runs of the three unit files pass (31 tests), and Local Verify runs the integration case.
