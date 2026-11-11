# Side-Effects Review — The standing packet and its verifier (context budget Phase 1 S10)

**Version / slug:** `cb-standing-packet`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

This builds the standing packet of context-budget-layered-summaries §9.5 and the packet verifier of §9.5 and §9.7. The packet is what a topic's session gets back after an unplanned compaction. It ships behind `contextBudget.enabled` (dev-gated: live on development agents, off on the fleet). It adds no new switch.

**The packet** (`src/monitoring/contextLayers/standingPacket.ts`):
- **What it holds, in priority order (§8: protected class first):**
  1. the Anchor's framing rows;
  2. the ledger live set, from the existing `selectLiveSet` floor via `anchorLedgerView`. Each entry's bound operator row is quoted, or a one-line derived label is shown when the entry has none;
  3. the operator's last N=20 U rows (`RECENT_OPERATOR_TURNS`), each with its `stubFor` referent stub beside the quote;
  4. H1, and H2 or `absent`, with `layerFreshness` stamps and author;
  5. H3 (`renderH3`);
  6. chunk and C2 pointers, plus every "unsummarized gap" line.
- **Source of the words.** Every quoted row is rendered from the TopicMemory row itself. The layer store holds references only, so its references-only rule is unchanged.
- **Missing layers.** Each one is an in-band `absent:` or `missing:` line.

**Size.** The delivered variant is bounded to 6,000 UTF-16 code units, the same unit RF's fitter counts. That bound fits inside RF's 9,000-character block, which in turn fits Claude Code's 10,000-character hook-output limit.
- **Reduction order (§9.5, §12: protected class last):** protected rows fill the budget first, in priority order (the Anchor, the newest 3 turns, the live ledger, then older turns). Then H1, H2, the chunk list and H3 fill what is left. So H3 is left out first, then the chunk list, then H2 and H1, and an operator row only when every derived layer is gone. Each row is whole or omitted, never cut, and leaves a placeholder line in place.
- **The full packet** is always saved to RF's location, `state/context-layers/_recovery/packet-<topic>.txt`: 0600 in a 0700 directory, under the never-served root, never backed up, and pruned after 7 days by the same rule RF uses. An explicit `READ THE FULL PACKET NOW` line sits inside the budget.
- **Disclosure.** Every omission is listed in the packet.

**The verifier** (`verifyStandingPacket`):
- the delivered variant is under budget;
- every rendered protected span is byte-identical to its stored `RowRef` (sha256 and length) AND to the TopicMemory row now;
- no referenced row is missing;
- the required sections are present, found outside any quoted span;
- every present derived layer carries an `as of <ISO>` stamp;
- a reduced packet carries its Read line.
A failure stages nothing: the previous pointer and this feature's keep-instructions are removed. It is counted (`status().verifyFailed`, by problem) and reported once per topic per hour through DegradationReporter, plus a featureEvidence `error`.

**Staging and the hook.**
- **On disk.** Verified packets are staged at `state/context-layers/_standing/<topic>.md` with a `.json` pointer carrying sha256, length, `verified`, `builtAt` and `fullPath`. `_standing` is added to `NEVER_BACKUP_PATH_SEGMENTS`.
- **compaction-recovery.sh.** A `STANDING_PACKET_PY` read checks the schema, topic, `verified`, age ≤ 7 days, sha256, and UTF-16 length ≤ 6,500. It runs only when `CB_PACKET_OK=1`, which only the session-start compact branch's recovery-on Claude Code path sets.
- **What the hook prints.** The packet goes in place of today's briefing and conversation context, wrapped in `--- STANDING PACKET <sha8> ---` delimiters.
- **The fitter (RF).** It keeps that section whole, searches its other sections only outside it, and sheds the identity and memory heads instead of the packet.
- **Unchanged.** The seeded-marker write, the marker-first rule and the canary are all as before.

**Producers and readers.**
- **Triggers.** `LayerStore.onWrite` (in `contextLayersBoot`) calls `stager.request(topic)` for packet input types. The request is debounced 5 s and staged only for topics with a live session on this machine.
- **Keep-instructions.** Each stage also writes `writeKeepInstructions(source: 'standing-packet')` for every live Claude Code session of the topic. The text is a keep variant: the Anchor, the live ledger and H1, under 5,000 characters, protected rows whole. A fold's `fold:` keep-instructions are never overwritten.
- **Spawn.** The spawn path (`server.ts` `spawnSessionForTopic`) and the compaction-resume path (`buildTelegramCompactionText`) call `stager.packetForSession(topic)`. That builds fresh, verifies and stages, and passes the result to `TopicMemory.formatContextForSession(..., { standingPacket })`, which puts the packet in the summary's place. It is the full packet up to 32K, otherwise the delivered variant.
- **Layers off.** `clearStagedStandingPackets` runs at boot, so no packet survives.

