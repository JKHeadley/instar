---
title: Autonomous run liveness and cadence
description: How the server verifies a bounded autonomous run, accepts work receipts, and evaluates its reporting cadence.
---

The server keeps two related records for a bounded autonomous run. `WindowRunLivenessAuthority` checks that the bound executor is running, its heartbeat is fresh, delivery is reachable, substantive work has advanced, and the admitted lifecycle has not expired. All five checks must pass for the run to be active. A failed check puts the run at risk; a later distinct at-risk episode receives its own recovery deadline. The authority does not infer a healthy run from a message that merely says work is happening.

`WindowRunCadenceExecutor` evaluates the run's work receipts against its scheduled checkpoint intervals and records whether each interval passed or was missed. A receipt is tied to a changed local artifact and a server-bound task reference. The server assigns the receipt sequence, digest, and observation time; clients cannot supply those authority facts.

## Read the current state

Use authenticated `GET /window-run-liveness?topicId=130742` to read the five predicates, status, and latest work receipt for one topic. Use authenticated `GET /window-run-liveness/cadence?topicId=130742` to read its cadence intervals and next checkpoint. An omitted topic ID returns the available status view; a malformed topic ID is rejected.

The server can also run an immediate cadence evaluation with authenticated `POST /window-run-liveness/cadence/tick?topicId=130742`. The background evaluator continues to run independently; the explicit tick is useful when checking a newly submitted receipt.

## Submit completed work

After saving a changed artifact, call authenticated `POST /window-run-liveness/work-advance` with the registered `windowId`, `topicId`, `autonomousRunId`, `lifecycleRunId`, `executorId`, and its `artifactRef`. The artifact must exist within the run's permitted workspace, and the server verifies that its content advanced before issuing a receipt. The response contains the server-issued receipt; a progress message alone does not produce one.

The surrounding monitors have different roles. `AutonomousProgressHeartbeat` can send a sparse observational update when a running agent is quiet but its output has changed. `AutonomousLivenessReconciler` checks for a run that is marked active after its executor has died. `AutonomousThroughputFloor` measures deliverable movement and manager silence without dispatching work or sending messages. `AutonomousSessions` is the read and control layer for autonomous session state and admission; it does not replace the five server-owned liveness predicates.
