# "Files are turned off" now comes with a button to turn them on

## What happened

Justin sent a photo and a voice note from the Instar iPhone app. Under them, the app said "Files are turned off on this agent." That was all: no link, no button, nothing he could tap. The only way to fix it was to ask the agent to edit its configuration file, which is exactly the dead end our rule against warnings without a path to act is meant to prevent.

## What changes

When the agent refuses a file because files are off, its answer now includes a ready-made action: "Turn on files". The app shows that as a button right under the refused message. Tapping it asks for Face ID, then turns files on for the whole agent, on every machine it runs on. Each machine that changed restarts itself to pick up the setting. Then the app sends the photo or voice note again on its own.

This uses a switch the app already has. The People screen already turns team settings (memory privacy, app conversations) on for the whole agent with one Face ID tap. Files is now a third setting that switch accepts. So there is no new kind of permission, no new way to edit configuration, and the same protections apply: only the owner's phone, only with Face ID, and only ever turning things on.

Sending a file into a Telegram or Slack conversation from the app used to say "not available yet" when files were simply turned off. That was not true. It now says files are turned off, with the same button.

## The second problem in the same report

After a text message was delivered, the message box still held the same text. The app already cleared the box after sending. But the iPhone keyboard (or dictation) can write the old text back a moment later. The app now replaces the message box with a fresh one after each send, so the old text has nowhere to come back from. It also checks again over the next few seconds.

## What to decide

Nothing. This is a small, reversible fix: undoing it removes the button, and any machine where files were turned on keeps them on, the same as if someone had edited its configuration by hand.
