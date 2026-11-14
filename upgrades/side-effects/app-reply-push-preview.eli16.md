# Reply notifications show what I said (plain-English overview)

When I answer you in a conversation inside the Instar iPhone app, your phone gets a notification. Until now it only ever said "New reply", so you had to open the app to see whether it mattered.

Notifications travel through Apple's servers, and we never put your conversations through Apple. So the notification still leaves here saying only "New reply", plus a reference number for the message. When it reaches your phone, a small piece of the app (the notification extension) asks me directly, using a read-only key stored on the phone, for a short preview of that one message, and swaps it in before you see the notification.

The preview is the first 100 characters of my reply, or a short phrase like "sent a photo" or "sent a file: report.pdf", followed by the start of any caption. If the phone can't reach me in time, or the message isn't on the machine it asked yet, the notification just stays "New reply".

The read-only key can fetch these previews and the titles of Attention items, nothing else: it can't read your conversation history or send anything. This is the server half; the phone half ships in the next app build.

The phone also asks with its own signed request (not only the read-only key) when the app is open.
