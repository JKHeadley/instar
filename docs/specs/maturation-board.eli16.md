# Maturation Board — in plain English

## What this is

Instar ships many features switched off ("dark") or in a practice mode first, then turns them on for
more agents as evidence comes in. Three times a week a review job on the Studio looks at about 180 of
these features and writes down, for each one, how it is doing: live, on track, blind (nothing is
being recorded), stalled, regressed, or too new to judge. It also writes what it decided and which
follow-up item is fixing it.

That record exists, but it is a long markdown file on one machine, and the Telegram summary of it is
five short lines. Justin asked for something he can actually look at: one page listing every
maturing feature, its stage, what data measures it, what the evidence says, whether it is moving,
what is being done when it is stuck, and dates — when it was expected to move versus what really
happened. With colours, filters and sorting, on its own and inside the new dashboard.

## How it works

The board is only a view. It reads what other parts of the system already record: the review files,
the follow-up items they name, the record of when each switch was first seen off and its deadline,
the six-hourly readiness checker, the rollout records, and the live safety-check posture. It joins
them by feature name and shows the result. It stores nothing, changes nothing, and has no opinion of
its own: the "is it progressing?" answer is the review's verdict, word for word. The only things it
works out itself are simple arithmetic: how many days past its expected date a feature is, and how
many reviews in a row gave the same verdict.

When two parts of the system disagree about a feature (one says ready, another says unproven), the
board shows both and marks the row, instead of picking one. When a feature is stuck and nothing is
being done about it, the row says so plainly, because that is the most useful thing on the page.

## What changes for the user

The review job now also saves its table as data, and its Telegram message ends with a link to the
board. The page opens on a phone through the agent's normal tunnel with the dashboard PIN. Nothing
about how features are promoted changes.

## Tradeoffs

Older reviews were written only as markdown, so the board reads their tables loosely and counts
any row it cannot read rather than guessing. Review files live on the machine that ran the review,
so the page always asks every machine and merges, which costs a few seconds when a machine is slow.

## Revision: made for a glance (30 Oct)

The first version showed everything at once and Justin found it impossible to digest. The page now
opens with one sentence ("182 features: 69 working, 97 need attention"), a coloured square for each
feature, and plain groups such as Broken, Stuck and Working. Each feature shows a human name and one
short label saying whether anyone is on it. The detailed evidence is still there, one tap away. The
review job now also writes a one-line plain description and a next step for every feature, so each
row can say what is going on in everyday words.

## Revision: the useful middle (30 Oct, afternoon)

Justin's next note: the text was either too vague ("Was working, now isn't") or too technical (raw
counts and ids). Each feature now leads with one dense line, like "41% of checks failing (goal:
under 5%) · up from 14% · fix due Nov 4". Tapping it shows five short lines: what it does, what has
to be true for it to move up, where it stands now compared with its goal and with the last review,
the plan, and the due date. The raw evidence is still there, folded away. A feature with a written
plan but no task yet now says so, instead of "nobody on it".
