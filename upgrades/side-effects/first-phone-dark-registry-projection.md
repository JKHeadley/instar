# Disposable first-phone registry projection

This test entry point writes only the disposable registry projection table. It runs the live witness floor comparison, receipt check, exact slot check and first-write deduplication inside one immediate SQLite transaction. The caller must supply the independently verified current authority snapshot. The projected bytes must have the digest that the accepted decision bound. A retry can recover the same write while that exact fence is current. A handover that wins first leaves the projection pending.

The test database uses synthetic keys and no real enrolled device. This change adds no serving route, permissions, or production DeviceRegistry write. A production composition would independently verify custody and current floor, and serialize the normal device registry write through an equivalent boundary. Restoring both the fixture database and its supposed authority source together would require independent rollback evidence that this checkpoint does not claim.

Any intervening floor advance also leaves publication pending. Recovery after unrelated advancement or publishing a later slot generation requires a separate protocol.
