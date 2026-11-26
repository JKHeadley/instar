# Web chat message actions and scroll integration

The web message actions and the reading-position fix both change how incoming rows are painted. Keep the pre-render scroll check and refresh signed reply previews after rendering incoming rows. Preview-only repaints do not count as new messages.

Reply, Reactions and Forward still depend on the signed conversation capability. Forward requires the same explicit custodian on both rows. The server remains responsible for each write.

The combined chat tests cover the signed action contracts and bottom-follow behavior. Chromium checks at 390 and 1280 pixels cover preserving a reading position, the New messages button and following while caught up. This branch was developed on current main and changes no server flags, storage, migrations or routes.

Rollback is a revert of the combined console change.
