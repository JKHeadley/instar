# First-phone holder attempt lifecycle

The dark lifecycle holds one local admission window for the exact Face ID challenge and holder incarnation. It asks the authority to reserve that opening only after predecessor reconciliation. At the local monotonic cutoff it closes admission before sending the same deterministic cancellation operation on every retry. Pending cancellation leaves admission closed. An exact accepted receipt keeps the lifecycle closed and cannot be undone by cancellation.

Holder loss closes local admission. An old holder never issues a new cancellation after it observes it lost authority. A successor must rely on independently reconciled durable history before opening anything. Local state is neither a durable journal nor a trusted wall-clock deadline.

The unit fixture exercises these boundaries using a fake reservation port and clock. The module remains unmounted and adds no routes, registry writes, credentials or runtime setting. It is removable without any data migration.
