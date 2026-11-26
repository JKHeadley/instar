# First-phone ordered enrollment server boundary

The unmounted server handler delegates both confirmation and cancellation to the same witnessed authority. The handler checks the signed challenge against the paired caller supplied by the eventual transport and requires a current local admission and empty approver slot for a new confirmation.

The trusted authority must supply the verified bindings and recheck them where it serializes the decision. The handler accepts only a receipt matching the exact validated operation and returns pending for unavailable or inconsistent authority. A receipt for a previously witnessed exact operation can be recovered after local closure. It conveys no new approval authority.

There is no production composition or endpoint change. The handler never writes a registry record. It gives the planned shared authority integration a boundary to exercise without enabling enrollment or changing existing clients.