**Other changes.**
- `GET /topic/:id/standing-packet` (bearer): sizes, sections and the verdict, never words; 503 when off. It has a CapabilityIndex entry and an endpoint listing.
- CLAUDE.md template row plus an idempotent `migrateClaudeMd` row. `feature-delivery-completeness` lists the sniff.
- The hook scripts reach existing agents through `migrateHooks`, which always overwrites them. `init` uses the same `getHookContent` for parity.

**Files.**
- New: `standingPacket.ts`, `standingPacketBoot.ts`.
- Modified: `contextLayersBoot.ts`, `PostUpdateMigrator.ts` (STANDING_PACKET_PY, compaction-recovery section 1, the session-start compact call, the fitter, migrateClaudeMd), `TopicMemory.ts`, `BackupManager.ts`, `server.ts`, `routes.ts`, `CapabilityIndex.ts`, `templates.ts`.
- Tests and these artifacts.

## Decision-point inventory

- **Packet content selection and reduction order** (add). Deterministic, from the spec's own order (§9.5, §12 row "Packet oversize on the compaction path": protected class reduced last and only with disclosure). The ledger live-set floor (§6.2) is passed through unchanged.
- **Packet verification outcome** (add). Deterministic. Its only consequence is which of two existing deliveries is used: the packet, or today's RF-fitted block.
- **What compaction-recovery.sh prints for topic context** (modify). The packet when it is staged and verified, otherwise today's context.
- **What the fitter keeps** (modify). The packet section is kept whole, and the heads are shed first.
- **What `formatContextForSession` returns** (modify, opt-in parameter). The packet replaces the summary only when a caller passes one.
- **The seeded marker and canary crediting** (pass-through). Both are unchanged.

---

## 1. Over-block

No block/allow surface on messages or sessions. The verifier can refuse a packet. Legitimate packets it could refuse:
- **An operator row edited after U recorded its reference.** The hash mismatches, so verification fails until U re-derives the reference. The session gets today's block meanwhile, which is the right failure direction.
- **A row deleted under privacy (`deleteMessagesByUser`).** `protected-row-missing` keeps failing until U and the Anchor reconcile. That is counted and reported once per topic per hour, and recovery stays on today's block.
- **A staged packet older than 7 days** (the server has been down that long) is not delivered. Today's block is.

## 2. Under-block

- **The session may ignore the Read line** for a reduced packet. Compliance is not enforced. The protected class most likely to matter (the Anchor and the newest turns) is in the delivered part.
- **The keep-instructions shape the summary, but cannot guarantee it.** Spec §8 says so: a compaction instruction cannot make Claude's summary hold U verbatim, and only the reseed does.
- **Fold windows.** The packet is not resolved "as of the fold" during a fold lock (§7.7), because folds are Phase 2. A packet restaged mid-fold reflects the live layers. Only keep-instructions are fold-aware: a `fold:` pointer is left alone. <!-- tracked: CMT-1536 -->
- **No pre-rendered reduced variants beside the packet.** §9.5's "pre-rendered reduced variants" are realised as one delivered variant that is already reduced, plus the saved full packet. There is no ladder of variants. The hook only reads either way.
- **No respawn fold is scheduled to restore the full packet.** §9.5 asks for one. Folds are Phase 2, and the Phases 1–2 alternative is the delta hook (§7.7), which is not built yet. <!-- tracked: CMT-1536 -->
- **Only the compact seed and the spawn/resume paths read the packet.** The `clear` seed stays the fold packet path (§9.2, FoldCoordinator). A human `/clear` keeps today's orientation.
- **"Quoted above" can point at an omitted row.** When a reduced delivered variant omits a row that a later ledger or recent line marks as "quoted above", that line refers to an omitted row. The omission is still listed in the disclosure.
- **No Codex carrier yet.** The Codex adapter's `UserPromptSubmit` carrier (§9.6) is not built. Codex sessions keep today's behaviour: the hook path is Claude Code only, and the keep-instructions are written for Claude Code sessions only. <!-- tracked: CMT-1536 -->

