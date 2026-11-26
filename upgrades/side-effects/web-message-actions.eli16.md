# Message actions in the web console

The message menu can offer Reply, React, and Forward on supported App conversations. Reply puts the selected message above the composer so you can see what you are answering. If the server can no longer use that original, the web console keeps your draft and lets you remove the quote yourself.

React reads your current reaction and lets you choose a new one or clear it. Forward copies a supported text message to another eligible App conversation. You pick the destination before anything is sent. When a forward could not be confirmed, the retry keeps the original message, destination and request together so it can check the same action.

Each action appears only when the server says the signed browser can use it. The server still checks each write separately. The controls stay hidden on older servers. Forward also stays hidden until the server supplies a capability that identifies where both conversations can be served.
