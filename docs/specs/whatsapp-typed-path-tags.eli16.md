# ELI16: a WhatsApp message can't make the agent open a file it names (SEC-149)

When you send the agent a photo or a document, it reaches the session as a short line like "[image:/path/to/file]", and the session knows to open that file. If someone simply types such a line in a message, it must not work, or they could make the agent read any file on the computer just by naming it.

Telegram, Slack and iMessage already make typed lines like that harmless: the agent rewrites them as "[typed image: ...]", which it reads as ordinary text. WhatsApp messages skipped that step, so someone allowed to message the agent on WhatsApp could type one and the session would treat it as a real file.

Now WhatsApp messages get the same treatment as the other apps. Real WhatsApp photos work as before; a document's placeholder line now shows as typed text, since its file name comes from the sender. The sender's WhatsApp name is cleaned the same way, so a name can't be used to sneak such a line in either.

After its first full test run, the cleanup moved into a small helper of its own, so older checks that read the start of the WhatsApp code still find what they look for. Nothing it does changed.
