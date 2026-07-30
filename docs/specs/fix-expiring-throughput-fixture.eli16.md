# Stop a test from expiring on a calendar date — Plain-English Overview

> The one-line version: a test had two dates typed into it and quietly stopped passing when the calendar moved past them, turning every open pull request red for a reason unrelated to anyone's code.

## The problem in one breath

One test checks a dashboard route that answers "what merged in the last seven days?". To do that it feeds the route a fake merged pull request. The fake had two dates written into it as literal text. The route only keeps pull requests merged inside the last seven days — so the moment the calendar moved more than seven days past that typed-in date, the fake stopped counting, the route correctly returned nothing, and the test failed.

It expired at midday today. Every open pull request went red within the hour, mine included, and none of them had touched that code.

## Why this is worth more than the one-line fix

This is a test that passes for a week and then fails for a reason that has nothing to do with what it is testing. That is worse than a test that simply breaks, because the failure arrives detached from any change — so whoever hits it reasonably assumes their own work caused it and goes looking in the wrong place. I did exactly that: I checked whether opening my pull request had changed the data the test reads, before noticing the test supplies its own data and the only moving part was the clock.

It also blocks everyone at once. A shared pipeline that goes red on a date rather than on a change stops all delivery until somebody happens to investigate.

## What already exists

- **The route being tested** keeps a merged pull request only when its merge date sits between "seven days ago" and "now". That behaviour is correct and is not changed here.
- **The test's own fake data** — the test does not read the real repository, it supplies a made-up pull request. So nothing about real activity affects it, which is what makes the diagnosis clean.

## What this changes

The two dates are now worked out relative to the moment the test runs — merged yesterday, opened the day before — instead of being typed in. They will always sit inside the seven-day window, so the test can no longer expire.

One detail deliberately preserved: the gap between "opened" and "merged" stays exactly twenty-four hours. The route turns that gap into a speed score, and the test checks that score, so widening or narrowing the gap would have quietly changed the expected number and required editing an assertion that was never wrong.

## The safeguards

The comment left in the test names the exact failure, including the two literal dates that expired and the hour it happened. The next person to reach for a hardcoded date in a time-windowed test has the reason not to, written where they will be looking.

## What you actually need to decide

Nothing. This restores a test to testing the thing it was written to test. The only judgement call was keeping the twenty-four-hour gap rather than adjusting the expected score, and keeping it means no assertion changes at all.
