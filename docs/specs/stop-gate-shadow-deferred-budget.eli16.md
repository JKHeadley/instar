# Stop-gate shadow recording runs on its own budget — plain-language overview

## What this is

When an agent session stops, a small hook asks the agent's server "was that stop
justified?" A judge model answers. One of the things it watches for is the agent
quietly handing its own work back to the operator ("want me to do X, or steer me
elsewhere?") — the self-deferral guard. Right now that guard is in a trial run
("shadow"): it only writes down what it would have said, so we can check it is
accurate before it is ever allowed to act.

## What went wrong

The trial run has written down nothing since 20 August. The judge is given two
seconds to answer, because in the eventual "enforce" mode the session waits for
the answer before it can stop. But the judge on this machine runs on Codex, which
takes about five seconds. Every single call ran out of time: of 1,253 calls in the
last week, the fastest took 2.005 seconds. After a few timeouts in a row the gate
pauses itself, so for two months it sat paused, trying once every five minutes,
timing out, and pausing again. The metrics looked fine (the calls finished), but
the answers arrived after the gate had already given up on them.

## What changes

In trial mode nobody acts on the answer, so there is no reason to make the session
wait. Now, in trial mode, the server tells the hook "fine, stop" straight away, and
then lets the judge take up to 30 seconds. When the answer comes back it is written
down as before. At most four of these background judgments run at once; a stop
that arrives while four are already running is not judged, and that is counted.

The "enforce" mode (not switched on anywhere) keeps its two-second limit,
unchanged.

## What already exists and is reused

The same judge, the same database, the same pause-after-failures safety, and the
same rows. Once the first background judgment succeeds, the pause resets itself;
no manual repair is needed.

## What to decide

Nothing. The trial's 30-day clock restarts from the first row written after this
ships. One known limit is recorded for later: if enforce mode is ever turned on for
an agent whose judge is on Codex, it will still time out, because a stop cannot be
held for five seconds. That goes to the feedback queue for whoever decides on
enforce.
