# Old delivery records should not restart a conversation

A background scan checks replies whose delivery is unresolved. It can find many old replies in topics where nobody is talking anymore. Previously, each record could produce another message saying an earlier reply was delayed or lost. Restarting the server could repeat this work across dozens of topics. These notices are background bookkeeping, and seeing an old record does not mean someone just asked for another update.

The general Quiet by Default gate already prevents these notices when enforcement is enabled. Tests against its real delivery path confirm that. During observation, or when that feature is disabled, it intentionally lets messages through, so it cannot be the only protection against this historical scan.

This change gives the scan a record-only path. It still updates the durable Attention record, including whether an original reply is delayed, uncertain, or failed. It never posts a message into the old topic or the Attention hub. When Telegram confirms the original reply, the record closes quietly with an accurate explanation. The record survives a server restart.

A failure observed during a session's original local send retains the existing notice behavior and the existing notification and tone policies. Background retries and reporting by another machine that holds the delivery credential also remain record-only. They cannot borrow notice permission from an old session record. The source session still receives its normal delivery result. Original replies keep their existing delivery and recovery paths. There is no guess about topic activity, no new time window, and no change to operator notification preferences. Reverting the code restores the previous behavior; no state conversion is needed.

Receipt confirmation follows the same local-only rule whether a recovered answer arrived quickly or after a long delay. It still enters conversation history, and closing its delivery record never posts a status line or closes a legacy forum topic.
