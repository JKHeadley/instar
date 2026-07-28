# Encryption-key fallback — explain it like I'm 16

Two computers that act as one assistant talk to each other over an encrypted
channel. Each machine has TWO little key files it needs to open that channel:

1. A **signing key** — like a signature, so the other machine knows a message
   really came from this machine and wasn't faked.
2. An **encryption key** — like a lockbox key, so the contents of the message can
   be scrambled and only the right machine can unscramble them.

A while back the project renamed these key files to cleaner names
(`signing-key.pem` and `encryption-key.pem`). But the Mac mini was set up BEFORE
that rename, so on disk its keys still had the old names
(`signing-private.pem` and `encryption-private.pem`).

The code that opens the encrypted channel goes looking for the NEW names. If it
can't find a file, it throws an error and gives up on setting up the channel.

Last fix (#610) taught the SIGNING-key loader: "if you can't find the new name,
try the old name before giving up." That fixed half the problem. But I only fixed
the signing key. When I deployed it and watched the mini boot, it got past the
signing key… and then threw the exact same kind of error on the ENCRYPTION key,
because that loader was never taught the same trick. The error literally said:
"no such file: encryption-key.pem." So the secure channel still couldn't finish
turning on.

This change teaches the encryption-key loader the same fallback: look for the new
name first, and if it's missing, fall back to the old name before giving up. Now a
machine set up under the old naming can open BOTH halves of its secure channel
without anyone copying files around by hand.

Why it matters: until both keys load, the mini can't fully join the mesh — it
can't be trusted to receive a conversation moved over from the laptop. With both
loaders fixed, an old-style machine joins cleanly on its own.

It's a tiny change — one new line remembering the old filename, plus a few lines in
one function that say "try the old name if the new one is missing" — but it closes
the last of a pair of identical gaps that were silently keeping a real machine from
joining the group. The signing-key half shipped in #610; this is the encryption-key
half. Both are the same lesson: when you rename a file, teach the code that opens it
to still recognize the old name, or machines created under the old name quietly
break.
