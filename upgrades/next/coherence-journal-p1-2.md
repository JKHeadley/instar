<!-- bump: minor -->

## What Changed

**Coherence Journal P1.2** — the read API. `GET /coherence/journal` serves
the merged placement / session-lifecycle / autonomous-run history from
local disk: skew-proof `(epoch,ts)` ordering for placement, replica entries
labeled with `source:"replica"` + `stalenessMs`, `(topic,epoch)` dedupe,
bounded reverse-tail reads (byte ceiling + archive caps; placement stays
answer-complete), opaque keyset cursors, corrupt lines skipped + counted.
New `lint-journal-actuation-ban` build-enforces §3.9 (actuators may not
import the reader). CLAUDE.md template teaches every agent the capability.
TelegramAdapter emergency-stop now reports its journal line instantly.

## What to Tell Your User

If your agent runs on more than one machine, you can now ask it "which
machine was this conversation on last night, and why did it move?" or
"where did the overnight run put its files?" — and it answers from a
durable history instead of guessing. (Multi-machine sync of those
histories lands in the next update; today each machine answers from what
it holds.)

## Summary of New Capabilities

- `GET /coherence/journal?topic=N&kind=...&machine=...&limit=...&cursor=...`
  — merged journal view; read-only; 503 when the journal is not enabled.
- Agents proactively reach for it on "where did topic N live / where are
  the artifacts?" questions (CLAUDE.md template entry ships in this
  release).

## Evidence

- 22 new reader/route tests + Tier-3 e2e lifecycle (feature-alive, 503
  when dark); actuation-ban lint clean over 8 actuator modules; tsc + full
  lint chain clean.
