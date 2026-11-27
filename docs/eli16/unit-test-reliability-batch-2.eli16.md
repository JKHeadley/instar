# Unit test reliability, batch 2 — the plain version

## What this is

Some of our automated tests failed when the test machine was very busy and then passed when run again by themselves. A test like that is a nuisance: it makes a good change look broken, and people learn to ignore red results. This change repairs three such test files. It changes tests only. The product itself is untouched.

## What was wrong

The three files all made the same kind of mistake: they guessed at time.

- One test checked that a script slept for one second and not four. It did this by timing the whole script from the outside. On a busy machine just starting the script took four seconds, so the test failed even though the sleep was correct.
- One test waited exactly two seconds for a slow disk write to finish, then gave the next step only one second. On a busy machine that was not enough.
- One test waited 30 thousandths of a second for a piece of work to wind down before asking again. Sometimes the wind-down took longer, and the test got the old answer back.

## What changed

Each test now waits for the thing it actually cares about. The first asks the script which sleeps it requested and checks that it asked for exactly one second. The second waits until the saved row can really be read. The third waits until the reader says it is no longer busy. Every wait has an upper limit, so a truly broken product still fails the test, only a little later.

Nothing was removed from what the tests check. In one case the check is stricter than before.

## What was left alone

Two other test files fail for a different reason: the product itself gives a helper program only two or three seconds to answer, and on a busy machine that runs out. Fixing that means changing the product, which this change does not do. Those two are reported so someone can decide.

## What you need to decide

Nothing for the three repaired files. For the two that were left alone, whether the product's short time limits should be looked at.
