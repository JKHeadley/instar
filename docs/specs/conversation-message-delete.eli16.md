# Delete one message in an App chat

When Delete is available, the app will confirm which message you selected. If you can remove that message, the server records the removal in the chat. The app can then remove that one row without changing your draft or hiding another message. A forwarded copy is a separate message in its own chat and keeps its own history.

If a request is denied or the app cannot confirm the outcome, the row stays visible until the server reports that it was removed. When a removal is confirmed, loading an older page or reopening a saved chat cannot bring the row back.

The first server work records and checks the removal in storage. It does not switch on Delete in the app. Before enabling the action, we will verify the chat history, search, previews, quotes and attachment access on both the current machine and its peers. The original storage files still follow the existing retention policy. This action does not recall files already downloaded or copies sent to another chat.

The server now checks a signed request against the recorded chat owner, the machine serving that chat, and the exact selected message. The initial version requires a verifiable owner identity. This check is available inside the server, and the app still has no Delete control or route that changes history.

The server’s internal history reader can now leave out a confirmed removal before it fills a page. That means the next visible message can still fill the page. It also refuses an exact lookup when the removal evidence is incomplete. This reader is still being tested and is not used by the app yet.

Opening another chat no longer forces the store to repeat a recent history check for the first chat. A change to stored messages still requires a fresh check. Delete remains unavailable while this server work is tested.

The store now checks a long chat in chunks so other server work can run in between. If the chat changes during the check, the store discards the result and can try again. The history reader needs a current completed check before returning messages with removals applied.

A regular message arriving in another chat no longer restarts the check. A new message in the chat being checked still restarts it, and the store starts over when it cannot attribute a change safely.

The server can now remember an exact Delete request and check whether it reached the journal before answering a retry. A retry that asks to delete a different message is refused. The production action still needs the history and sync changes before it can be turned on.

Delete now uses the background history check before writing a new removal. If access changes or the chat is updated while the check is running, the server verifies again before it can record anything.

Before the app can use Delete, the server also needs to prove that only one server process can write to the same chat store.

The private Delete action now checks the server’s process lock before it writes. If the server loses that lock after recording the request, it leaves the request for its successor to resolve.

Two servers starting together can no longer overwrite each other’s first lock record. Taking over an old lock left behind by a stopped server still needs its own check before Delete can go live.

If a server leaves an old lock behind, the next server takes a short recovery lock before removing it. It checks the record again so it cannot remove a lock that another server has already acquired.

A private sync check now tells an authorized reader which exact message was removed. If the removal record arrives first, the check pauses there until it can verify who may see the notice. The existing app feed still keeps these notices off.

The server can now check that a saved sync position belongs to the same person, paired device and chat. A change in access means that position can’t be reused. The app must then recheck its cached rows before showing them again.

The team access log now changes its revision when access is removed and restored, even if the final permissions look the same. The cursor uses that change to tell the app to recheck its saved position.

Changes in the paired-device key records now invalidate an old sync position. If those records cannot be checked, the app must wait before trusting cached chat history.

A change to a machine’s signing keys also changes the revision used for sync. The server reads the keys and their revision together so it can keep checking older signed messages after a legitimate key rotation.

The private server check now brings the signed device, owner, chat, and evidence revisions together. An old saved position can’t be reused after a different machine or access check takes effect.

The private sync test now reads real messages and removal notices. If access changes or a removal arrives while the server is preparing a page, the server discards that page so it cannot send stale rows.

The private sync response now says when it has reached the latest verified entry. An empty page alone is not enough. The app can use that result to decide when it has applied enough changes to show cached messages again.

The sync check now reads the real chat journal. New messages keep the current sync position usable, while a rebuilt or replaced journal makes the app check its cached history again.

The first protected history page now checks the same signed view as sync. If removal happens while the page is being checked, the server asks the app to try again. Only the private test route uses this behavior so far.

An isolated development test can now use the app’s usual history and sync addresses with synthetic messages. This checks how the server handles a removal before testing the native app end to end.

On the isolated server, opening a deleted message now reports it as unavailable. Opening a surviving message still selects it exactly, including when there are deleted messages nearby.

The isolated server also refuses to copy a new link to a deleted message. The app still gets the usual link for a surviving message.

On the isolated server, a reply stays readable after its original message is deleted, but the quote preview no longer shows the deleted text.

The isolated server also stops deleted text from appearing in notification previews. It uses the current signed device to check the exact message and leaves the generic notification available when it cannot provide text.

The isolated server also drops a deleted message from the pin list and builds the previews for surviving pins from their current message text.

The isolated server also refuses to show reactions for a deleted message. It can still show a surviving message’s reaction state.

On the isolated server, search skips protected chats until it can verify what is still available. Results from other chats can still be shown.

The server can now check whether a file is still attached to another readable message in the same chat after the first message is deleted. The download and session routes still need to use that check.
