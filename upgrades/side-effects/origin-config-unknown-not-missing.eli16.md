# Why bug-topic messages from Mama PC failed, in plain words

Every few seconds, each machine re-reads its own settings file so it knows where to send Telegram messages. Bug topics live in a separate Telegram group, and the settings say which one.

Mama PC sometimes gets so busy that its server freezes for 10 to 30 seconds. When that happens, the settings read takes longer than its 2-second limit and is thrown away. The code then behaved as if the settings had no bug group at all, and refused messages to bug topics with "no messaging config issuesChatId". That was false: the setting was there the whole time.

Those refused messages were saved for a retry. But the retry step only trusts a small set of "definitely not sent" answers, and this refusal was not one of them. So it marked them "may already be delivered" and never sent them. They were lost without anyone being told.

After this change:
- If the settings can't be read, the refusal says so honestly ("could not read config", with the reason), and it is marked as safe to retry.
- The retry step recognises this refusal, and the old misleading one, as "definitely not sent", so the message goes out once the settings read again. It still passes the usual tone check and duplicate check, and it still expires after 6 hours.
- The server log now says why a settings read failed, so the next time this happens the cause is written down.

Nothing changes about the safety rule that a bug-topic message is never sent to the main group by mistake.

Why Mama PC freezes is a separate problem and is reported on its own.