## 3. Level-of-abstraction fit

- **Assembly** is a pure function over the layer store and a row source. It reuses each layer's own reader: `anchorLedgerView`/`selectLiveSet`, `stubFor`, `layerFreshness`, `renderH3`, and chunk records.
- **Delivery** reuses RF's fitter, saved-file location and pruning rule, and `writeKeepInstructions` with its hook. No second fitter and no second keep path.
- **Shape split.** The server composes; the 5 s hooks only read and hash-check, as §9.1 requires. TopicMemory gains an opt-in parameter and no knowledge of the layers.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The verifier decides only which existing delivery the session receives. It never blocks a message, a session or a compaction. Verification failures are signals (degradation and evidence).

## 4b. Judgment-point check

The budgets come from a measured external constant: Claude Code's 10,000-character hook-output limit, minus RF's measured preamble and heads. The reduction order is the spec's own (§9.5, §12). Verification is an invariant (byte identity, enumerable checks). The live-set floor is S6's, unchanged. No new static heuristic sits at a competing-signals decision point.

## 5. Interactions

- **Seeded marker.**
  - Still written only when the seed exits 0, prints something, and the fit succeeded (`CB_FIT_OK`).
  - A packet makes the seed print more, never less, so the marker semantics are unchanged.
  - The marker line stays first, inside 2 KB.
  - The canary credits a non-truncated delivery. The test feeds the real hook stdout to `CompactionCanary` and gets `recoveryBlock: true`, `recoveryTruncated: false`.
- **The exec path.** With recovery off, the event is read from the environment as today, so a compact start resolves to the startup orientation and no packet is printed (tested). For another engine, the exec path runs without `CB_PACKET_OK`. Either way the output is exactly today's.
- **Fold keep-instructions.** `fold:` sources are never overwritten. `clearStagedStandingPackets` removes only `standing-packet` sources (tested).
- **Server-side compaction resume.** It now carries the same packet text. `CompactionSentinel.report` still short-circuits only on the seeded marker. One injector at a time is unchanged.
- **Races.** Stage writes are atomic: full file, then text, then pointer.
  - A hook reading between text and pointer sees a hash mismatch and prints today's block. It never prints a wrong packet.
  - Concurrent stages of one topic both write a verified packet, and the last pointer wins with its matching text. The debounce coalesces bursts.
- **Load.**
  - Each stage reads the topic's layer records plus at most ~40 TopicMemory row lookups.
  - Debounce is 5 s per topic, and only topics with a live session are staged.
  - `packetForSession` runs synchronously at spawn and resume, comparable to `formatContextForSession`'s own queries.
- **H3 single writer.** The packet only reads H3 and the summary table is untouched. With a packet, `formatContextForSession` drops the table's summary from the spawn context (H3 is inside the packet).

## 6. External surfaces

- **Post-compaction context.** On development agents with the layers on, a topic session's post-compaction context and its spawn and resume context change shape: the packet replaces the rolling summary.
- **New files** appear under `state/context-layers/_standing/` and `_recovery/packet-*.txt`. They are never served, never backed up and never replicated.
- **New read route:** `GET /topic/:id/standing-packet`, bearer, with no words in the response.
- **Not touched:** the fleet (layers off) and other engines.
- **Operator-facing actions:** none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **The packet and its staged files: machine-local by design.** `machine-local-justification: hardware-bound-resource`. A packet is staged for the sessions on this machine and rendered from this machine's TopicMemory rows and layer store; U re-derives per machine (§14). Each machine's server stages for its own sessions, and a topic that moves re-stages on spawn at its new machine through `packetForSession`.
- **Notices.** The packet emits no user-facing notices.
- **URLs.** The packet's chunk pointers name agent-relative routes, never machine URLs.
- **Status surfaces.** `GET /topic/:id/standing-packet` and `GET /context-budget/layers` (`standingPacket`) are for this machine.

## 8. Rollback cost

- **Switch.** `contextBudget.enabled: false`, then a restart. The boot clears every staged packet and this feature's keep-instructions, and the hook prints today's block.
- **Revert.** A code revert restores the previous hooks through `migrateHooks`. Leftover files are inert: no hook reads them without `CB_PACKET_OK`, and they are bounded by the 7-day age check.
- **Data and users.** No data migration. No user-visible regression during rollback.

