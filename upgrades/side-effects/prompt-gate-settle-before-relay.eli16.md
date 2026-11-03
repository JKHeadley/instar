# Prompt Gate waits before telling you about a prompt (plain-English overview)

When one of my sessions stops at a question on its screen (a yes/no confirmation, a menu), a part of Instar called Prompt Gate copies that question to your Telegram topic so you can answer it from your phone. Until now it did that the instant it saw the question.

The trouble is that many of those questions get answered without you. When a session hits its account's usage limit, Instar moves it to another account; when Claude Code asks a low-level permission question, a safety floor answers it; sometimes the session is simply restarted. In each case you still got a message asking you to choose, about something that no longer needed you. On 2 November that happened twice in one minute, plus a separate notice saying "Prompt Gate is now active".

What changes: after seeing a question, Prompt Gate now waits 45 seconds and looks at the session's screen again. If the question is still there, you get the message as before. If it's gone, or the session no longer exists, nothing is sent. If the screen can't be read, it sends anyway, so a question that really needs you is never dropped. The "now active" notice becomes one short line on the first real question instead of its own message.

What you might notice: fewer of these messages, and a real one arrives about 45 seconds after the question appears. The wait can be changed or switched off with one setting.

If the screen check itself fails, that counts as "can't tell", and the message is sent.
