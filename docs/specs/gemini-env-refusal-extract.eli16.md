# A test that fails because this computer is not logged in, not because the code broke

## The situation

Two tests run the real Gemini command-line tool and check that it answers. They
decide whether to run by asking one question: *is the tool installed?*

That is the wrong question. A tool can be installed and not logged in. When that
happens it refuses immediately, before it ever sees what we asked it — so the check
underneath cannot pass and cannot meaningfully fail either. It just reports that
this computer has no credentials.

The shared build machines have no Gemini tool installed at all, so they skip
cleanly and everything looks green. The only machine that goes red is a developer's
machine that happens to have the tool installed. That is backwards: the better
equipped the machine, the more it fails.

## What changes

The tests now look at the reason the tool gave. If it named one of the reasons that
are about this computer rather than about our code — no credentials, a quota used
up, a version manager pointing at nothing — the test skips and says loudly why. Any
other failure still fails, exactly as before.

## Why not something simpler

The tempting version is to ask up front "can this machine talk to Gemini at all?"
and skip everything if not. That is worse, and deliberately rejected: it would also
skip when something is genuinely broken but intermittently, so a real problem would
vanish on a bad afternoon. Matching only the reasons the tool itself names means we
skip for causes it explicitly reported and let everything else fail visibly. A false
red is annoying and gets investigated; a silent skip is invisible and does not.

## Why this is arriving on its own

This fix already exists. It was written a few hours ago inside a much larger change
that is waiting on a human decision about something unrelated. So a working fix for
a genuinely failing test has been sitting behind a gate that has nothing to do with
it. Pulling it out on its own is the whole point of this change — nothing here is
new work, it is the same fix, standing by itself where it can land.

## What you would notice

On a machine with Gemini installed but not logged in, two tests stop failing and
start saying "skipped — this machine has no Gemini credentials." Nothing else
changes.
