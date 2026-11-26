# Two things stopped freezing the server

## What was wrong

The server does all its work on one main line. If one job holds that line, nothing else gets a turn: no replies, no health answers. After enough missed health checks the supervisor kills the server, and any test run on it dies too. That is why the Studio kept restarting and merges crawled.

Live profiles caught two jobs holding the line.

The first was the feedback executor. When a fix attempt finished, it compared the attempt's copy of the code with a clean copy by reading every file in both, one after another, while holding the line. That is about 21,000 files, twice. On a busy machine it held the line for over 84 seconds, and the server was killed.

The second was the session list. Each time anything asked for the list of sessions, a small background check asked the session reaper for a full report, which starts several small programs for every running session. The check only needed the session ids.

## What changed

The executor now reads those files in a way that lets other work run between reads. The disk-size check that walks the same folder on every round now does the same. The checks are the same and run in the same order; only the waiting changed. On a tree of 21,261 files the comparison took 40.5 seconds and the longest pause for anything else was 50 milliseconds.

The session list check now asks for the ids alone, so it starts no programs. The full reaper report is still there for whoever asks for it directly.

## What this does not cover

Deleting a finished attempt's folder is still done in one go. It did not show up in these profiles, so it is not changed here. Whether other machines froze for the same reason is not yet known.

## What you need to decide

Nothing. If it goes wrong, reverting the change puts everything back; no settings or stored data changed.
