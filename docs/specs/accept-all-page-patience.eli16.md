# Accept all waits longer for your other machine (plain-English overview)

**What happened.** After the server fixes, Accept all got through most projects, but it still stopped at "Stopped at 10 of 14: your agent is not answering right now". Several projects had been saved but not yet confirmed by the M5 when the page gave up on them.

**Why.** The page waited only 60 seconds for the other machine to confirm each change. With a busy Studio, confirmations sometimes take one to two minutes. After 60 seconds the page counted the project as "still waiting" and moved on. After two such projects in a row, it stopped the whole run. Nothing was lost, and Continue picked those projects up again, but you had to keep pressing Continue.

**What changes.**
- The page now waits up to two and a half minutes for each change to be confirmed.
- It stops only after three projects in a row are still waiting, instead of two.

While it waits, it keeps showing "Saved here. Waiting for Mac M5 Pro to confirm" with the seconds counting up.

**What stays the same.** The words on the page, what is saved and how it is confirmed. A truly stuck run still stops and says so; it just gives a busy machine more time first.

**What you need to decide.** Nothing. It is a small page change (Tier 1), and a revert undoes it.
