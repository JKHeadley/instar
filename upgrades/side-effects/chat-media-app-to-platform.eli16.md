# Sending photos and files from the app into Telegram and Slack, explained simply

The Instar iPhone app has three kinds of conversations: the app's own conversations, Telegram topics, and Slack conversations. Until now the operator could attach photos and files only in the app's own conversations. In a Telegram topic or a Slack conversation, the app could send words but not files; the server refused a message with files, so nothing was saved half-done. This change lets files go into Telegram topics and Slack conversations too.

The steps are the same ones the app's own conversations already use. First the phone uploads each file in small signed pieces, and now it can say which Telegram topic or Slack conversation the file is for. Then the phone sends the message, signed by the phone's own key. That signature covers every file's fingerprint, so a file cannot be swapped later without the signature failing. The server checks that each upload came from this phone, was meant for this exact conversation, and matches what the phone signed. Only then does it save the files and the message, and only after they are safely saved does it hand the message to the agent.

The agent receives each file as a line with a path on its own machine, like `[image:/…/photo.jpg]`, followed by the words of the message. That is exactly how photos arrive from Telegram, so the agent already knows how to read them.

People reading the Telegram topic or the Slack channel should see what was sent, so the server also posts a copy there. In Telegram, the files go up as a photo, video, voice note or document (several at once as one album), labelled "📱 Justin (from the app)". Telegram does not accept uploads over about 50 MB, so a bigger file is posted as a short note saying it is too large and to open it in the app. In Slack, each file is uploaded into the channel or thread, the first one with the same label. If posting the copy fails, the message still reached the agent, and the app is told the copy failed. The message is never sent to the agent a second time.

The app's history for that topic or channel shows the message with its files, and the files download from the server. A phone never sees a file's location on the computer. If the phone retries the same send, the server answers with the result it already recorded instead of sending again.

All of this is behind the existing "files in app conversations" switch. With the switch off, everything behaves as before, and a message with files is refused as before.

One honest limit: the copy into Slack could not be tried against the real Slack service, because this agent has no working Slack connection right now (its Slack key was withdrawn in July). The Slack upload steps are the same ones already in use, with two optional extras Slack documents; they should be tried for real when Slack is set up again.
