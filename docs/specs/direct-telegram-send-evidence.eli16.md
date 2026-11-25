# Checking the original Telegram request

If you want your agent to send one exact message through Threadline, the first test version looks for a specific request format. The test request starts with a line naming the recipient by its unique fingerprint. The lines that follow are the text to send, including their spacing and line breaks.

The program needs evidence from Telegram that the original author is the current owner. It also needs to know whether the message was forwarded, quoted, sent as a reply or accompanied by media. The test refuses sources with any missing evidence. It also refuses examples that only contain the request format inside a longer explanation.

This is a parser checkpoint. Nothing listens for or sends these requests in production. Before enabling the feature, the server needs to capture authenticated evidence when the message arrives. It also needs to confirm the pairing and record one attempted delivery so retries cannot send a second copy.

The polling fixture now checks the original Telegram forum message before the adapter changes its topic number. It requires a known numeric bot account, the current owner as sender, and an explicit forum topic. If the message carries additional fields, the fixture leaves it in the ordinary approval flow. The next step is to store the evidence from authenticated polling so the send path can verify it later.
