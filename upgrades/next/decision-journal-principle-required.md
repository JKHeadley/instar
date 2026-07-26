# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`POST /intent/journal` now refuses two kinds of submission instead of accepting them silently: one
that names no guiding `principle`, and one carrying field names no reader consumes. The route
previously spread the request body straight through with no validation, so an invented key was
persisted where nothing would ever read it and the write returned 201.

`GET /intent/journal/stats` gains `principledCount` and `unprincipledCount`. Previously
`topPrinciples: []` was byte-identical between an empty journal and a populated one where nobody had
filled `principle` — so the surface built to detect unreasoned decisions could not distinguish its
own worst case from a clean slate.

The machine-generated dispatch path (`DispatchDecisionJournal` → `AutoDispatcher`) is deliberately
exempt: an auto-applied dispatch has no principle to cite, and gating it would break automatic
dispatch to buy nothing.

## What to Tell Your User

If you keep a decision log, it now refuses to record a decision that does not say what guided it,
and tells you so instead of accepting it quietly. It also refuses field names it does not recognise,
listing them back and pointing at where the content actually belongs.

That second refusal is the one that matters, and it comes from a real mistake. An agent recorded
several decisions using field names it had invented, believed the reasoning was saved, and reported
as much. The values were stored somewhere nothing reads. The write succeeded, so nothing could have
caught it. Now that submission fails immediately and says which fields are wrong.

Be honest about the boundary: this makes it impossible to record a decision that claims no guiding
intent. It does not make anyone actually weigh a choice against your stated goals before deciding.
Any non-empty answer clears the gate. It closes the gap between deciding and recording, not the gap
between deciding and thinking.

If you already have entries with no principle, they are left alone rather than rewritten. The two new
counters will report them for what they are.

## Summary of New Capabilities

No new endpoint. An existing write path gained a refusal, and an existing read surface gained two
counters that separate "nothing decided yet" from "many decisions, none said why".

## Evidence

- Unwiring the validator from the route leaves the unit suite fully green (11/11) while four
  integration tests fail — the module-guarded-but-unwired class, reproduced deliberately.
- Swallowing unknown fields: 5 failed | 12 passed. Dropping the principle requirement: 5 failed |
  12 passed. Reverting the counters: 4 failed | 13 passed.
- Restored: 188 passed across the five affected files; `tsc --noEmit` exit 0.
- A refused submission writes nothing — asserted against a live journal reporting `count: 0`.

## Known limits

The requirement is satisfied by any non-empty string; nothing distinguishes a genuinely-consulted
principle from a plausible one typed to clear the gate. Nothing here fires at the moment of decision
to put the goal hierarchy in front of the agent — that trigger is separate work and is not included.
Existing unprincipled rows are not repaired. The journal is per-machine, so the counters answer "on
this machine". <!-- tracked: CMT-1044 -->