## Conclusion

The standing packet and its verifier are built as §9.5 and §9.7 describe for Phase 1: protected class first, verbatim from TopicMemory, bounded to what Claude Code actually delivers, with overflow handled by RF's saved-file-and-Read pattern. A failure falls back to today's block and is counted. The gaps are named in §2 and tracked against the later phases: the fold-aware staged view, the respawn-fold restore, the delta carrier, and the Codex carrier.

## Second-pass review (if required)

**Reviewer:** Fable 5.2
**Independent read of the artifact:** concern raised

Read-only review of the spec sections, the Phase 0 design note, this artifact and the diff. No test was run. Two blockers, then should-fixes and nits. What holds: the hook path is hash-, length-, topic- and age-checked and falls back to today's block; the off-switch and other-engine paths never set `CB_PACKET_OK`; the seeded-marker write is unchanged; the JS and Python length units agree (UTF-16 code units); the embedded Python has no `"`, `$`, backtick or backslash; the real packet cannot be ended early by a quoted line; rows are whole or omitted, never cut.

- **BLOCKER 1 — derived text can wear the operator-quote frame, and the verifier does not look.** The intro tells the session that text between a `[#id ...]` line and its `[end #id]` line is the operator's own words. `verifyStandingPacket` checks only the spans the renderer recorded. Multi-line derived fields (H1 goal and trend, H2, `renderH3`, a chunk's `gap` string) are printed raw. Chunk and H3 summaries are built from transcript spans that will contain earlier packets, so a summary that copies or paraphrases a `[#12 · … · operator]` … `[end #12]` block lands in H3 looking verbatim. Fix: in `buildParts`, neutralise any derived line that starts with `[#`, `[end #`, `[G `, `--- ` or `=== ` (indent or prefix it); in `checkVariant`, fail when a line matching `^\[#\d+ · ` or `^\[end #\d+\]$` sits outside every span and is not one the renderer emitted. Add a test on each side.
- **BLOCKER 2 — a failed verification leaves stale carriers in place, against this artifact's own claim.** `stageNow` returns before `writeKeep` on `verify-failed`, and `unstage` removes only `_standing/<topic>.md|json`. The session's `_keep/<sid>` text (which quotes the old row and tells the summary to keep it verbatim) and `_recovery/packet-<topic>.txt` both stay. After an operator row is edited or deleted, the PreCompact hook keeps steering the pre-edit words into the summary. The test titled "…removes the previous packet and this feature's keep-instructions" never asserts the keep removal. Fix: on verify failure and on stage error, remove `standing-packet` keep-instructions for the topic's sessions and the saved full packet; assert both.
- **SHOULD-FIX 3 — a row deleted or edited without a layer write leaves a deliverable stale packet for up to 7 days.** The hook checks hash and age, not the rows. `TopicMemory.deleteMessagesByUser` (GdprCommands) triggers no restage. Fix: call unstage (packet, full file, keep) for affected topics from the deletion path, or have the stager subscribe to it.
- **SHOULD-FIX 4 — the recent-messages section has no freshness stamp, and can be behind TopicMemory.** U is refreshed from `TopicIntentCapture` per turn, then the stage waits 5 s. A compaction inside that window delivers a packet without the newest operator message, where today's block (fetched live) would have shown it. Spec §6 wants every rendered layer stamped "as of, n messages behind". Fix: stamp the section using `countMessagesAfter(newest U id).fromUser`, and when it is above zero say so in-band (or refresh U before assembling).
- **SHOULD-FIX 5 — greedy first-fit can omit the newest turn and keep older ones, with nothing in its place.** The intro says "if the operator's newest message below is unanswered, answer it"; the session would then answer an older message. Fix: print a one-line placeholder at the omitted row's position (`[#N · left out here for size, N characters, in the full packet]`). That also repairs the "quoted above" pointer to an omitted row named in §2.
- **SHOULD-FIX 6 — H1 and H2 are kept while protected rows are shed.** §9.5 and the §12 row say protected class last. H1 plus H2 can reach about 5,000 characters (two 1,200-character fields each, themes, an uncut `disclosure`), which alone can push the Anchor out of a 6,000 budget, or make `base` oversize so the topic never stages. Fix: before omitting any protected row, cut H2 then H1 to their §6 targets (and bound `disclosure`); or declare the deviation here with its reason.
- **SHOULD-FIX 7 — the fitter trusts any delimiter pair.** `fit-recovery-output.mjs` treats the first `--- STANDING PACKET <8 hex> ---` … matching end line as the packet even on the legacy path, where a recent message quoting hook output can supply both lines. It then drops the conversation section and never cuts the "packet", so the output can exceed the limit while exiting 0, and the seeded marker is written. Fix: accept `pk` only when sha256 of the inner text starts with the nonce and its length is at most 6,600; otherwise treat as no packet. Add a spoof test.
- **SHOULD-FIX 8 — restaging can delete the full packet a session was just told to Read.** `stageStandingPacket` removes `_recovery/packet-<topic>.txt` when the new packet is not reduced, and it does so before the new pointer lands. PostCompact layer writes arrive in the seconds after a seed. Fix: always write the full file, never delete it on restage; let the 7-day prune remove it.
- **SHOULD-FIX 9 — live ledger entries beyond the newest 500 are dropped silently.** `anchorLedgerView(..., { limit: 500 })` slices by time before the live filter. Fix: compare with `view.liveSet.live` and add an in-band note, or render from the live keys.
- **SHOULD-FIX 10 — the server-side resume path uses the packet with the recovery switch off.** §9.1 conditions the standing-packet reseed on `contextBudget.compactionRecovery.enabled` on that machine. `buildTelegramCompactionText` passes the packet whenever the layers are on. Fix: gate it on the same switch read the sentinel uses.
- **SHOULD-FIX 11 — the Read instruction contradicts a spec sentence, undeclared.** §9.5 says "never an instruction to the session to fetch its own protected text". The Phase 0 design note requires exactly that. §2 says compliance is not enforced but does not name the conflict. Fix: declare it as a deviation backed by the design note, and amend the spec.
- **SHOULD-FIX 12 — keep-instructions for ended sessions are never removed, and `_keep` is backed up.** `_keep/<sid>.md` now holds verbatim operator rows, one per session ever staged, and `_keep` is not in `NEVER_BACKUP_PATH_SEGMENTS`. Fix: sweep `standing-packet` keep files whose session is not running at each stage or at boot, and add `_keep` to the list.
- **SHOULD-FIX 13 — load is understated in §5.** Each stage calls `store.list(topic, 'u')` four times (`buildParts` and `anchorLedgerView`, each again for the keep variant); `list` reads and parses every U file synchronously. On a topic with thousands of operator messages that is every 5 s of activity on the server's event loop. Fix: build the parts once and share them with the keep render; correct §5.
- **SHOULD-FIX 14 — a hook-side fallback is invisible.** When the hook refuses a staged packet (hash, age, length) nothing records it, and the seeded marker does not say which carrier was delivered. §17 needs "delivered bytes vs staged bytes". Fix: write the packet's `sha8` (or `legacy`) into the seeded marker.
- **SHOULD-FIX 15 — missing tests on the hook's boundaries.** No test for age over 7 days, future `builtAt`, `verified` not true, topic mismatch, `chars` mismatch, over 6,500, a non-BMP character (JS vs Python units), CRLF in a row, or a delivered packet exactly at the budget.
- **SHOULD-FIX 16 — no word on whether the newest operator message was answered.** The packet replaces today's 20 recent messages, which included the agent's replies. Fix: one derived line giving the id and time of the agent's last message to the operator.
- **NIT 17** — `STANDING_PACKET_PY` writes through text `sys.stdout`; `sys.stdout.buffer.write` of UTF-8 bytes is locale-independent.
- **NIT 18** — the hook's topic check accepts a leading `-` and Unicode digits; the stager stages only `^\d{1,15}$`.
- **NIT 19** — a row with a lone surrogate or a NUL byte is delivered altered (UTF-8 encode, bash substitution) after passing the in-memory check; hash the staged bytes' protected slices or refuse such a row.
- **NIT 20** — after protected shedding frees space, the chunk pointers are not re-added.
- **NIT 21** — a session spawned through `packetForSession` has no keep-instructions until the next layer write.
- **NIT 22** — the section and freshness checks verify the renderer's own output and are close to tautological; the hash checks carry the weight. Say so in the verifier bullet.

