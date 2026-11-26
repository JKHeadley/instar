# Save a waiting app message separately from claiming it

A machine can receive a valid app message while the fleet is deciding which machine should handle it. This checkpoint separates those actions in the receiver. An enrolled message intake machine can store the exact signed message while handover is pending. Acting on it requires a different permission. The holder must be enrolled for that role, match the current generation, and confirm that the device still has access. Repeating a request with the same identifiers and changed content is refused. Retrying the same accepted request can recover the earlier claim without granting a second dispatch.

This checkpoint has no network endpoint or app route attached. It establishes what the receiver must check. Deployment still needs a trusted authority instance and verified handover proof so a restored copy cannot reopen an old generation.
