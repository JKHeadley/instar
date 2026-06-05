# Secret Drop store-first — the plain-English version

## What kept going wrong

When you hand me a secret through a drop link, the submitted value used to
live in ONE place: my server's RAM. If my server restarted (it restarts on
every update — about 20 times a day lately), or my session got compacted, or
the conversation moved to your other machine before I grabbed the value — the
secret just evaporated. You'd get "✅ Secret received" and then I'd come back
asking you to send it AGAIN. That's the "I've sent this MANY MANY times"
experience. It wasn't you; the value genuinely vanished.

## What changes

The instant you press Submit, the secret is now ALSO written into my durable
encrypted vault (the same AES-256 encrypted file that already holds my GitHub
token). So:

- Server restarts, updates, compactions, machine handoffs — the secret
  survives all of them.
- When I retrieve it, I get the in-memory copy if it's still there, or the
  vault copy if it isn't. Same command, no difference to me or you.
- When I actually USE the secret (consume it), BOTH copies are deleted —
  one-time secrets still end up fully gone afterwards.
- If you ever want the old behavior back: `secrets.persistDrops: false` in
  config. Default is ON for everyone, because losing secrets was a bug, not
  a feature.

## The trade we're making (on purpose)

Old promise: "never written to disk." New promise: "written to disk ONLY
encrypted, and it actually survives." You explicitly asked for this trade —
"your FIRST priority is to STORE IT SECURELY so you don't lose it." The
encryption is the same one protecting the rest of my vault.

## The bonus bug this build caught

While testing this, my own test accidentally broke my real vault for a few
minutes. Why: the vault's master key can live in the Mac's keychain, and that
keychain slot is SHARED by everything instar on the machine. My test created a
fresh throwaway vault, which generated a fresh key and silently overwrote the
shared slot — and suddenly my server couldn't decrypt the real vault (it looked
empty). I fixed the machine on the spot (deleted the bogus slot; the vault was
intact underneath) and added a guard so NO test can ever touch the real
keychain again, even a future test written by someone who's never heard of
this incident. The deeper redesign of that shared slot (per-agent slots,
self-describing key IDs) is written up as a follow-up — this PR just makes the
foot-gun impossible to fire from tests.

## How you'll notice

You shouldn't — that's the point. You drop a secret once, and it's there when
I need it, even if my server restarted twice in between. No more re-sending.