**Author's resolution of the first pass:**

Blockers (both fixed):

1. **Derived text can wear the quote frame.** Every derived line (H1/H2/H3, chunk gaps) that starts like a quote frame (`[#`, `[end #`), a ledger label (`[G `) or a section header (`--- `, `=== `) is prefixed with `> ` (`neutralizeDerived`). The verifier now refuses any frame-shaped line outside a protected span that the renderer did not emit at a known place (`forged-quote-frame`). Tests cover both sides: forged text in H3 and H1 is neutralised and the packet verifies, and an injected frame fails.
2. **A failed verification leaves stale carriers.** A failed verification or stage error now withdraws everything the packet carried: the staged packet, the saved full packet, and this feature's keep-instructions for the topic's sessions (`keepWithdrawn`). A fold's keep-instructions are left alone. The test now asserts all three.

Should-fix:

3. **Stale packet after an unannounced row change.** Not fixed in this slice. `eraseUserData` has no production caller (grep finds only its definition), TopicMemory has no edit path, and the ReviewCanary deletes only its fixture user, which is never labelled `operator`. Every restage re-verifies against the rows, and a mismatch withdraws the packet. Wiring an unstage into the erasure path belongs with the erasure path's own wiring. <!-- tracked: CMT-1536 -->
4. **Recent-messages freshness.** The recent section now carries an `as of` line. It says either that it lists the operator's newest message, how many newer operator messages are not in the packet yet (with an instruction to read the topic's recent messages), or that this is unknown.
5. **Omitted rows leave nothing in their place.** Every omitted part now leaves a `(left out for size: …; it is in the full packet)` line in place. That also fixes the "quoted above" pointer to an omitted row. There is also a derived UNANSWERED line (16).
6. **H1 and H2 kept while protected rows are shed.** The reduction now follows §9.5/§12: protected rows fill the budget first, then H1, H2, the chunk list and H3 in that order. So H3 goes first, then the chunk list, H2 and H1, and an operator row only when every derived layer is gone. Derived fields are capped at 600 characters and the disclosure at 200.
7. **The fitter trusts any delimiter pair.** It now accepts a packet section only when the nonce is the sha256 of the section's own text and the text is at most 6,600 characters. Tests cover a spoof and a real packet.
8. **Restaging can delete the full packet.** The full packet is now always written, never removed on restage, and pruned at 7 days.
9. **Live ledger entries past 500 dropped silently.** Live entries beyond the listing are now disclosed in-band.
10. **Resume path ignores the recovery switch.** The server-side resume path reads the packet only with `contextBudget.compactionRecovery.enabled` on.
11. **The Read instruction contradicts §9.5.** This is a declared deviation, below.
12. **Keep files outlive their sessions.** Keep-instructions this feature wrote for sessions no longer running are swept at most every 10 minutes (`keepSwept`), and `_keep` joins `NEVER_BACKUP_PATH_SEGMENTS`.
13. **Load.** Parts are built once per stage and shared by the packet and the keep text.
14. **Hook-side fallback is invisible.** The seeded marker now records `carrier`: the packet's 8-hex nonce, or `legacy`. Tests cover both.
15. **Missing hook boundary tests.** Added: age over 7 days, a future `builtAt`, unverified, another topic, a length mismatch, a hash mismatch, over 6,500, a non-numeric topic, exactly 6,500 UTF-16 units versus one more, a non-BMP character and CRLF end to end.
16. **No answered signal.** The recent section names the agent's last reply and flags UNANSWERED when the operator's newest message is later.

