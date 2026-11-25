# Reply To A Message

This is a design correction, not a released feature or an implementation approval. App message links have moved to a separate change. The quoted-reply design identifies the exact App message you selected; it does not guess from an identifier that several messages might share.

When you choose Reply, the app should make clear which message you are answering. You should not need to copy its words manually, and the app should not accidentally point to a different chat. This change adds a reference to the selected message within the same conversation. The server checks that you can still read that message before accepting the reply.

The original stays separate. Someone who can read your reply does not automatically gain access to a private original. The server checks the original again when showing its preview. If the message is unavailable or the reader no longer has permission, the app can say that the original is unavailable without exposing its words, author or hidden reference. The signed request and machine receipt also bind the reference, so it cannot be changed later while pretending the original signature still proves it.

The reply can open the original through the separate message-link feature when that message remains readable. Opening it must preserve the draft and attached files you are composing. It must never open a different message just because two messages share an identifier.

Older apps may discard the information connecting a reply to its original. We accept that compatibility limit for this first version. When the app knows a message was a quote but cannot verify or find the original, it says "Quoted message unavailable" and keeps the reply itself readable. If an older app removes every sign that it was a quote, the reply can appear as an ordinary message. We cannot honestly promise the unavailable label in that case. This change will not add a separate system to preserve or rebuild quote evidence across older apps.

Telegram and Slack keep their existing conversation and machine routing. A real Telegram reply is made only when the server verifies the physical message and the provider confirms the link. Slack keeps its existing thread and reports exact-message native linkage as unsupported for this increment. The result says this separately from whether your message was sent. Older servers reject the new reply action instead of quietly sending an ordinary message without the selected reference.

The signed record connects the selected original to the exact reply, so someone cannot copy a valid signature onto a different message. All unresolved originals produce the same response without revealing whether a hidden message exists. A request to stop still reaches the existing stop authority before a missing original or signer can block it. After a crash, the server keeps the original send result: it does not invent a missing message or send an uncertain message a second time.

This is the first part of the remaining message actions. Forwarding and deleting one message are still owned work on the same card. They need their own safe handling of source permissions and immutable history. This server increment does not complete those actions or claim that the app controls are released. Full verification, an actual deployed server interaction and the Apple app's native proof are required before calling this part ready for you.


The first server build is off by default. Only the machine that created the conversation can accept a Reply, and only while it still serves that conversation. Another machine can continue taking ordinary messages after a move. A Stop request still stops live work on the current owner, and the server confirms success only after checking that held work is clear. The preview and client controls come in a later update.

The follow-on server build supplies a short preview when the person can still read the original. If access goes away, the server returns an unavailable state without the original text or link. The app needs to finish its live integration checks before people can use Reply.
