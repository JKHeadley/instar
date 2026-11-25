# Delete one message in an App chat

When Delete is available, the app will confirm which message you selected. If you can remove that message, the server records the removal in the chat. The app can then remove that one row without changing your draft or hiding another message. A forwarded copy is a separate message in its own chat and keeps its own history.

If a request is denied or the app cannot confirm the outcome, the row stays visible until the server reports that it was removed. When a removal is confirmed, loading an older page or reopening a saved chat cannot bring the row back.

The first server work records and checks the removal in storage. It does not switch on Delete in the app. Before enabling the action, we will verify the chat history, search, previews, quotes and attachment access on both the current machine and its peers. The original storage files still follow the existing retention policy. This action does not recall files already downloaded or copies sent to another chat.

The server now checks a signed request against the recorded chat owner, the machine serving that chat, and the exact selected message. The initial version requires a verifiable owner identity. This check is available inside the server, and the app still has no Delete control or route that changes history.

The server’s internal history reader can now leave out a confirmed removal before it fills a page. That means the next visible message can still fill the page. It also refuses an exact lookup when the removal evidence is incomplete. This reader is still being tested and is not used by the app yet.
