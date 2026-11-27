# Machines proving who they are to each other

When two machines of the same agent talk about Conversations, one had to present a password that matched the other machine's own API password. On a normally paired agent each machine has its own password, so they could never match and every change stayed waiting forever, with no reason shown. Echo's machines happen to share one, and every test used one made-up value, so nothing noticed until a real run between two real machines with different passwords.

Each message is already signed with the sending machine's private key and checked against the signed list of members, which proves more than a shared password does. So the password check is gone, and machines no longer hand their own password to each other.

This route can now be reached without a password, so anything malformed or wrongly signed is refused before any real work happens, and what it writes to the log is limited.

The server also now says in its log why Conversations isn't ready, instead of staying silent. That is how the remaining problems in the real run were found.

One gap is still open: a separate history path sends a machine's password to a peer for Slack conversations. That is recorded and not fixed here.
