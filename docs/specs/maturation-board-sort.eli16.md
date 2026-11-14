# Maturation board sort choice — plain-English overview

**What it is.** The feature maturation page groups every feature by how it is doing (broken,
stuck, not measured, on its way, working, being retired, not reviewed). Inside each group the
order used to be fixed: features with no fix planned first, then the ones stuck the longest.
Justin's original request asked for filtering and sorting; the readability redesign kept the
filters (colour chips, search, a "no fix planned" switch) but removed the sort choice to keep the
page calm.

**What changes.** A small dropdown next to the search box now offers four orders: "Worst first"
(the old fixed order, still the default), "Most overdue" (the feature furthest past its promised
date first), "Longest stuck" (most reviews in a row with no change) and "A–Z". The choice is kept
in the page address, so a shared or reloaded link keeps it, and "Show everything" resets it.

**One wording fix.** The top of the page said some machines "didn't answer". One of them is never
asked at all (the board only checks a limited number of machines), so it now says "Couldn't check
<machines>, so this may be out of date", which is true in both cases.

**What is not changing.** No server code, no data, no permissions. Only two dashboard script
files and one stylesheet change. Reverting them restores the old page exactly.

**What the reader needs to decide.** Nothing; it restores a requested control and corrects one
sentence.
