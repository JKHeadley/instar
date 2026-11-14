# Side-effects review — clear-and-seed: the fold ladder's first rung (clear matcher, clear-seed hook, `/clear` control command)

**Version / slug:** `cb-clear-seed`
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.2 rung 1 ("Clear-and-seed"), §9.3 (carriers keyed by `foldId`), §7.7 (seeded marker, context epoch). Converged 6 rounds, approved by the operator 2026-11-09 17:22 PST (topic 141133). Phase 0, third slice; stacked on `cb-one-recovery-carrier`.
**Tier:** 2 (fleet-wide settings + hook migration; widens an in-process control-command chokepoint).
**Change size:** `src/core/PostUpdateMigrator.ts` (new hook literal, settings migration, install), `src/commands/init.ts` (same for new agents), `src/core/SessionManager.ts` + `src/monitoring/ContextCompactionControl.ts` (closed union widened to `/compact | /clear`), new `src/monitoring/clearSeedPointer.ts`, tests.

## Summary of the change

The fold ladder's first rung replaces a session's context by injecting `/clear` and letting a SessionStart(`clear`) hook print a staged packet. This slice builds the mechanism; nothing stages a packet yet (the FoldCoordinator is a later Phase 0 slice), so on every agent the observable behaviour after this ships is unchanged.

1. **A `clear` matcher** in `.claude/settings.json` (init for new agents, `migrateSettings` for existing ones, idempotent on the command string) runs a **new, separate** script `hooks/instar/clear-seed.sh`, not `session-start.sh`. Today no hook runs on `/clear`; a separate script keeps a human-typed `/clear` silent, exactly as today.
2. **`clear-seed.sh`** prints a packet only when ALL hold: Claude Code engine; switch `contextBudget.compactionRecovery.enabled` not false; stdin `source` is `clear`; `INSTAR_SESSION_ID` set and safe; a pointer `<state>/context-layers/_clear-seed/<INSTAR_SESSION_ID>.json` exists naming that same Instar session; its lock `leaseExpiresAt` is in the future; the packet path resolves (realpath) inside the context-layers root; the packet is ≤ 8 MiB and its sha256 matches. It then **claims the pointer by atomic rename before printing** (single use: a racing second clear finds nothing), prints the packet, and writes the seeded marker `_seeded/<new claude session id>.json` with `epoch = foldId`, `source: 'clear'`. Any failed condition ⇒ prints nothing, exit 0.
3. **`injectInternalControlCommand`** accepts `/clear` as well as `/compact` through the same fenced control path (Stage-B `controlSync` fence for Codex, the single-writer pane lock otherwise). The set stays closed (`INTERNAL_CONTROL_COMMANDS`), checked at runtime; anything else is refused.
4. **`writeClearSeedPointer` / `removeClearSeedPointer`**: the single writer of the pointer schema (refuses unsafe ids, past expiry, a packet outside the root or over the limit; 0700 dir, 0600 file, atomic replace).

**Measured on real Claude Code 2.1.321 (the §9.2 Phase 0 question "whether `/clear` rotates the JSONL path, session id"):** yes. `/clear` starts a **new Claude session id and a new transcript file**, and the hook's stdin carries only the new id. The first L7 run keyed the pointer on the pre-clear Claude session id and the hook never found it. The pointer is therefore keyed on `INSTAR_SESSION_ID` (set in the pane environment at every spawn, survives the clear). Consequences recorded for later slices: `TokenLedger` and the session's `claudeSessionId` binding see a new id after a fold; the FoldCoordinator must re-bind it (the server already updates the binding from hook events), and the rung-1 rollback restore target is the pre-clear transcript file, which still exists after the clear.

**L7 evidence (real Claude Code 2.1.321, throwaway project, real `/clear`):** pointer staged by the real writer for `INSTAR_SESSION_ID=l7-inst-1`, packet containing a token that appears nowhere else. After `/clear`, asked for the token, the model answered `MANGO-4417`; the new transcript (`3fa92e69-…`) carries it as a `hook_success` attachment from `SessionStart:clear`; the pointer was renamed `.claimed-<ts>`; the marker was written for the new session id. Negative control: a second `/clear` with no pointer, same question, the model answered `NONE`.

## Decision-point inventory

- **Added:** whether the clear hook prints a staged packet. Deterministic over local file evidence (pointer, hash, expiry, path containment); no judgment; default is to print nothing.
- **Modified:** the set of control commands Instar may inject (closed set widened by one member, `/clear`). No caller injects `/clear` yet.

## 1. Over-block

None for users: nothing that worked before stops working. A fold that stages a pointer and then finds the hook silent (expired lock, hash mismatch, hook timeout) gets no seed; the spec's rung-1 rule is that this rolls back through §9.3 step 8, which the FoldCoordinator slice implements. The hook never prints a partial packet.

## 2. Under-block

- A human could type `/clear` while a fold has a pointer staged for that session; the packet would seed on the human's clear. Bounded: a pointer only exists under the fold lock, and the fold hold (later slice) holds inbound during that window; the packet is the session's own context, not another session's.
- The hook trusts `INSTAR_SESSION_ID` from its environment. A process that can set that variable already runs as the agent user and can read the packet directly, so the check is about routing, not a security boundary.
- Hook output size: Claude Code moved a 3.4 MB SessionStart output to a file with a 2 KB preview in this very session (seen at 18:49 PST). The delivery-capacity measurement (§9.2) decides the real per-rung limit; the 8 MiB cap here is only the hook's own read bound, and the verifier's size check (§9.3 step 4) is where the delivery limit is enforced.

