# Telegram Web K 687 — plain-English overview

Echo can send and read Telegram through the operator's own signed-in Telegram Web page. That page is a managed browser profile, used only through a narrow server door, and it works only on versions of Telegram Web that someone has read and approved. Telegram shipped a new version, 2.3 (build 687), before 2026-11-11. Echo's safety check saw a version it did not know and stopped all browser sends and reads. That is the intended behavior: a wall, not a guess. It also meant a leftover test group from 2026-11-09 could not be removed from the operator's Telegram.

This change approves build 687 and nothing else.

I downloaded the public files of the new version with no account and no browser, checked that their fingerprints equal what Echo's live, read-only check saw on the operator's page, and compared their source maps file by file with the last approved build, 686. Every part Echo relies on is byte-for-byte the same: the hook it uses to reach the account's message functions, the request and error handling, how people and chats are looked up, and the exact shape of the send and edit requests. What did change is the chat list's paging, reaction settings, message bubble layout and one cache rule in the page's background worker. Echo uses none of those. A second, independent check recomputed the fingerprint from the three approved files and got the same value the live check reported.

The approval names the three exact files and their fingerprints. A different file means a new review.

What the operator needs to do: nothing. After release, Echo runs the approved read-only enrollment check on its own machine. It sends nothing, and it switches the browser back on only if the live page matches build 687 exactly. Then Echo removes the leftover test group and says so.
