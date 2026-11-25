# Message Actions In App Conversations

When you select a message, the app should let you reply to it, react to it, forward it, delete it where you have permission, or copy a link that reopens it. A copied link still requires permission to read the message. A forward checks both chats before it sends a copy.

The work starts with opening the exact message and carrying that selection into a reply. Reactions, forwarding and deletion each have their own checks, including what happens if Telegram cannot confirm the same action. The app will only offer each new action after the server and client agree on what it can do.
