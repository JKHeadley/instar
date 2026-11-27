# Pairing a phone over Tailscale, with links that last long enough — plain overview

**What happened.** On 2 November we connected Justin's iPhone app to a brand-new Instar agent running on a rented cloud server. Two problems on the server side made it painful.

First, the server refused to make a pairing link at all. It insisted on a specific kind of permanent web address that goes through Cloudflare, even though the server already had a working private address on Justin's Tailscale network, and his phone was on that network too. We had to set up a Cloudflare address just to get past this.

Second, the links ran out too fast. A pairing link lasted 10 minutes, and the phone's waiting request lasted 15. Justin did not get to the first link in time, and the second ran out while he was looking for the code. That took three links in all.

**What changes.**
- If the agent has no running Cloudflare address, it can use its own Tailscale address instead, but only one it has already proven belongs to it. Cloudflare is still preferred when it is running.
- Pairing links and the phone's waiting request both last 30 minutes (unless the agent restarts in between, which still costs one new link).
- A link keeps working for the address it was made for. If Cloudflare comes back while you hold a Tailscale link, or one background health check blips, the link still works.
- When the link uses the Tailscale address, the agent tells you plainly that your phone needs Tailscale switched on.
- A spare machine that cannot send you the confirmation code now says so before it makes a link, instead of the link failing after you open it.

**What does not change.** The safety steps stay exactly as they are. The link still works once. The phone still needs the 6-digit confirmation code, which only the owner can see (in their private Telegram chat, or on the dashboard behind the PIN). Being on the same Tailscale network gives nobody access by itself. The limit on wrong guesses is per day, not per minute, so a longer wait does not make guessing easier.

**Safeguards.** The Tailscale address is used only after the server proves, with a secret only this running program knows, that the address really leads to it and not to another machine. Nothing a stranger sends can choose which address is used. And while an outside backup relay is carrying the agent's traffic, Tailscale pairing waits, because such a relay could deliver a request pretending to arrive by Tailscale. The ordinary Cloudflare tunnel most agents run does not block it.

**If it were wrong.** Undoing the change brings back the old rules. Phones that already paired over Tailscale keep working, because the agent already accepts its own Tailscale address for paired phones.

**What you need to decide.** Nothing.
