# Pending MCP approval store (ELI16 overview)

## What this is

When the assistant needs you to approve loading a tool mid-chat, we want you to be
able to approve with a tap on a link — not by typing a technical command. For that,
the link can't carry the secret one-time approval code in its address (links end up
in browser history and server logs). So instead, this little server-side notebook
holds the pending request (which tool, which conversation, and the secret code), and
the link only carries a meaningless lookup id.

When you open the link, the approval page looks up the request by that id and shows
you "Approve loading the browser for this chat?" — WITHOUT ever putting the secret
code on the page. When you tap Approve and enter your PIN, the server looks up the
secret code from the notebook, uses it once, and removes it.

## Why it's safe

It's a small in-memory notebook with three operations: jot down a request (get back a
random lookup id), peek at a request's details (never the secret code), and use-once
(hand back the secret code a single time, then erase it). Entries expire after a few
minutes. Six tests confirm: the lookup id is opaque, peeking never leaks the code,
using is single-use, unknown ids return nothing, and entries expire on time.

## Status

This is the foundation for the "tap to approve" screen. The screen itself (the page +
its routes) comes next and is intentionally built after the live test-through-Telegram
run, because that run is what tells us the right shape for the approval experience.
The notebook is UI-agnostic, so it's worth building now regardless of that shape.
