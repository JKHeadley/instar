# Telegram files in the Instar app, explained simply

The Instar iPhone app can already show the operator's Telegram conversations with the agent. Until now it could only show the words. When someone sent a photo, a document or a voice note in a Telegram topic, the agent got the file, but the app had no way to show it, and the history it got back even contained the place on the computer where the file was saved, which a phone should never see.

This change fixes both. When the "files in app conversations" switch is on, each photo, document or voice note that arrives in a Telegram topic is also copied into the same file store the app already uses for its own conversations. A small record is written that says "message 77 in topic 42 had this file", and that record is copied to the agent's other machines, which then fetch the file itself too. The app can now ask for a topic's history and see the file listed with that message, and download it. It can only download a file through a topic if that file was really recorded in that topic, so a phone cannot go fishing for other files.

The copy follows the same safety rules as the files the agent sends back: it is refused if the store is full, if the computer is nearly out of disk space, or if the file is larger than 50 MB. A voice note is copied before the Telegram code deletes its temporary download. If the copy fails for any reason, nothing changes for the agent: it still gets the Telegram message exactly as before, and the problem is reported so someone can look at it.

Finally, the phone never sees a file path again. Where the history used to say "[image:/Users/.../photo.jpg]", the phone now sees "[photo]", "[file: report.pdf]" or "[voice note]". The agent's own view of the history is unchanged.

If anything goes wrong, turning the switch off stops new copies at the next restart and makes the app's download route unavailable.
