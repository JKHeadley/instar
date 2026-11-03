# Slack files in the Instar app, explained simply

The Instar iPhone app can show the operator's Slack conversations with the agent, but until now only the words. When someone sent a photo or a document in Slack, the agent got the file, yet the app could not show it, and the history it got back even contained the place on the computer where the file was saved, which a phone should never see. The Telegram version of this was fixed in the previous change; this change does the same for Slack.

When the "files in app conversations" switch is on, each photo, document or transcribed voice note that arrives in a Slack message is also copied into the app's file store, with a small record saying "this Slack message in this conversation had this file". If one message carries several files, each one gets its own record, in order. The record goes under the same name the app already uses for that Slack conversation, so the app finds it when it reads the conversation's history. The record is copied to the agent's other machines, which fetch the file too.

Slack conversations have a quirk: their short numbers only mean something on the machine that created them. So to download a file, the phone names the conversation by its full Slack name (which the history read now hands back), and a machine only serves it if it is the machine that holds that conversation and the file really was recorded in it. A phone cannot use one conversation to reach another conversation's files.

The copy follows the same safety rules as before: refused when the store is full, the disk is nearly full, or the file is over 50 MB. If it fails, the agent still gets the Slack message exactly as before, and the problem is reported. A text file whose content is pasted straight into the message is not copied, because its words are already there.

Finally, the phone never sees a file path in a Slack conversation: it sees "[photo]" or "[file: report.pdf]". Turning the switch off stops new copies at the next restart.