Nits:

- 17 and 18 are fixed: the read writes through the byte buffer and accepts ASCII digits only.
- 20 is fixed by the new fill order: derived layers re-enter when room is left.
- 19 (a lone surrogate or NUL is altered after the in-memory check), 21 (a freshly spawned session has no keep-instructions until the next layer write) and 22 (the section checks are near-tautological; the hash checks carry the weight) are recorded. <!-- tracked: CMT-1536 -->

**Declared deviation (§9.5).** §9.5 says "never an instruction to the session to fetch its own protected text". The binding Phase 0 result (Claude Code delivers hook output whole only up to 10,000 characters) requires a saved file and a Read instruction for anything larger, and it post-dates the spec text.
- The packet keeps the protected class first, so the Read line covers only what cannot fit: older operator turns, H3 and the chunk list.
- The §9.5 Phases 1–2 carrier for dropped protected items, the delta hook (§7.7), is not built yet. Once it is, it replaces the Read line for protected items.
- The spec text should be amended to name the saved-file carrier. <!-- tracked: CMT-1536 -->

**Resolution check:** concern

Read against the current code, not the prose above. No test was run; R1's sizes are arithmetic from the string templates. Twenty of the 22 first-pass items are resolved or acceptably tracked. One regression from the fix for item 5 blocks, and two smaller things remain.

