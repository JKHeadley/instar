# Keep A Web Chat Message When You Close The Tab

Today the web chat can keep a send waiting while the page stays open, but closing the tab removes that waiting copy. Files have an earlier gap: the composer can clear before the files have uploaded or the waiting message has been saved. A connection failure at that point can lose what you meant to send.

This change saves a protected copy of the message and its selected files on this browser before clearing the draft. When the approved browser reconnects with the dashboard open, it resumes the same uploads and the same message. It does not create a fresh message each time a response is lost. You do not have to reopen the original conversation to resume pending sends.

The copy is only for messages you pressed Send on. This does not keep received chat history for offline reading; that is a separate privacy decision. It also does not send while your browser is closed. Opening the dashboard again is what lets recovery run. If the browser cannot save the message, the draft and files stay in place and it tells you what failed instead of saying the message is safely queued.

The saved copy uses a separate encryption key that stays in this browser. A different browser identity cannot take it over and send it as someone else. Signing out or removing this browser clears its pending copies. Clearing the browser's site data or destroying its profile can also remove them; this is not a remote backup. Already-started delivery cannot be undone by removing a local saved copy.

If the server cannot confirm what happened, the message stays available for review. The app does not silently discard old pending messages or automatically send a second copy with a new identifier. Ordinary server permissions and file limits still apply.

The connection line also becomes more accurate. It says Updating while the current conversation is actually catching up, then clears when those reads finish. A healthy connection check alone will no longer pretend that the conversation has finished updating. Reconnecting keeps the draft you are currently writing.

This is a design under review, not a shipped feature. It requires real browser tests that close and reopen the same profile, interrupt uploads and replies, and check two tabs, sign-out and changed browser access before we call it ready.

A saved exact stop command waits for a new, current Send action, so a stop intended for an earlier session cannot automatically stop a later one. Signing out in this version blocks further queue work before deleting saved content. Supported rollback keeps that cleanup protection and switches automatic draining off; a historical dashboard bundle cannot promise cleanup of this newer queue.

Automatic recovery uses the browser's shared-work coordination feature. A browser without it keeps saved messages and offers an explicit recovery action instead. If an old dashboard version is restored, recovery stays off and a new recovery generation makes every browser profile review its older queue locally before resuming it.
