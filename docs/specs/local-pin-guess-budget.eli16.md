# Wrong PIN guesses from the machine itself are limited too — plain-English overview

## What this is

Your dashboard is protected by a PIN. Guesses from the internet were already limited. Guesses typed on the machine itself were never limited, so that someone on the internet could never lock you out of your own computer.

## What changes

Other programs running on the same machine also count as "on the machine", so unlimited local guessing was a gap. Now, after 10 wrong PINs in a few minutes from a browser or program that has never unlocked before, PIN entry from the machine pauses for a few minutes and you get one alert. A browser you've unlocked before is never limited, and internet guessing can never use up your local allowance.

## What you would notice

Nothing when you unlock normally. If you mistype your PIN ten times in a row in a new browser on the machine, wait a few minutes or use a browser you've unlocked before.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
