# Side effects: Machine care offers only what the server can do

## What changed

`dashboard/console/machine-care-model.js` decided which buttons a row shows as if every server had the operator controls. An older server (watch-only, before Part F, for example caf469876) sends no `controls` object and has no skip or window route. Absent `controls` read as "not skipped", so the page offered Skip once and Change hours. The owner could unlock with the PIN and then never save the skip. Found by a compatibility review, relayed by echo-token-pacing.

Now:
- Skip, Undo skip and Change hours appear only when the answer carries `controls`.
- Restart now appears only when the answer carries the `restartNow` key (null or a countdown) and the machine is signed up.
- Sign up and Off already needed an enrolment reading, which older servers do not send.
- A 404 from any control route reads "This machine runs an older version that can't do that yet."

## Side effects

- Current servers send `controls` and `restartNow` on every answer (DrainRehearsal.status and the /machine-maintenance route), so nothing changes for them.
- Signal, not authority: this only hides buttons. Every route still checks for itself.
- Rollback: revert the one file. No stored state changes.

## Tests

`tests/unit/console-machine-care.test.ts`: a watch-only answer (`{enabled:true}`, and the full pre-Part-F shape) offers no button. An enrolment-era answer offers Sign up and Off but not Skip, hours or Restart now. A 404 answers in plain words.
