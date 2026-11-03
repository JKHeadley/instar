## What Changed

- Slack conversations from the Instar iPhone app (native conversations increment 4). Where Slack is set up, the app's conversation list also shows Slack channels and threads, the phone can read their history, and a message typed in the app reaches the agent's Slack session exactly like a Slack message from the operator.
- Each message sent from the app into Slack is saved first, with the phone's signature and this machine's signed receipt (a new receipt version that also names the Slack conversation), so history can show whether it really came from the paired phone.
- A copy "📱 <owner> (from the app): …" is posted into the Slack channel or thread, with anything that looks like a password or key hidden.
- The agent's own Slack replies are now kept in the Slack message log, so the app shows both sides of the conversation.
- New optional setting `mobilePairing.slackOwnerUserId`: the operator's Slack user id. Until it is set, the app shows no Slack conversations. The agent proposes it and sets it only after the operator agrees.
- Existing agents get a new CLAUDE.md section about this on update.

## What to Tell Your User

You can now continue your Slack conversations from the Instar app. First I need to know which Slack account is yours: ask me to "link my Slack to the app" and I will propose your Slack user id for you to confirm. After that, your Slack channels show up in the app's conversation list, and what you type there reaches me as if you had typed it in Slack, with a copy posted in the channel so others see it. The app itself needs its next update to show the Slack rows.

## Evidence

- Unit tests: a Slack record verifies with the new receipt and fails when it is moved to another conversation, carries an old-style receipt, or was signed for another path; the store keeps the new receipt fields; the Slack bridge reads one channel or thread from the log and the in-memory history, and dispatches as the operator in the right thread; the CLAUDE.md section is added once.
- Integration tests (stub Slack adapter, real registry, request store and device signatures): list with and without the owner id, history merging Slack rows and app-sent rows, a send stored first and read back "verified", retry replay, refusals before anything is saved, a failed dispatch, a failed mirror, an emergency stop over the rate limit, invite removal, and recovery after the Slack log rotates.
- End-to-end test: a server built on the production path with a stub Slack adapter pairs a phone on the dashboard, lists the Slack channel, sends into it, the server's Slack dispatch receives it as the operator tagged signed, the mirror is posted, the agent's reply is logged, and the phone's history shows both.

## Summary of New Capabilities

- Continue Slack conversations from the Instar app (list, history, send), with signed records and a copy in the channel. Dev-gated with native app conversations (`mobilePairing.native.enabled`); needs `mobilePairing.slackOwnerUserId`.
