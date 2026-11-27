# Plain overview: phone photos in Telegram, and the Delivered mark

When you send a photo from the Instar iPhone app into a Telegram chat, the agent gets it and also posts a copy into the Telegram chat, so the conversation reads the same in both places. iPhone screenshots shared from the Photos app are often in Apple's HEIC format. Telegram refuses HEIC when it is sent as a "photo", so the copy silently failed and only a warning landed in the agent's log. Now any picture or video Telegram would refuse as a photo is sent as a file instead. It still appears in the chat, and anyone can open it.

The second fix is about the small "Delivered" mark under a message you send. In the app's own conversations it already showed once the agent had the message. In a Telegram conversation it never showed, because the history the app reads for Telegram chats did not carry that fact. You saw your message without the mark and reasonably thought it hadn't gone through. Now the history includes it, so the mark appears there too.

Nothing else changes. The message itself always reached the agent; these fixes are about what you see.