- **Confirmed resolved: 1, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 20.** Details worth recording:
  - **1.** `neutralizeDerived` covers H1, H2, H3 and the chunk lines. The `forged-quote-frame` pass accepts every legitimate renderer line I traced: quote headers with and without a stub line, `[end #id]` (including an empty row and a row ending in a newline), `[#id · quoted above]`, both ledger label forms inside the ledger section, section headers, the packet header and the omitted-row placeholder. I found no false positive. The ledger-bound-to-the-Anchor "quoted above" form has no test; it passes by reading.
  - **2.** `unstage` now removes the staged packet, the saved full packet and this feature's keep-instructions, and the test asserts all three. It leaves a fold's keep-instructions alone.
  - **7.** The fitter's nonce check matches what the Python read writes (inner text equals the staged bytes).
  - **13.** One build per stage is shared; `anchorLedgerView` still lists U a second time. Accepted.
- **Tracked, accepted: 3, 21, 22.** For 3, `GdprCommands` has no caller outside its own file, so no production path deletes an operator row today.
- **BLOCKER R1 — the per-row placeholder can leave no room for any content, so a mature topic never stages.** Each omitted part now costs a placeholder line of about 94 characters, and its label is repeated in the last section (up to 20). The fixed text is about 2,400 characters. With P parts the empty render is about 2,400 + 94·P, which passes 6,000 at about P = 39. The 20 recent turns, the Anchor and the four derived layers are 25 parts, so about 14 live ledger entries is enough: every trial in the fill loop fails, the delivered variant is oversize, verification fails, nothing is staged and a degradation event fires hourly. Below that count the placeholders still consume most of the budget (about 870 characters left for words at P = 30). The fixture has 12 protected parts, so no test reaches this. Fix: coalesce consecutive omitted parts of a section into one line (count and id range), and drop the repeated label list from the last section when placeholders are present. Add a test with 20 turns of about 400 characters and 20 live ledger entries that must stage, fit the budget, and carry the Anchor and the newest turn.
- **SHOULD-FIX R2 (item 16, partly resolved) — the "agent's last reply" can be a standby or system message.** `lastAgentMessage` takes the newest non-user row from the last 50. The resume path in `server.ts` filters these with `findLastRealMessage` because a presence-proxy line is not an answer. Here such a line would suppress `UNANSWERED` and read as a reply. Apply the same filter.
- **SHOULD-FIX R3 (item 19, raised from a nit) — a NUL byte in a quoted row now loses the whole packet in-band while the marker says it was delivered.** Bash drops NUL in `$(...)`, the fitter's nonce check then fails, the packet text belongs to no known section and is dropped from the fitted block, and `CB_CARRIER` still records the nonce because it greps the unfitted output. Fix: fail verification on a NUL in the delivered text.
- **NIT R4** — `CB_CARRIER` greps the whole seed output, so a quoted delimiter line in a legacy conversation records a packet nonce for a legacy delivery. Match only the line the hook itself prints (its fixed position).
- **NIT R5** — the freshness line counts every `from_user` row after U's newest and calls them operator messages; forwarded or third-party rows over-count. Safe direction.
- **Observation, not a finding** — with protected rows filling first, H1 is usually left out of the delivered variant on a busy topic and reached through the Read line. That is what §9.5 and my item 6 asked for; Claude's own summary stands in for in-flight work.

**Author's resolution of the resolution check:**

