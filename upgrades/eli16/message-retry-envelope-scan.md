# Keep the server responsive during message retry checks

The server periodically looks for messages it can retry and messages whose delivery deadline has passed. Previously that check opened every active envelope and read its entire contents, including the message body. A busy machine with thousands of messages could spend enough time doing those reads to delay other requests to the server.

During a retry scan, the server now checks file details in small asynchronous batches. Those details tell it when a file changed, even if another process replaced it with a file of the same size. For an unchanged file, the scan can reuse the few fields it needs, such as which agent the message is for, its delivery phase, and when it expires. A file that disappears is dropped from that in-memory list.

Before acting on a candidate, the retry manager reads the current message and checks that it still matches the message it claimed and is still addressed to the right agent. The current file remains the source of truth for retry, expiry and acknowledgement decisions. The in-memory list is rebuilt when the server starts again. This change requires no change to the way people send messages and no cleanup of stored messages.

A delivered message can stay in the store while it waits for an acknowledgement or reaches its delivery deadline. The retry scan uses the last delivery time and the message type to see when a check is due. This avoids reopening delivered messages such as routine handoffs on every scan. When a deadline is due, the server reads the current file before it records an action.
