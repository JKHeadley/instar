# Room in the core instruction file again (plain version)

Written 18 November 2026. It can be read with no other background.

> The one-line version: the instruction file every Instar agent starts from had filled up to its size limit, which made a dozen unrelated changes fail their tests; this change shortens its longest rows, keeps their full text one step away, and adds an early warning so it cannot fill up silently again.

## The problem in one breath

Every Instar agent reads an instruction file, called CLAUDE.md, at the start of each session. To keep sessions small, that file has a core part with a size limit of 84,000 characters; everything else lives in reference files the agent opens when it needs them. On 18 November the core measured 83,999 characters. Any change that added one more line to it failed a size test, and that test only runs at the end of a full test run of about 20 to 40 minutes. Fourteen open changes were about to lose a whole run each.

## What already exists

- **The core and the reference files.** The core holds what an agent must know at once. Reference files hold the detail, and the core lists every capability by name so an agent knows what to look up.
- **The size limit.** It was raised once, from 80,000 to 84,000, on 14 November. The note written then says the lasting fix is shorter rows, not a higher limit.
- **Two lookup tables in the core.** "Registry First" (which question is answered by which lookup) and "Feature Proactivity" (which situation calls for which feature). Rows had grown long: 13 were over 400 characters and the longest was 1,035.

## What this changes

The longest rows in those two tables are shortened. Each short row keeps the question or situation, the first thing to do, and any "never do this" rule. The full original text of each one moves, word for word, into a new reference section called "Lookup details", and each short row says so. Fourteen more rows just name the address to read (`GET /jobs`) instead of repeating the same long command prefix; one sentence at the top of the table explains the shorthand.

The core drops from 83,999 to 77,990 characters. That leaves about 6,000 characters of room.

## The safeguards

**Nothing an agent needs is lost.** A test checks that every shortened row has its full text in the reference section, under the same question.

**It cannot fill up silently again.** A new quick test fails when any row in those two tables is longer than 400 characters, and fails when less than 2,000 characters of room remain. It runs in seconds, with the ordinary quick tests, and its message says what to do: shorten a row or move detail to a reference section, and do not raise the limit.

**Safety wording is untouched.** The sections about message sending, known traps, and core principles were not edited.

## What ships when

One change. Existing agents get the shorter core on their next update, because the core is rebuilt from the template on every update. Nothing needs to be migrated.