## 3. Level-of-abstraction fit

Right layer: only the engine's SessionStart(`clear`) hook can place text into the fresh context at the instant of the clear; the server cannot. The pointer writer lives beside the existing `compactionSeedMarker` reader in `src/monitoring/`, and the control command reuses the existing fenced chokepoint rather than `rawInject`, as the spec requires.

## 4. Signal vs authority compliance

No blocking authority added. The hook either delivers or stays silent; the fail direction is silence (today's behaviour). The control-command widening grants no new caller any authority: it is in-process only, and the FoldCoordinator that will call it is gated by its own lock, owner and quiescence checks.

## 5. Interactions

- **session-start.sh** is untouched by this slice and does not run on `clear` (no `clear` matcher pointed at it, before or after).
- **CompactionSentinel seed wait** reads `_seeded/<claudeSessionId>.json`; a clear-seeded marker carries `source: 'clear'` and `epoch = foldId`. A compaction whose boundary entry is visible refuses a marker written more than 2 s before that boundary, so a fold's marker does not satisfy it. A late (watchdog or route) report with no visible boundary accepts a marker up to 120 s old, so a fold seeded just before an unreported compaction could have stood the server down for it; `readSeedMarkerFile` therefore ignores `source: 'clear'` markers, and only a compaction's own seed counts.
- **ContextCompactionControl** still passes only `/compact`; the type widening does not change what it injects.
- **Codex Stage-B fence:** `/clear` takes the same `controlSync` fence as `/compact`; Codex has no clear rung (§9.6 `absent`), and no caller will request one.

## 6. External surfaces

One new settings entry and one new always-overwritten hook script on every Claude Code agent. New files under `.instar/state/` (gitignored, never synced). No route, no user-facing message, no CLAUDE.md change (the feature is not yet usable by an agent; the FoldCoordinator slice adds the agent-facing text).

## 7. Multi-machine posture

Machine-local by design: the pointer, packet and marker live on the machine hosting the session, which is the only machine that can fold it (§9.3 owner-only). Nothing replicates.

## 8. Rollback cost

`contextBudget.compactionRecovery.enabled: false` makes the hook print nothing (it is silent today anyway). A release revert leaves the `clear` matcher and `clear-seed.sh` in place: the older migrator does not know them, so nothing overwrites or removes them. They stay harmless because nothing stages a pointer on an older build; removing the matcher is a one-line settings edit.

## Carried into later slices (from the second pass)

- The seeded marker proves the hook printed, not that the model received it (the 2 KB-preview case above). The FoldCoordinator's probe (§10) is the delivery check, never the marker alone; a hook killed at the 5 s timeout after printing can leave a delivered packet with no marker.
- The FoldCoordinator must call `writeClearSeedPointer` with the same state root the hook reads (`INSTAR_AGENT_HOME/.instar` when set).
- Claimed pointers are released by `removeClearSeedPointer` (now covers the `.claimed-<ts>` copies), called on the fold's terminal transition and by the boot sweep.

## Second-pass review

**Concur with the review.** Audited against the staged code, not the prose.

Verified by running it:
- Rendered `clear-seed.sh` passes `bash -n`; neither `python3 -c "..."` body contains `"`, `$`, a backtick or a backslash.
- Containment holds: an absolute `packetPath`, a symlink inside the root pointing out, and a sibling directory sharing the prefix (`context-layers-evil`) all print nothing (with a positive control that printed).
- Single use holds under a race: 40 rounds of 6 concurrent hooks on one pointer, exactly one printed each round (`os.rename` of the source is the arbiter).
- A human `/clear` (no pointer) prints nothing; `session-start.sh` is not in the diff and no installer points a `clear` matcher at it.
- Migration and init both key on the `clear-seed.sh` command string, so an init-installed entry is not duplicated; the block runs after `hooks.SessionStart` is guaranteed to exist.
- `injectInternalControlCommand` checks the closed `INTERNAL_CONTROL_COMMANDS` at runtime and takes the same Codex `controlSync` fence; `ContextCompactionControl` still sends only `/compact`.
- Sentinel numbers (2 s, 120 s) match `CompactionSentinel.ts:353,389,205`. Touched and neighbouring suites pass (94 tests).

Non-blocking notes, none changes the verdict:
1. **Rollback wording (§8) is inaccurate.** After a release revert the older migrator does not know `clear-seed.sh`, so nothing overwrites or removes it; the script and matcher simply stay. Still harmless (nothing stages a pointer), but say that.
2. **Claimed pointers accumulate** (`PostUpdateMigrator.ts:346-348`, `<id>.json.claimed-<ts>`); `removeClearSeedPointer` (`clearSeedPointer.ts:84`) removes only the live pointer. The artifact does not mention it. The FoldCoordinator's terminal transition or boot sweep must delete them (§9.3 "every carrier released by the terminal transition").
3. **The marker proves "hook printed", not "model received".** It is written after `stdout.write` regardless of what Claude Code does with the output (the 2 KB-preview case in Under-block). The later slice must not treat the marker alone as delivery proof; conversely a hook killed at the 5 s timeout after printing leaves a delivered packet with no marker.
4. **State root:** the hook prefers `INSTAR_AGENT_HOME/.instar` over `CLAUDE_PROJECT_DIR`. The writer must be called with that same state dir. (This also silently redirects any hand test run inside an Instar session; it voided my first probe run.)
5. `src/templates/hooks/settings-template.json` lists the SessionStart matchers without `clear`. It is reference-only today (no code reads it), so this is drift, not a defect.
6. "The server already updates the binding from hook events" (Summary) concerns a later slice and was not verified here.
