# Capture the Work Board starting history

Use the next approved Echo restart window. Keep permission-slip enrollment off throughout. Chief owns the window and rollback decision, Throughput owns per-host receipts and replication verification, and Identity compares the captures. This is a capture and rehearsal, with no enrollment state writes.

## Fleet roster

The November 25 registry lists the five active machine IDs below. Before the window, Throughput resolves each ID to its actual host, service and agent home, records its running package revision and restart supervisor, and confirms the accepted roster against current membership. Two rows named Echo require ID-based matching. An offline or ambiguous active machine blocks a verified capture unless the existing membership authority has formally excluded it beforehand.

| Registry label and role | Machine ID |
| --- | --- |
| mac-studio, awake | `m_9a4a7b7338e7e5aebeda73c0e853ae4c` |
| echo, awake | `m_cc2ec651a91f03f85abb19bfe5e7e8f7` |
| Mac Mini, awake | `m_4cbc0d4a0c557cf7e221882f9b42518f` |
| echo, standby | `m_e8c9b243c449b1337713bc29d47a6f3a` |
| mac-lan, standby | `m_a804869356b259820b3236e7c5a2ae7d` |

## Verify the owner receipt before pausing

On each registered home, run the command using the existing local agent environment and its configured API port. Keep credentials out of commands and receipts.

```sh
node scripts/read-work-board-owner-receipt.mjs "$AGENT_PORT" > "$EVIDENCE_DIR/$MACHINE_ID.team-owner.before.json"
```

Every command must succeed and report a healthy, gap-free verified owner. Compare owner key, heads and vector across the accepted homes and repeat after the capture into `$MACHINE_ID.team-owner.after.json`. A missing endpoint, unopened log or mismatched receipt keeps every writer live and requires a rescheduled window. This evidence describes the verified Team Access owner and does not assign a Work Board enrollment generation.

## Pause and drain

1. Record the current membership revision, owner generation, time, host, state directory, normal supervisor, all service and auxiliary processes with access to that home, and their package revisions. Record the original `workBoard.enabled` value or key absence. Keep the rest of the configuration out of the receipt.
2. Atomically edit `$AGENT_STATE_DIR/config.json` in each accepted home and set the JSON field `workBoard.enabled` explicitly to `false`. Preserve every sibling field and file permissions. Serialize this with other config edits. Wait for every live process to observe it. This pauses console, phone and agent Work Board mutations plus pickup. Keep journal replication and team authentication running for catch-up. On every revision, wait for actions already admitted before the pause, including pickup or dispatch, to finish or be quiesced by the supervisor. The live fence blocks new dispatch calls and cannot cancel one already in progress.
3. For a build without the live sender fence, drain and stop its pre-pause process through its normal supervisor. Start the paused configuration through that same supervisor. For homes managed through the Instar CLI, use `instar server restart -d "$AGENT_HOME"` from a host shell outside any Echo session. Throughput records the equivalent existing supervisor command for each other home before the window. Startup with `workBoard.enabled=false` skips Work Board runtime construction on the checked legacy revision. The local compiled fixture verified the old predicate and its startup branch condition. The actual supervisor receipts from this window establish that each production process loaded that setting. Stop any additional process that can open the home. Keep its launcher stopped during the capture. Do not count an advisory version advert, a standby label, or a lock file alone as process exclusion.
4. Record pre-pause and paused process IDs, boot times, installed revisions, effective setting, and a read-only Work Board availability probe. Evidence must show the write surfaces unavailable and no old override or alternate launcher still attached. Throughput records the last durable `work-card-record` advert from each source, consisting of source ID, incarnation and sequence.
5. Keep replication on until every accepted receiver has reached the frozen source heads. Take two consecutive complete sync observations enclosing a normal sync interval. Source heads must be unchanged, held heads must equal the advertised incarnation and sequence, and no relevant stream may be behind, gapped, suspect or reset-flapping. Any unknown head, changed roster, changed owner generation or new writer voids capture.

## Capture and verify

Run the following locally on every accepted home while it is paused, using the reviewed candidate compiled output and the independently observed durable local sequence. Write the receipt to a private evidence directory. The command prints metadata, hashes and counts only.

```sh
node scripts/capture-work-board-starting-history.mjs "$AGENT_STATE_DIR" "$MACHINE_ID" "$CANDIDATE_DIST" "$DURABLE_LOCAL_SEQ" > "$EVIDENCE_DIR/$MACHINE_ID.work-board.json"
```

Throughput saves the accepted roster and independently observed frozen heads into a private JSON manifest with fields `roster` (array of accepted machine IDs) and `heads` (map from each accepted ID to its `incarnation` and integer `lastSeq`). Identity compares the collected receipts before the hard stop.

```sh
node scripts/compare-work-board-capture.mjs "$FROZEN_MANIFEST" "$EVIDENCE_DIR"
```

The comparator checks all projection digests, each origin's count and digest, both owner observations, and each local incarnation and sequence against the frozen advert. A matching result describes the supplied receipts. Chief and Throughput still verify roster provenance, sender exclusion, and both sync observations independently. Keep the compare result, process exclusion receipts and sync heads with the capture time and revisions. A verified empty projection is a distinct receipt. An unreadable stream or missing receipt fails the window. Treat a resumed write as invalidating this snapshot for activation. Retain it as rehearsal evidence and take a fresh capture at the actual enrollment cutover.

## Resume and rollback

On success, timeout, or mismatch, restore each home's exact pre-window value or remove the temporary key if it was absent. Use the planned restart supervisor to start the original service posture and verify there is only one intended service instance per home. Confirm normal service health, Work Board availability at the original owner entry point, and advancing journal synchronization. Keep permission slips disabled. Throughput records restoration, supervisor status, health and resumed sync heads. Escalate any home that cannot resume cleanly to Chief immediately. Do not leave half the fleet paused while diagnosing a capture mismatch.
