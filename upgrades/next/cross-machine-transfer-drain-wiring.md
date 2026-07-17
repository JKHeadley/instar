## What Changed

Cross-machine topic transfer now connects the existing remote-owner drain transport to the production server routes. The drain response also carries direct proof that the fenced target ownership claim landed, so `seatMoved` remains honest while the router's replicated ownership view is still catching up.
When the current owner is remote, the holder now checks that owner's live autonomous-run state before authorizing the move, preserving the confirmation gate across machine boundaries and accurately reporting run suspension.
Confirmation is bound to the exact owner epoch, target, and run conditions shown in the prompt; changed conditions require a fresh confirmation.
After a completed move, the destination now starts its working-set pull automatically, including across normal ownership-replication lag.

## What to Tell Your User

Moving an active topic between your machines now completes through the current owner instead of leaving a permanent pending pin. The transfer response confirms the move from the owner-side claim rather than briefly reporting failure during normal replication lag.

## Summary of New Capabilities

- Production `/pool/transfer` can invoke the already-built local or remote drain sender.
- A successful drain distinguishes “turn drained” from “target claim actually landed.”
- Immediate transfer responses remain honest without weakening ownership fencing.
- Active autonomous work cannot be moved across a holder/owner split without the existing explicit confirmation.
