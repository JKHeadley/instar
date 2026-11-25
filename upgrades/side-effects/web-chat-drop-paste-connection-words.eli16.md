# Dropping and pasting files into a web chat, and Telegram's connection words (ELI16)

## What was wrong

Justin wants Telegram to be the floor for chatting with an agent in every Instar app. He named three things first: speed, dragging media in, and weak networks. On the web dashboard's Conversations page, the only way to send a file was the Attach button. You could not paste a screenshot into the message box, and you could not drag a file from your desktop onto the chat. In Telegram, both of those just work. The dashboard's Sessions page already accepted drops and pastes, but the chat page did not.

The line at the top of the dashboard that tells you about your connection also used its own words ("Offline", "Weak connection"). Telegram uses three short phrases everyone recognises: "Waiting for network…", "Connecting…" and "Updating…". The Instar apps should all say the same thing, so a person never has to learn a different wording on each device.

## What changed

- **Paste:** pasting a screenshot or a copied file into the message box adds it to the files waiting to be sent, exactly as if you had picked it with Attach. A screenshot has no name of its own, so it gets one like "Pasted image 14.32.07.png", which keeps two pastes apart. Pasting ordinary text works as before.
- **Drop:** dragging files over the open conversation (its messages or the message box) outlines the message area and shows a small "Drop to attach" label. Letting go adds the files. Dragging a link or some selected text is left alone, so the browser handles it as usual.
- **The same checks:** dropped and pasted files go through the same size and count limits as Attach, and nothing is sent until you press Send.
- **Connection words:** with no network, the top line now begins "Waiting for network…". When the network is there but the agent doesn't answer, it begins "Connecting…". The part that says how old the shown copy is ("Showing what I had at 1:52 pm") stays the same.

## What did not change

How messages are sent, how files upload, and what is saved in the browser. Nothing new is stored, and the server is untouched. Undoing it is a revert.

## What's next in the same project

The iPhone, Mac, Android and Windows apps get the same three connection phrases and the same drop and paste support. Each app's builder ships its own part. A weekly review re-checks every app against the Telegram list.
