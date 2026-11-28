---
title: Explain A Held Telegram Reply
requires: telegram
---
When a Telegram reply is held for credential capacity, inspect the original operation and its actual attempts instead of sending another copy. The existing operator-authorized `GET /telegram/origins/<originId>` readback includes optional `capacityEvidence`: the observed reserve or consume cause, stage and timing, separate from the unchanged retry-scheduling reason. A lost local-socket reply means the owner's answer is unknown; it does not prove the owner refused. `capacityEvidenceStatus: unavailable` means attribution storage failed while the original outcome was preserved; `legacy-or-not-reached` means no diagnostic evidence is available. Existing archives may omit new evidence after rollback. Pending or uncertain acceptance never authorizes a manual resend. Let the existing recovery own the original operation, and use actual cause evidence before proposing a capacity-policy change.
