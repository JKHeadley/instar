# The document page arrives untouched, in plain English

Instar Documents is the page where you read a document your agent wrote and comment on it. On the internet, that page reaches your browser through Cloudflare, which carries traffic from the agent's machine to the outside world.

Today the end-to-end test was run for the first time through a real Cloudflare address instead of a local stand-in. It found that Cloudflare was adding a small analytics script of its own to the page on the way through. That is a Cloudflare account feature called Web Analytics, which inserts its script into web pages automatically. The page already has a strict rule that only instar's own scripts may run, so the added script was blocked and never ran. But the browser logged an error on every open, and the page you received was no longer exactly what the agent sent.

What changes: the page now carries a standard web instruction, "no-transform", which tells Cloudflare not to modify it. Cloudflare's documentation says that stops the analytics script from being added. Only the page itself carries the instruction. The files and data it loads afterwards keep Cloudflare's normal compression, so nothing gets slower.

What does not change: who can open a document, how comments work, and anything outside documents. Documents are still switched on only for development agents. Undoing this is a single revert.

Nothing to decide.
