# Scoped for next window — implement Telegram's real RichText grammar

**Why this is scoped rather than shipped:** every guard repair in the second half of window 12 was right
in intent and wrong in shape, one level deeper each time — wrong representation, mutable reference,
re-read, wrong field, wrong field *type*, alternatives-as-and. The operator's instruction was to break
that by implementing the **real grammar from the live specification**, and explicitly *not* to add a
fourth key name, because adding-a-key is the shape that failed four times.

I could not complete it inside the window without guessing at the part I could not fetch. Guessing is the
failure mode this item exists to end, so it is scoped with the derivation preserved — the next session
starts from knowledge, not from scratch.

---

## What IS derived, from the live documentation

Fetched from `core.telegram.org/bots/api` during window 12, not from memory. (The stale-knowledge lesson
applies directly: `rich_message` postdates my training and I nearly dismissed it as fabricated.)

### The container

`InputRichMessage` carries content under `html`, `markdown`, or `blocks` (an array), plus a `media` field.

### Block-level carriers — the complete set observed

| carrier field | type | blocks that use it |
|---|---|---|
| `text` | **RichText** (recursive) | Paragraph, SectionHeading, Preformatted, Footer, BlockQuotation, PullQuotation, Thinking, Caption, ListItem, TableCell |
| `name` | String | RichBlockAnchor |
| `expression` | String | RichBlockMathematicalExpression |
| *(none)* | — | Divider, Details, and the media blocks (Collage, Slideshow, Photo, Video, Animation, Audio, VoiceNote, Map) |

`RichBlockList` contains `RichBlockListItem` objects; `RichBlockTable` contains `RichBlockTableCell`
objects. Both bottom out in `text`.

### Inline layer

Every inline type wraps a **RichText** object recursively: `RichTextBold`, `Italic`, `Underline`,
`Strikethrough`, `Spoiler`, `Code`, `Pre`, `Url`, `EmailAddress`, `PhoneNumber`, `Mention`, `Hashtag`,
`Cashtag`, `BotCommand`, `CustomEmoji`, `MathematicalExpression`, `Subscript`, `Superscript`, `Marked`,
`DateTime`, `BankCardNumber`, `Anchor`, `AnchorLink`, `Reference`, `ReferenceLink`.

**The grammar is therefore small**: a handful of carrier field names plus recursion through wrappers. It
is NOT thirty special cases, which is why implementing it properly is bounded work rather than a slog.

## What is NOT derived — the blocking unknown

**How a `RichText` value holds a literal string, and how it represents a sequence of parts.**

Two targeted fetches could not reach it: the API page is large and the tool returned truncated content
both times, explicitly stating the `RichText` field definitions were not in the excerpt. Specifically
unknown:

- Is there a leaf type (a `RichTextPlain`-equivalent), and what is its string field called?
- Is there a discriminator field (`type`)?
- How is a sequence of inline parts represented — an array, and under what field name?

## Why a partial fix would NOT have closed it

The current walker collects strings under `html`, `markdown`, `text` at any depth, and a structure
yielding **no recognised leaves is treated as undecidable and ALLOWED**. So if the literal sits under a
field name I have not derived, the walker finds nothing, the guard allows, and the bypass survives —
while the code and its tests look like they cover rich content.

That is exactly the defect pass 44 found: *a field named in the closed-world table reads as handled.*
Shipping `name` and `expression` today would have widened the table without closing the class, and would
have made the remaining gap harder to see, not easier.

## The work, for next window

1. **Fetch the complete `RichText` definition** — a section-specific URL, a different retrieval path, or
   the Bot API changelog for the release that introduced it. Do not proceed on inference.
2. **Implement the grammar as a typed walk**, not a key-name sweep: recurse the inline wrappers, gather
   literals at the leaf, and handle the sequence type.
3. **Invert the undecidable default for structured content.** Once the grammar is known, a rich structure
   that yields no leaves is no longer "cannot decide" — it is either empty (refuse) or a shape the walker
   does not know (which should be loud, not silent).
4. **Test against the real shapes**, including a nested wrapper chain and a list/table, not a hand-built
   object with a `text` key.

## Open items this leaves standing, from pass 45

- Structured content is inspected only in its JSON-body representation; the same content arriving another
  supported way is unexamined.
- The lint's `fetch.call` / `fetch.apply` recognition examines the receiver incorrectly.
- The token-root `method` fallback is characterised as an ordinary dispatch rule when it is narrower.
