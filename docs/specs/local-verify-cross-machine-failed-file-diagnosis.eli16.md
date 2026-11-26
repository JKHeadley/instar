# Cross-machine failed-file diagnosis, in plain language

When a pull request fails its full test run, Echo currently knows which machine saw the failure but may not know whether another machine or the unchanged `main` code would fail the same test. Repeating every test to find out ties up a scarce full-suite slot.

This change would ask one idle verifier machine to run only one to three failed files twice: once on the exact PR merge and once on the exact `main` base. The request has a strict time limit and stops after one attempt. If a machine is busy or the test evidence is incomplete, Echo records an inconclusive answer.

The comparison can suggest that the PR caused the failure, that `main` also fails, or that the machines disagree. It never changes a red PR to green. Only a new complete Local Verify run can permit a merge.

The feature ships off. Echo will first measure which failures are eligible and how much extra machine time a focused comparison would cost, then rehearse on an isolated agent before trying one peer machine. The normal PR record lookup automatically includes the diagnosis, with exact commit hashes and raw observations alongside any plain-language label.
