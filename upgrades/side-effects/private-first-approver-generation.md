# Private nomination first-approver generation check

The dormant private Accept matcher requires the offer to name the same first-approver record key as the current eligible slot. A moved generation or an unavailable slot refuses both new and repeated captures. Tests exercise the initial zero generation, a later generation and an unavailable slot with the real nomination store.

The matching code does not consume a nomination or record a device acceptance. The live holder still needs to derive the current slot from the verified trust store and enforce it again at the final device acceptance.

Independent review concurred on the exact generation and retry checks.
