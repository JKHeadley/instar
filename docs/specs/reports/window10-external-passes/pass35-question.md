# External review pass 35 — THE QUESTION, recorded before the reading

Fifth archived question. Held near-identical to passes 33 and 34: the series measures the tree, and a brief
that drifts measures itself.

## Frozen tree

`e4c7c1cdc` on `echo/window10-deep-property-guards`. Clean, `local == remote`, verified by command.
Memory checked at 40% free before dispatch, per the standing rule earned by two readings that died on a
saturated machine.

## What changed since pass 34

Pass 34 returned UNSOUND at 5 (4 DESIGN, 1 PRECISION). **Three repaired; two confirmed-open.**

**Repaired:**
1. **An over-refusal caused by two of my own repairs INTERACTING.** Making a content refusal terminal
   (pass 30) blocked the plain-text fallback that pass 34 showed would have rendered the payload visible.
   The extraction now separates two cases: an **EMPTY** extraction means no text nodes at all — pure
   markup, undecidable without Telegram's parser, so it **ALLOWS**; a **NON-EMPTY but invisible**
   extraction is **DECIDED** and stays refused.
2. **The extraction did not decode what Telegram decodes.** Character references are decoded before
   judging; the Markdown branch consumes emphasis and code delimiters, not only links.
3. **The funnel lint knew nothing about the post-format guard.** It now requires it on senders that RUN
   the formatter, and not on the four direct senders that never format.

**CONFIRMED OPEN — stated so this reading attacks the openness rather than rediscovering it:**
- **The send-funnel check cannot prove a call resolves to the imported guard.** It checks a bare-identifier
  callee and an import separately and never RELATES them. **The comment in that file claims name
  resolution the analysis does not perform, and that claim is false.**
- **Method classification covers only direct literal shapes.** A method carried through a variable, enum,
  expression or wrapper is unclassified.

Both are answered by consolidating to one shared client, which is registered and dated, not by a further
matcher.

## THE QUESTION — asked in full, with the answer withheld

**Judged fresh, as a first reader, is this tree sound?** Answer on your own evidence.

Then, separately:

- **What did the last repairs break?** The decided/undecidable split is new blocking-and-allowing behaviour
  on the send path. Does it allow anything a reader would in fact receive as nothing, or refuse anything
  they would have seen?
- **Do any two repairs INTERACT?** Pass 34's best finding was that two individually-correct repairs of mine
  combined into a defect. Reviewing each change alone would not have found it.
- **Where does a check's REASONING fail to support the claim it makes?** State it as an analytical claim
  about the code — which inputs or code paths the logic does not reach — with file:line. The author
  constructs and runs the cases.

**Explicitly NOT supplied:** any expected verdict, any count, any claim about convergence, the trajectory.

**Refuting the account above is the more valuable result.** It is the author's account, not evidence, and it
has been wrong in each of the last five readings.

## Sections required

`FINDINGS` · `REGRESSION-CHECK` · `FRESH-ATTACK-REPORT` · `MY-ACCOUNT-CHECK` · `MAGNITUDE-METRIC` ·
`TRAJECTORY` · `CONVERGENCE` · `COHERENCE` · `VERDICT`

Each finding **declares its class** — DESIGN or PRECISION. The magnitude metric **states its exclusions**
beside the number. If you mutate any file, restore it and report whether the tree is clean.
