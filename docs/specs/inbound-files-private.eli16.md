# ELI16: long WhatsApp, iMessage and Slack messages are kept private (SEC-138)

When a WhatsApp or iMessage message is longer than about 500 characters, the agent does not type the whole thing into the session. It saves the message to a file and types a short line telling the session to read that file.

Slack does the same, and also saves a file with the recent conversation for the session to read. Those files used to go into shared folders that every account on the computer can see. On a Mac with more than one account, another account could read the messages and Slack conversations there. It could also make that folder before the agent did, then swap a file for its own between the moment the agent saved it and the moment the session read it. The session would then read words the real sender never wrote, under the real sender's label.

Now these files go into the agent's own folder inside its project, in the same place long Telegram messages already go. The folder and each file can only be opened by the account the agent runs as. Each file is created fresh with a random part in its name, so nothing can be planted in its place. Old files are tidied away after about a week, checked every day. Nothing changes in what the session sees, except the folder named in the short line.
