# Photos, files and voice notes in app conversations, in plain words

## What this is

The Instar iPhone app now has its own conversations with the agent, without Telegram. But so far they carry only text. In Telegram, Justin can already send the agent a photo, a document or a voice note, and the agent gets the file on its machine and can open it. This spec gives the app the same thing, and a little more: videos, files in both directions, and voice notes that are kept instead of thrown away after they are turned into text.

## How sending a file works

The phone sends the file in pieces of one megabyte each. Every piece is signed by the phone's own key, so the agent knows it really came from the paired phone. If the connection drops halfway, the app asks which pieces arrived and sends only the missing ones. Uploads happen while the app is open (or just closed); a closed app cannot sign the pieces, so it does not try. When the last piece arrives, the agent checks that the whole file matches the fingerprint (a SHA-256 hash) the phone announced at the start.

Then the phone sends the message itself: the caption plus the list of files with their fingerprints. The phone signs that message too. That is the important part: the saved message carries proof that the phone signed "this text and exactly these files", so later anyone can check that a stored photo is the one the phone sent.

Limits match what the agent already uses for Telegram: up to 50 MB per file, 64 MB and 10 files per message.

## What the agent sees

The agent's working session gets a line like `[image:/path/to/photo.jpg]`, the same form Telegram photos already use, so the agent needs nothing new to read it. The path points at a private copy, so if the session edits or deletes it, the saved original is untouched. A file name can never pretend to be part of the message's label, because names are cleaned before the agent sees them.

Voice notes are turned into text on the phone itself, using the iPhone's built-in speech recognition. That means voice notes work even on an agent that has only a Claude subscription, and the recording does not have to go to an outside service. The text is part of what the phone signs, and the audio is kept.

The agent can answer with a file too, by adding `--file` to its reply command. It may only send files from its own project folder, its own outbox folder or the temporary folder, and never from places that hold passwords and keys (for example its sign-in folders or SSH keys). A text file containing a live password or key is refused, exactly like a reply that contains one.

## Keeping it safe

- The agent decides what kind of file something is by looking at its first bytes, never by its name. A "photo" that is really a web page is treated as a plain file.
- Files the app could mistake for a web page or a script are always sent back as downloads, with headers that tell the phone never to run them.
- Every download is a signed request from a paired phone that is still allowed. There are no shareable links. A phone that is removed loses access at once.
- Push notifications never contain the file. They say "Echo sent a photo" and the phone fetches the short text itself, so Apple never sees the content.

## Pairing codes in media

If a message's pairing invite or desktop code appears in a caption, a voice-note transcript or a file name, it is removed before the agent sees it, exactly as for typed text, and the saved message says something was removed.

## Several machines

The list of files travels to every machine of the agent with the rest of the conversation. The files themselves are copied between machines in checked one-megabyte pieces, in the background, so that if one machine is down another can still show the photo and answer about it. Until a file has reached a second machine, it lives on one disk only, and the health page says how many files are in that state.

Nothing deletes a file on its own. If the storage limit (20 GB by default) is reached, new uploads are refused with a plain message. Files of conversations Justin has deleted do not count against that limit, and the app's Storage screen lets him permanently remove them with a tap, on every machine at once. The limit is a planning limit, not a hard wall: if the machines lose touch with each other for a while, each one may accept files up to the limit on its own. What really protects the disks is a separate rule: no machine writes a file when its disk is almost full. Copies between the agent's own machines are never stopped by the limit, only by a disk that is really almost full, and then he is told which machine needs space.

Older versions of the agent that do not know about media simply refuse media messages instead of keeping them without their files.

## What it does not do yet


Telegram itself still cannot pass videos to the agent, and sessions still cannot send files back into Telegram or Slack topics. The spec says so plainly; the app's own conversations do not have these gaps.
