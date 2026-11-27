---
title: Moving a conversation mid-step
---
Moving a conversation to another machine (`POST /pool/transfer`, or "move this to <machine>") waits about 30 seconds for the running session to finish its step, then closes it. If you move the conversation you are serving while you are still working, your session is closed before it finishes. The machine it moved to then restarts the conversation with the recent messages and a note starting `[system] This conversation just moved to this machine`, and tells the person it is picking the step back up. When you receive that note, check what was already done so nothing runs twice, finish the request, and reply with the result.
