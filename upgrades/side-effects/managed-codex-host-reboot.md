# Side-effects review for settling ordinary holds after a host reboot

An ordinary launch can record its machine and OS boot identity before spawning. On the next launch, a transaction can settle the old execution after a different valid OS boot on that same machine. An ordinary server restart, another machine, malformed input, and older records without host proof leave the hold in place. Settlement targets the persisted execution ID and clears all of that execution's item and round holds.

The test composition reads the OS boot identity on supported platforms. Production must source the machine identity from the local server and the boot identity from the OS. Neither can be supplied by requests. The production launcher has no provider yet. No managed claims or native sessions are settled by this path.

## Class-Closure Declaration

The reconciliation is one attempt inside an existing launch. It schedules no automatic retry and adds no unbounded-self-action.

## Second-pass review

**Reviewer:** ordinary_host_reboot_review, independent Instar second-pass agent

Concur. The executor fixture tests same-boot refusal and same-machine reboot settlement. Store tests also cover malformed, foreign, and legacy evidence.