- **R1 (blocker), fixed.** Omitted parts now leave ONE line per section: `(left out for size here: N of M: ids…, and K more; all in the full packet)`. The last section lists counts by section, not per-row labels. A new test stages a mature topic and checks that the packet verifies, fits the budget, carries the Anchor (#1), the newest turn (#40) and at least 8 whole operator rows, and has at most 7 placeholder lines. The topic has 40 operator rows of 400 characters, 20 live ledger entries bound to older rows, a 9,000-character H3 and 30 chunks.
- **R2, fixed.** `lastAgentMessage` skips standby and lifecycle lines through the same `isSystemOrProxyMessage` filter the resume path uses (tested with a `🔭` standby line).
- **R3, fixed.** A NUL in the delivered packet fails verification (`unsafe-character`, tested), so the older block is used and the marker records `legacy`.
- **R4, fixed.** The carrier is read by `SEED_CARRIER_PY`, which applies the fitter's own rule: the nonce must be the sha256 of the delimited text, within 6,600 characters. A quoted pair of delimiter lines records `legacy` (tested).
- **R5, recorded.** Over-counts are in the safe direction. <!-- tracked: CMT-1536 -->

**Final check:** concur

Read against the current code. No test was run; the sizes are arithmetic from the string templates. No blocker remains. One should-fix and two nits are left; none of them delivers wrong words.

- **R1 resolved.** `renderPackets` writes at most one placeholder line per section (about 60 to 215 characters, eight ids at most) and the last section lists counts by section. Recomputed: fixed text about 1,530 characters plus about 450 for placeholders on a typical reduced topic, so about 4,000 of the 6,000 carry words, whatever the number of parts. The mature-topic test (40 operator rows, 20 live ledger entries, a 9,000-character H3, 30 chunks) matches that arithmetic.
- **No regression in the verifier from the new line.** `(left out for size here: …)` starts with `(`, so the `forged-quote-frame` pass ignores it, and the freshness regex `^(absent:|\(left out for size)` still matches it as a prefix for an omitted H1 or H2.
- **R2 resolved.** `lastAgentMessage` skips rows that `isSystemOrProxyMessage` flags, including a null text; tested.
- **R3 resolved.** A NUL in the delivered text fails verification as `unsafe-character`; tested. The full file is not checked, which is fine: it is read with the Read tool, not through the shell.
- **R4 resolved.** `SEED_CARRIER_PY` applies the fitter's rule (nonce is the sha256 of the inner text, at most 6,600 UTF-16 units) and has no `"`, `$`, backtick or backslash. The start-line length and slice offsets are right (32 characters, `[20:28]`).
- **SHOULD-FIX F1 — the freshness line can say the packet lists the newest message when that row was left out for size.** `notes.recent` is built before the fill and says "this lists the operator's newest message" whenever U is current. If the newest row is too large for the budget (a long message or pasted artifact), the delivered variant omits it and still prints that line. The placeholder names the first eight omitted ids oldest first, so the newest can fall under "and K more". Fix: word the note as "U is current through #N", and list omitted ids newest first.
- **NIT F2** — `SEED_CARRIER_PY` tries every start line; the fitter tries only the first. They can disagree only when a spoofed pair precedes a fully quoted real packet in a legacy conversation.
- **NIT F3** — the placeholder's id list is bounded by count, not by key length; a ledger key near the store's maximum makes that one line long.

**Author's note on the final check:**

- **F1, fixed.** The recent-section note now reads "the operator corpus is current through #N, the operator's newest message (if it is left out for size below, it is in the full packet)". The recent section's placeholder names omitted turns newest first, and each id in the placeholder is bounded to 40 characters (also F3).
- **F2, recorded.** <!-- tracked: CMT-1536 -->

**Measured on a realistic topic.** The probe staged and seeded a packet through the real stager and the real rendered session-start, compaction-recovery and fitter hooks. Its inputs:
- 31 operator rows sized from the 62 live message lengths of topic 141133 (taken from this machine's TopicMemory; text synthetic);
- 4 ledger entries;
- H1 and H2 at their targets, H3 at 12,000 characters, and 10 chunks;
- a copy of AGENT.md with the real length (27,953 bytes).

Results:
- Full packet: 32,211 characters.
- Delivered: 5,968, reduced, with 6 of 22 protected rows whole; the rest are reached through the Read line.
- Whole hook stdout: 8,968, under 10,000, with the staged packet present byte-for-byte.
- Keep-instructions: 4,790.
This run predates the R1/F1 fixes; the delivered share can only grow with the cheaper placeholders.

---

## Evidence pointers

- Unit: `tests/unit/context-layer-standing-packet.test.ts`, `tests/unit/standing-packet-hook.test.ts`, `tests/unit/migrate-context-budget-standing-packet-row.test.ts`.
- Integration: `tests/integration/context-layer-standing-packet.test.ts`.
- E2E: `tests/e2e/context-layer-standing-packet-alive.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a new feature, not a fix. It adds no self-triggered controller: the debounced restage is a bounded reaction to a layer write, it is not a retry or a respawn, and it emits no notifications beyond the rate-limited degradation report.
