## What Changed

**Your agent can no longer send you a Telegram message that arrives blank.**

Text can be present in a message and invisible to a reader. A zero-width space is a real character that
draws nothing. So is content that lives only inside a link's destination rather than its label, or only
inside markup a formatter strips on the way out. A message built from those arrives looking empty — the
agent believes it answered you, and you see nothing.

Every Bot API call now passes through **one door** (`src/messaging/telegram-egress.ts`), which reads the
serialised body that will actually go on the wire and refuses a payload it can prove renders as nothing.
The method world is CLOSED: a method is either classified as carrying a reader-visible field or explicitly
declared to carry none, and an unclassified method is **refused at runtime** rather than assumed safe.

The hard part was Telegram's nested rich messages — bold inside a link inside a table. Six repairs to that
walk each failed the same way: each asked "which named field holds the words?", a review named a field
that had been missed, and the field was added. That fixes one message shape and leaves the next one open,
because the defect was never a missing name. It was that names were being consulted at all.

Telegram selects on a **type discriminator**, reads only the fields that variant declares, and discards
every other member of the object. The walk now does the same, from a table transcribed out of the Bot API
server's own request parser rather than from documentation prose or from recollection. That single change
closed three holes that turned out to be one shape in three places:

- A member the server discards could vouch for an invisible payload.
- The rich-message container is a **priority union** — `blocks`, else `markdown`, else `html` — never a
  merge. Invisible blocks beside a visible `html` sibling passed as visible and rendered as nothing.
- A method's reader-visible fields are a priority union too. `editMessageText` reads `rich_message`
  whenever that key is present and only otherwise reads `text` — so a visible `text` in the query was
  excusing an unreadable body free to carry the `rich_message` actually sent.

**What it deliberately does not claim.** A mathematical expression is stored as typesetting source, so its
characters are not its rendered glyphs; it is treated as undecidable — it can no longer vouch for a
message, and it can no longer get a real formula refused. Media is undecidable for the same reason, which
also **fixes an over-refusal**: a photo carrying an invisible caption is a valid message and was being
destroyed on the way out. Where the guard cannot decide, it delivers, because an over-refusal destroys a
real message and that is the worse direction for a messaging path.

## What to Tell Your User

Nothing to do, and ideally nothing to notice. A rare class of blank message can no longer leave, and a
class of real message — a photo whose caption happens to be empty — that was being refused now arrives.

## Summary of New Capabilities

No new commands, routes, or configuration. This is a safety floor on an existing path.

## Evidence

- Reproducible by running the boundary lint: `node scripts/lint-telegram-egress-boundary.mjs` prints
  whether Bot API egress is confined to the door, and names every escaping call site when it is not. It
  found three real escapes in the setup wizards that this change routes through the door.
- 136 tests across five suites, including negative controls: each behavioural test was run against the
  PREVIOUS implementation first and confirmed to fail for the right reason before being kept. The tests
  that only correct fixtures are recorded as fixture corrections, not counted as behaviour proofs.
- The discriminator table is a transcription and is treated as one — the review brief for the next reading
  puts the table itself in the crosshairs rather than presenting it as settled.

## Honest Status

The review series behind this has **not** produced two consecutive clean readings. Findings have run
9, 7, 8, 7, 9, 5, 6 across the recent passes; their depth has moved from "this was never checked" to
"the model of the format is wrong at the third level", which is a better class of problem and not a
finished one. Open items are recorded in the source at the function that carries them, where the next
reader meets them, rather than only in a document.
