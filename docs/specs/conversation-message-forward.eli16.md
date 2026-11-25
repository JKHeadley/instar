# Forward a message into another App chat

The first version lets someone choose a text message, pick a different App chat and make a copy there. The destination chat labels the copy as forwarded. People who can read the destination can read the copy. Their access to the original chat follows the same permission rules as before.

The server checks that you can read the original and send to the destination. If the response is lost, the app can retry the same request on the same paired machine. The server returns the existing copy when it can prove it was saved. If it cannot tell whether the copy was saved, the app can show that outcome without creating a second copy.

A forwarded message appears in chat history. It does not wake the agent or become part of the agent's next session context. Someone can forward a message that contains the word “Stop” without issuing a Stop command. The first version accepts text, and the feature starts off while the server and app are being tested together.
