# Step 5 — live-proof procedures for the two refs that need an EVENT, not a read

Written BEFORE deployment so neither is improvised under time pressure.

## lane-f (reap-log legibility) — needs a CONTROLLED self-exit
Before (03:23Z): the last 3 self-exit rows carry exitCode=null midWork=null outcome=null.
Procedure, post-deploy + post-restart:
1. Spawn a throwaway headless session whose whole job is to exit cleanly:
   POST /sessions/spawn {"name":"w25-proof-f-clean-exit","prompt":"Reply with the single word DONE and stop.","framework":"codex-cli"}
2. Wait for it to self-exit (≤3 min). Do NOT kill it — a kill writes a `reaped` row, which is the wrong path.
3. Read its row: the LAST line in logs/reap-log.jsonl with session=w25-proof-f-clean-exit and type=exited.
   PASS = exitCode is a number AND midWork is a boolean AND outcome ∈ {completed, stopped-mid-work}.
   For a CLEAN exit expect exitCode=0, midWork=false, outcome=completed (lane-f derives midWork = exitCode !== 0).
   Control: the three pre-deploy rows above are the same path with all three null.
4. Negative arm (do it — it is the must-fail control): a second throwaway that exits non-zero (`exit 3`); its row must carry exitCode=3, midWork=true, outcome=stopped-mid-work. If both arms write the same outcome, the field is decorative.

## lane-a-fix-1 (decision grading) — needs a `wrong` arm EXERCISED
Before (03:23Z): 39 decision points, settled right+wrong over 7d = 0. The grader has never graded.
Procedure, post-deploy + post-restart:
1. Trigger a tone-gate advisory on a harmless message to a scratch topic, then OVERRIDE it with a reason
   (that is what produces a `wrong` grade for the gate — the recorded disagreement).
   Use the relay script's --tone-ack <RULE> --tone-reason "<why>" --tone-decision-ref <ref> flags, per CLAUDE.md.
2. Run one grade pass: POST /decision-quality/grade-pass {}
3. Read: GET /decision-quality?sinceHours=1
   PASS = at least one decision point shows grades.wrong ≥ 1 AND settled > 0.
   Control: the pre-deploy read above (settled = 0 across 39 points) is the same query on the same server.
4. Honest bound: one grade is a proof the INGRESS works (the fix), not that the grader judges well. Say so.

## Both
Record the full request (method, path, query, EVERY header) and the raw response excerpt. LRN-014.
