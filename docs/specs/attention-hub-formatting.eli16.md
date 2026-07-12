# Attention-hub message formatting fixes — Plain-English Overview

> The one-line version: the alert messages in the 🔔 Attention topic stop showing code tags, stop saying everything twice, and start calling machines by their names.

## The problem in one breath

The operator's screenshots (2026-07-11) showed alert messages that were technically delivered but painful to read: visible `<b>` and `<i>` code tags where bold and italic text should be, every paragraph printed twice back-to-back, and machines identified by 32-character internal ids instead of "Laptop" or "Mac Mini".

## What already exists

- **The single Attention hub** — every alert posts as one message into one dedicated 🔔 topic. That routing works and is untouched.
- **A message formatter** — converts the agent's markdown into Telegram's rich format on every send. Senders that already produce Telegram HTML must tag their send so the formatter doesn't mangle it; the older per-alert path did this correctly, the newer hub path forgot to.
- **Alert authors** — the machine-coherence guard and the connection prober write careful, impact-first alert text. Their convention is that the long body *starts with* the short summary — and the posting code rendered both, hence the doubling.
- **Machine nicknames** — every machine in the pool already has a user-facing nickname in the shared registry; the connection prober just never looked it up.

## What this adds

Three small, targeted repairs — no behavior change to *when* or *why* alerts fire, only to how they read:

- The hub post now tells the formatter "this is already Telegram HTML" (the same tag the per-alert path always used), so bold renders as bold instead of visible tags.
- A tiny shared rule: when the long body begins with the summary, print it once. If they're genuinely different, print both — never drop information.
- The connection prober now asks the registry for a machine's nickname and says "the lan rope to Laptop…" instead of "…to peer m_4cbc0d4a0c…". No nickname available → it honestly falls back to the id.

## The safeguards

- **Opt-in only.** The formatter change is a per-call option; every other message path in the system sends exactly as before, byte for byte.
- **Never worse than today.** If a rich-format send is rejected by Telegram (rare), it falls back to the plain send — the pre-fix appearance, still delivered.
- **A broken lookup can't break alerting.** If the nickname lookup throws, the prober falls back to the raw id and keeps probing; naming is cosmetic, delivery is not.
- **No information loss.** The dedupe only collapses a byte-identical embedded copy of the summary; paraphrased or independent descriptions render in full.

## What the reader needs to decide

Nothing risky — this is a readability repair of messages that were already being sent, covered by 11 new tests across the two affected suites plus a 7-suite regression sweep. The one accepted trade: a rare cross-machine relayed hub post (a standby with no bot token of its own) keeps today's plain rendering — extending that envelope is deliberately out of scope here, and the machine that actually produced the broken posts sends directly, so it's fully fixed by this change.
