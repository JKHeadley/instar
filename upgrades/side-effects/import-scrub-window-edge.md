# Side effects: windowed secret scrub for long imported messages (SEC-112)

Tier 1. Size: 1 source file (about 70 lines), 7 unit tests. Effort: one build pass, two independent review rounds.

## What changes for running agents
- Only imported messages over 1,000,000 characters take the changed path. Shorter texts are scrubbed exactly as before (`scrubOne`).
- Long texts are scanned in 1 MB windows that overlap by 65,536 characters; spans are kept in whole-text coordinates and merged, so a match found in two windows is removed and counted once.
- A match that runs into a window's end is removed through to the next whitespace (fail toward removal). In text with no whitespace (minified JSON, base64) this can remove much more than the secret; any removal over 1,024 characters says how much it removed (`[removed: looked like a secret] (N characters)`), so a reader knows text is missing.
- Scan cost rises by at most the overlap per window (about 7%). A scrub error inside one window withholds that window's text, as before, and the marker states the length removed.
- No stored data, config or routes change. Already-imported history is not rescanned.

## Signal vs authority
No decision point. The scrub is a deterministic safety floor before storage.

## Rollback
Revert the commit.

## Not covered here
A JWT whose middle segment alone is longer than 65,536 characters, or a label separated from its value by more than 65,536 whitespace characters, can still be split. Neither is a realistic credential shape. History imported before this fix is not rescanned. The import shipped days before this fix and only messages over 1,000,000 characters took the old path. These three residuals are tracked as open rows under SEC-112 in the security findings ledger, which the security owner reviews each pass; they are not left as notes here.

## Second-pass review
**Reviewer:** independent read-only review subagent (fresh context, ran the unit file plus its own probes against a copy). Round 1 concurred and named one residual: a labelled value longer than the overlap that crossed the edge leaked its tail, because the next window started at the value and lost the label. Fixed by removing any edge-touching run through to the next whitespace; tests now reach the back-up branch with a 100,000-character labelled value. Round 2 concurred: every prior finding resolved or documented, termination still linear (5 MB of key runs in 209 ms). Its non-blocking note (over-removal in whitespace-free text) is answered by the length note on long removals.
