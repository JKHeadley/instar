# A saved change that never finished: finish the last delivery step (plain overview)

**What happened.** Conversations keeps one shared record of efforts and conversations across the owner's machines. When the owner changes something (for example, moves a conversation into a project), the machine that writes the change takes it through steps: save it here, get it certified, give every machine the certificate, give every machine the final proof, and note that delivery is complete. Only then does the dashboard call the change "committed".

On 2026-11-16 at 16:23 Justin tapped "Accept all 21 projects". The first project's move was saved and certified within 15 seconds, and both machines got the certificate. Then the last step, handing the final proof to the other machine, did not complete in that attempt (the other machine answered slowly). From then on the change stayed "saved, pending". Looking at the stored records on the Studio showed twelve more changes stuck at the same point, some for days.

**Why it stayed stuck.** A background pass runs every 15 seconds to finish changes that were interrupted. It only picked up changes that did not have a certificate yet. A change that already had its certificate but had not finished delivery was picked up by nothing. The dashboard's status check only reads; it does not push anything forward. So the first attempt was the only attempt.

**What changes.**
- The 15-second pass now also picks up a certified change whose delivery is not finished.
- For such a change, the writer goes straight to the remaining delivery steps. It does not save, prepare or certify again: a certificate is final, and the delivery steps are safe to repeat.
- A change whose delivery is finished is remembered as finished, so the pass does not re-check it every 15 seconds.

**What stays the same.** What counts as committed, who may write, and every check each machine makes before it accepts a certificate or a proof. Cancelled, erased and imported-history records are left exactly as before.

**What the owner sees.** A change that paused at "saved, waiting" now completes by itself within about 15 seconds once the other machine answers. The thirteen stuck records on the Studio finish on the first passes after the update, which also clears the repeating "local history check not passing" warning that they caused.

**Decision needed.** None. It completes steps the first attempt was already allowed to do; a revert restores the old behaviour and leaves every finished delivery valid.
