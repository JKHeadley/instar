# Plain-English overview — console tests stop depending on today's date

## What happened

Two automated tests check the dashboard's Plans and Promises pages. Their sample
data was written as "this plan was last touched two hours before 25 October
2026". The page itself, though, looks at the real clock to decide whether a plan
is still moving. A plan untouched for more than seven days counts as idle, not in
flight. On 1 November the real clock passed that seven-day line, so the sample
plans suddenly looked idle, and the Plans test failed every time. Because that
test runs on main, main was marked red, and the verification queue stopped
running other changes until main was fixed.

## What already existed

The tests already had a fixed "now" for building their sample data. Other
console tests (for example the Schedule page) already pin the clock the same way
this change does.

## What is new

Inside the two page tests, the clock the page reads is set to the same fixed
"now" the sample data uses. Only the date is pinned; ordinary waiting still uses
real time, so the page loads exactly as before. The Promises test had the same
hidden problem and would have broken a few weeks from now, so it gets the same
fix.

## Safeguards

This touches tests only. No code that ships to any agent changes. We checked by
running all seventeen console page tests with the computer's clock pushed more
than a year ahead: every one passed.

## What a reader needs to decide

Nothing. This is a small, fully reversible test repair. If it were wrong, undoing
the two test files puts things back exactly as they were.
