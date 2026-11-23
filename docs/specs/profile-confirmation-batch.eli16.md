# Move Several Conversations With One Answer

Today, moving several conversations can mean answering a separate question for each one. This change lets the agent prepare one clear question that lists every conversation and explains what will change. You can reply yes to that question once. The server checks the whole list before saving anything, so an invalid item does not leave half the conversations changed.

The safeguards stay familiar. Only the verified owner's exact yes, sent as a reply to the actual question, can approve it. A numbered answer such as “1) yes” applies nothing. The agent can send one useful reminder, but cannot interpret those words as permission. Other messages do not cancel your question, and it keeps the long deadline already supplied by the earlier repair.

After saving, the server sends one plain result for the whole list. Saving a preference and restarting a conversation are different steps. If a restart is still pending or could not be verified, the result says so. A newer change or a replacement running session prevents an older request from restarting the wrong conversation.

Keeping unanswered questions available after a server restart is separate work immediately after this slice. This change does not claim that recovery is finished. It also does not prove Slack or App consent: the real-user exercise for this slice uses the existing Telegram demo group. The project already authorizes this work. The design must pass independent review and the implementation must pass the normal verification queue before it can merge.
