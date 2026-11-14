# Window run liveness: give a later outage its own observation clock

An autonomous run has five checks that must all be healthy before it can be active. If one fails, the run becomes at-risk and the system may make one bounded recovery attempt. A brief delivery outage in a live Echo run triggered that recovery. The executor was busy, so the system correctly left its work alone and returned the run to active after the checks were green. The first recovery attempt and its 15-minute deadline stayed in the record, as they should for the one-attempt audit.

More than 15 minutes later, an unrelated heartbeat check briefly became stale. The run immediately failed because the code compared the new outage with the old, expired recovery deadline. This happened twice during the quota work, so the operator lost the autonomous run despite ongoing work and recent work receipts.

The change keeps the one-attempt rule: it never asks the executor to refresh a second time. After an earlier recovery has actually returned the run to active, a later loss starts a new at-risk observation period. The run can become active again if all five checks recover within 15 minutes. If they do not, it fails at that new deadline. A loss that never recovered from the original attempt still uses the original deadline; the change gives it no extra time. Terminal windows remain terminal, and no stored record format changes.

Unit tests cover both a successful refresh and a busy executor, including the new deadline, healing, and no second refresh. An authenticated HTTP test and a production-boot lifecycle test exercise the same behavior through the server routes. If the change is wrong, a patch revert restores the prior behavior without migrating state. The operator needs no new control or setting.
