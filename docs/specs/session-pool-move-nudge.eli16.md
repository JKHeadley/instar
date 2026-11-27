# A moved conversation's new owner hears about it in seconds

When a conversation moves from one machine to another, the old machine writes down "this now belongs to machine T". The other machines only find out when they next check for news, which happens every 30 seconds and can be held up by one slow machine. We measured waits from 28 seconds to over 3 minutes. Nothing gets lost in that time, because a message waits safely in a queue, but the person waits too.

This adds a short signal. Right after a move lands, the old machine tells the new owner and the machine that routes messages: "check with me now." Those machines fetch just the ownership news from the old machine, update their view, and release any waiting message.

The signal carries no ownership information of its own. The machines still believe only the same signed records they would have read anyway, a little later. So it cannot change who owns anything, and if a signal goes missing, everything works as it does today.
