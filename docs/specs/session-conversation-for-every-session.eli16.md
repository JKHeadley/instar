# A native conversation for every session — the short version

When you start a new session from the dashboard or the phone, you pick where it talks to you: a Telegram topic, Slack, or "No chat (terminal only)". A terminal-only session has no conversation. You can only type to it in its terminal, and you can't change its engine, model or machine. If the agent has no Telegram and no Slack, every new session ended up that way.

Justin asked that every session have a native Instar conversation by default. This part adds a fourth choice, "Instar app conversation". The agent creates a new conversation in the Instar app, named after the session, and starts the session attached to it. From then on you talk to it in the app like any other conversation, and part 1's engine and model switching works on it. You can also pick its engine and model when you create it, as you could for a Telegram topic.

When the agent has no Telegram and no Slack, this is the default instead of terminal-only. Terminal-only is still there if you pick it.

Two kinds of session don't get one. Scheduled jobs and the agent's own helper sessions are machinery, and one conversation per run would flood your conversation list. Sessions already running with no conversation also stay as they are, because a running session can't be attached to a conversation after it starts.

The session itself starts only on the machine that runs your app conversations. If you start one from another of your machines, the conversation is still created and shows up everywhere, and its first message starts the session on the right machine. It never quietly falls back to terminal-only. Moving a conversation to another machine is part 3.

Two safety details. The new session's memory privacy is set up before it starts, exactly as if a message had arrived, so it doesn't run in the wrong memory scope and get replaced by its own first message. Tapping Create twice makes one conversation, not two.

One fix along the way: the sessions lists used to hide sessions for app conversations as "internal" helpers, because they have no Telegram or Slack chat. They now always show.

What you need to decide: nothing.
