# Telegram Web K 686 — plain-English overview

Echo can send and read Telegram through the operator's own signed-in Telegram Web page. That page is a managed browser profile, used only through a narrow server door. For safety it works only on versions of Telegram Web that someone has read and approved. On the morning of 2026-11-08, Telegram shipped a new version, 2.3 (build 686). Echo's safety check saw a version it did not know and stopped all browser sends and reads. That is the intended behavior: a wall, not a guess.

This change does three things.

First, it approves build 686. I downloaded the public files of the new version, with no account and no browser, and compared their source maps file by file with the last approved build, 684. The parts Echo relies on did not change: the hook it uses to reach the account's message functions, the way peers are looked up, and the exact shape of the "send message" and "edit message" requests. The approval names the three exact files and their fingerprints. A different file means a new review.

Second, it fixes one real change that the review found. In 686, when Telegram's server answers and the page cannot read the answer, the page now reports it as an ordinary "bad request" error. Echo had treated every bad request as "Telegram refused this, nothing was sent", and that would make sending again look safe. Here the server did answer, so the message may already be in the chat. Echo now treats this one error as "outcome unknown". That means the message is held and checked against Telegram's receipt, never sent twice.

Third, when the snapshot read fails, the server now writes the reason to its own log. It used to throw the reason away. The caller still gets the same short "unavailable" answer, with no internal details.

What the operator needs to do: nothing. After release, Echo runs the approved, read-only enrollment check on its own machine. It sends nothing and switches the browser back on only if the live page matches build 686 exactly.
