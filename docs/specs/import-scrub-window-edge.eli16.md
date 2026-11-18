# A secret at the edge of a very long imported message is still removed (ELI16)

When you bring old chats in from Claude or ChatGPT, every message is checked for things that look like passwords or keys, and those are removed before anything is saved. The checker is only proven fast up to about a million characters, so a longer message is checked in pieces.

The pieces used to be cut at a space. That kept a plain key in one piece, but some secrets have a space inside them, like "Bearer" followed by a token or "password:" followed by a value. If the cut fell on that space, neither piece looked like a secret, so the value was saved. A long stretch with no spaces near the cut could also split a key in two.

Now the pieces overlap, so anything cut at one edge is seen whole in the next piece. Anything that runs right into the edge of a piece is removed through to the next space, in case it keeps going. Short messages are checked exactly as before.
