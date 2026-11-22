# Live keys are masked in transcript copies between machines

<!-- bump: patch -->

## What Changed

SEC-164, part 1c. When a session's transcript is copied to another of the agent's machines, a live key inside it is masked on both sides: inside each row before it leaves, and inside each checked chunk before the copy is written. The mask keeps every line the same length and the same structure. It changes only the key's characters inside a text value, never a field name, a signed thinking block, encrypted reasoning or image data. The copy scrub follows `security.credentialScrub.inPlace`: on a development agent it starts by only counting what it would mask (recorded as evidence, never the value), and masks once that setting is on. Three items carried from part 1b also land. A person who pastes a key into an Instar app conversation now gets the same fixed notice with a one-tap Secret Drop link, and the receiving session sees a one-line note. Incoming masking also matches the agent's own configured keys (its API, bot and tunnel tokens) by exact value.

## What to Tell Your User

- **Keys stay out of copies between my computers**: "If a key ever shows up in a session record, the copy sent to my other computers has it blanked out too."
- **The app tells you too**: "If you paste a key into the app, I remove it and give you a one-tap link to send it safely, the same as in Telegram."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Live keys masked in transcript copies between machines (counted first, masked once `inPlace` is on) | Automatic on development agents; `security.credentialScrub.inPlace` switches counting to masking |
| Removed-key notice and session note in Instar app conversations | Automatic when the switch is on |

## Evidence

- `tests/unit/sec164-line-mask.test.ts` (16 cases) shows the following. The mask keeps the byte length and the keys. It never changes a field name. It finds a key after an escaped newline and in a PEM block written with escapes, keeps offsets right after multibyte characters, and scans a value hidden behind a duplicate key. It leaves signed thinking, encrypted reasoning and image data alone. The dry run counts only, and a non-JSON line is left alone. The mode reader covers off, dry run and on. Source-order checks show the copy source masks before redaction and the receipt masks after the hash check.
- `tests/integration/mobile-native-signed-records.test.ts`: the app case now also checks that exactly one notice is posted and that the session sees the note.
