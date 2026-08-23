# Saying how much was checked, not just that it passed — Plain-English Overview

## The problem in one breath

A safety check in this project spent an unknown period reporting "clean" about documents it had never opened. It found the section it cared about by matching a heading word-for-word, and authors had started numbering their headings. It quietly saw 91 documents out of 149 and skipped 58 — including some of the most important ones — and said the same reassuring word it says when everything really is fine.

## What already exists

That matching bug was fixed on the 21st. The check now finds numbered headings properly.

## What this adds

The check now says **how much it looked at**, not only what it found.

Before: `clean`
After: `clean — 0 findings across 149 documents, 91 carrying the section we grade`

## Why that matters more than it sounds

Fixing the matcher fixes that one drift. It doesn't fix the next one. The set of documents can shrink again for reasons nobody records, because no author does anything wrong — and the verdict stays the single most comforting word available.

"Clean" is a sentence nobody questions. "Clean, 91 of 149" is a sentence somebody does. A shrinking number next to a reassuring word is the cheapest thing that would have caught the original problem without anyone going and auditing the checker, and it costs one line.

## The safeguards

**Nothing can newly fail.** Every verdict and exit code is identical; only the wording changes.

**A file that couldn't be opened is counted, not skipped.** A document that failed to load is not a document with no problems — silently dropping it is the same defect one level down.

**The tests pin the point, not the wording:** a run over one document and a run over two must not print the same sentence. That's the property the whole incident turned on.

## What ships when

Immediately. Nothing to decide, no setting, no risk.

## What you actually need to decide

Nothing. One honest thing surfaced on the first run and is written into the notes rather than smoothed away: the old comment records 149 documents carrying that section; the live count is now 133. I haven't chased down whether that's drift, a different counting method, or documents legitimately removed — but a number disagreeing with a documented number on the very first run is exactly what this change was built to produce.
