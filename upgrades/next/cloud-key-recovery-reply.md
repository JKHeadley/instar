<!-- bump: patch -->

## What Changed

After a rejected Claude sign-in key is fixed, every conversation that was waiting now gets a real answer. Each restarted conversation is given the messages that arrived during the outage and the exact command to reply. When messages were held, a restart counts as done only once a reply shows up; if none does within 15 minutes, the person is asked to send again and the miss is reported. With nothing held, nobody is asked. The check is per conversation: it confirms a reply, not that each held message got its own answer. Telegram is covered by tests; only Slack has been proven live so far. `slack-reply.sh` in a bound Slack session now ignores a channel id passed out of habit. Before, it posted that id as the message and dropped the real reply. The operator warning counts as delivered only when a person can read it: if the Slack alert channel has none of the agent's people in it, each of them gets a direct message.

## What to Tell Your User

If my sign-in key stops working and you fix it, I'll answer what you sent while I was down. If no answer comes, I'll ask you to send it again. Warnings about my key now reach you directly, even if you never joined my alert channel.

## Summary of New Capabilities

No new commands. Key-outage recovery now answers held messages, checks that it did, and reaches the operator directly when the alert channel has no readers.

## Evidence

Found in the 2026-11-04 nimbus bad-key drill: two restarted sessions posted their channel id, and one person's two messages were never answered while the session reported done. `tests/unit/slack-reply-session-channel-arg.test.ts` runs the real script and fails on the previous version.
