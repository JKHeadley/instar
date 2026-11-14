# Console Home: one answer to "what needs you" — plain-English overview

## What this is

The console is the new home screen of the agent's dashboard. Its first job is to answer one question for the operator: does anything need me right now? The operator opened it on their phone and saw two parts of the same screen contradict each other. The big sentence at the top said "One thing needs you." The box right underneath, titled "What needs you", said "Nothing needs you."

They were both computed honestly, but from different sources. The top sentence added up two things: items in the attention list that need a person, and promises the agent made that are waiting on the operator (for example, "merge each pull request as soon as you approve it"). The box only looked at the attention list. So whenever the only thing waiting was a promise, the screen said yes and no at once.

The same box also printed: "No answer from m_a804869356b259820b3236e7c5a2ae7d. 420 routine notices kept in the log." The long code is a machine's internal id, shown because that machine has no name on file. "Routine notices kept in the log" is internal bookkeeping that asks nothing of the operator. The operator asked for a hard rule that nonsense like this never reaches them.

## What already exists

The console already refuses to show "all fine" when it could not read something; a card that could not load says "Can't tell". There is a separate "What I've promised" box that lists promises. Machine names come from the machine pool.

## What changes

The "What needs you" box becomes the one answer on the screen. It now includes promises waiting on the operator, marked "a promise waiting on you", and the top sentence counts exactly that box. They cannot disagree any more. If promises could not be read, the box says so instead of claiming nothing needs the operator.

Machines are always shown by name. A machine with no name is described as "a machine with no name on file", with what that means: "Couldn't reach it, so its items may be missing." The bookkeeping line becomes "420 automatic notices need nothing from you", and "1 need you" becomes "1 waiting on you".

## The safeguard

A new automated test runs every part of the home screen against a spread of situations, including an unreachable unnamed machine, and fails if any visible text contains a raw machine id, a long hex code, words like "undefined" or "null", or the known internal phrases. It is checked against the exact line the operator reported, so the test is proven to catch it. A future change that reintroduces this kind of text fails before it can ship.

## What the reader needs to decide

Nothing for this change; it is display-only and a revert undoes it. Making "never show internal text to the operator" a constitutional standard for every surface is a separate decision for the operator.
