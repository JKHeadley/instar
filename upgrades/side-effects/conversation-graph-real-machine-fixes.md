# Side effects: fixes from the first run on two real machines

## What changed

A real run between the Studio and the M5, with throwaway agents and separate API tokens, found problems that no test could see. Each bug below was found in that run.

- **Recovery without Telegram.** `this.recovery` existed only when a Telegram chat was configured, so on an agent without Telegram any owner change needing adoption after a lease move was held forever, and everything behind it failed with `source-chain-gap`. An empty chat id is now valid and efforts need none. A pending row about a conversation waits instead of being refused, since with no chat to check against, a refusal would cancel it for good and the cause may only be a config problem. Such a row also holds up later rows until the config is back. An agent that never had Telegram has no such rows.
- **Stale reservation copy.** The native tail check judged the reservation's copy, which never receives the witness proof, so a row Source already held under proof blocked every later change after a lease move. It now judges Source's copy when one exists.
- **Lease epoch during removal.** The durable acquisition record stayed on the old epoch after a restart, so an interrupted removal could never finish. It now follows the epoch this machine actually holds. `acquireOnOwnerDecommission` already accepted a newer epoch.
- **Blocked event loop.** Three causes together starved the lease renewal timer until the lease lapsed mid-removal:
  - `SecretStore` launched the macOS `security` tool twice per secret read: 1,255 launches and about 20 s in one attempt. Reads are now remembered for 60 s in-process and cleared on any write.
  - Building origin rows was quadratic: every key rebuilt and hashed every row. `originRecordsFor` and `originRecordKeys` build only what is asked for.
  - Awaits that resolve immediately never yielded. Removal now yields at freshness checks and row reads.
- **Reasons in the log** for tail closure failures, peer transport failures and readiness.

## Decision point

The acquisition refresh and the reservation check sit on decision paths. Both still refuse what they refused before, apart from the specific false refusals above. Neither gains new authority.

## Review

1. **Over-block:** reduced, as described.
2. **Under-block:** a lease epoch this machine holds and has signed is accepted in place of the recorded one. A newer epoch held by this machine fences the old one just as strongly. A changed keychain key in another process is seen within 60 s, not at once; a stale key fails to decrypt and falls through the other candidates.
3. **Level of abstraction:** each fix is at the layer that had the fault.
4. **Signal vs authority:** log lines are signals only.
5. **Interactions:** the memo holds a copy of the master key in process memory for up to a minute. It clears on keychain writes and is never written anywhere. Injected test keychains bypass it.
6. **External surfaces:** none beyond the log lines. The keychain memo applies to every SecretStore user on macOS and Linux keyrings, not just this feature: it makes secret reads cheaper everywhere.
7. **Multi-machine posture:** this change is what makes the feature hold up across machines.
8. **Rollback cost:** revert. The acquisition record is rewritten in place, and old code would refuse a record on a newer epoch only until it is rewritten by a restart.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. No new trigger. The sync tick logs a fixed-format reason only when it changes.

- **Plan origin and stage index.** An origin with no creation file is an attempt that stopped before reaching the witness, so a retry starts over: the unused origin and stage index are replaced, and content-addressed parts are reused. With a creation file present nothing changes.
- **Prepared envelope proof.** Its time bound compared only the proof's own timestamps against a snapshot that can be a minute old. Removed; the native epoch check stays.

## Evidence

On the Studio and M5 with real pairing, a real network and different API tokens:

- A change committed across both, and the same effort reads back from both.
- A hard kill of the writer during a request: nothing was promised, the next change committed, both agreed. The kill may have landed before any write, so this does not cover a kill after one.
- A real removal: the M5 stopped, removed through the owner route in 34 s, status clear, history intact, a new change committed on the Studio alone, and all of it held after a restart.

Regression tests added for the reservation check (both sides), origin rows, the acquisition refresh, the keychain memo, and recovery existing without Telegram.

The retry fix used the commit gate's one-off end-to-end bypass. It can only be reached by stopping partway through a real removal, which the integration mode `surface-route-after-stage` does; it failed with `graph-stage-part-conflict` before the fix. The route itself has an end-to-end test.

## Not established

- **A slow or interrupted removal does not finish.** With 40 rows on a loaded machine, a removal interrupted by a kill took 259 s after restart and ended at `member-loss-role-initial-proof-invalid`. The signed plan carries a lease snapshot that expires before the witness sees it, and the witness's freshness check is deliberate. A retry is safe if nothing reached the witness, but it would fail the same way if the machine is still that slow, and writes stay on hold meanwhile. This is a blocker for relying on removal at scale and needs a design: bind these proofs to the lease epoch rather than the clock, and make removal much faster (every row check rebuilds `certifiedUnion`). Refreshing the lease after staging was tried and reverted, because revalidations and plan revisions are bound to the snapshot.
- The dashboard in a browser against a real pair.
- A real Echo-sized load.
- The full suites on this code.

## Second-pass review

One fresh Claude reviewer, read-only, nothing run, three rounds.

- First round: remembering a keychain failure could lead to overwriting a real key. Fixed: only a found key or a genuine not-found is remembered, and anything that may write re-reads first. Also flagged the lease and origin problems above, and permanent cancellation of rows needing a conversation check. Fixed: those rows wait.
- Second round: the keychain fix is closed. No remembered answer can generate or adopt a key. Unchanged existing risk: a non-not-found failure on the fresh read still falls through to the file key. It also found that the lease refresh broke later checks, so it was reverted, and that the origin fix is partial.

Reviewer did not concur on removal at scale, recorded under Not established. CMT-1437 tracks it.

## Later: silent-fallback count

The removal route's five status and refusal catches, and the recovery coordinator's header conflict catch, carry explicit markers saying why they do not report. The unit suite had counted them as new silent fallbacks (500 against a limit of 494).

A memo to skip rebuilding the certified view when peer data had not moved was tried and reverted. A failed stream read could leave a stale baseline, and it gained only about 15%.
