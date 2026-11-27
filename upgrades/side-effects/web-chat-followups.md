# Web chat message actions and scroll integration

The web message actions and the reading-position fix both change how incoming rows are painted. Keep the pre-render scroll check and refresh signed reply previews after rendering incoming rows. Preview-only repaints do not count as new messages.

Reply, Reactions and Forward still depend on the signed conversation capability. Forward requires the same explicit custodian on both rows. The server remains responsible for each write.

The combined chat tests cover the signed action contracts and bottom-follow behavior. Chromium checks at 390 and 1280 pixels cover preserving a reading position, the New messages button and following while caught up. This branch was developed on current main and changes no server flags, storage, migrations or routes.

Rollback is a revert of the combined console change.

## Merge with main's durable outbox (2026-11-27)

Main replaced the web chat send path with the encrypted durable outbox (PR 3722), removing saveUnfinished, deliver, uploadAll, finishLocal, sendOutcome and sendPath, which this change's quoted send used. Decision A (PR owner, Dashboard, 2026-11-27): every send keeps main's outbox and confirmed-send behaviour; the Reply action and quote preview stay dormant behind the reply capability, which no server sets today; a quoted send that is somehow selected keeps the draft and shows "Quoted reply is unavailable. You can keep your draft or remove the quote.", sending nothing. The never-called quoted-send recovery control was removed. sendPath was restored for the reply-preview, reaction and forward actions, identical to main's inline chat route. Quoted sends return with outbox replyTo support alongside PR 3818.

## Second-pass review

**Reviewer:** independent Claude sub-agent, fresh context, not the author of the merge (Parity session, 2026-11-27 07:18-07:20 PT)

Verdict CONCUR. Confirmed: no reference to a removed helper remains; the merged send handler is main's line for line plus the guard, which runs after the admitting check and before admitting is set, so it cannot leave the button disabled; send(), syncPending and paintPendingSends match main; sendPath matches main's inline path; reply, reactions and forward stay dormant because no server code sets messageActions; no test from either side was dropped (the quoted-send test was rewritten to decision A). Optional tidy-ups taken: the dead quoted-send recovery control removed, and a stale scrollToEnd argument dropped. Unit run on the merged tree: tests/unit/console-chats-page.test.ts 57 of 57.
