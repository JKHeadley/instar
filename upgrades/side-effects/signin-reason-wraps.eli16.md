# A sign-in that needs you now says why on a phone

**What this is.** The dashboard's Accounts page has a "Needs you" card. Each row says which account needs a sign-in, with one line under it explaining why. That line was held to a single line of text and cut off with dots when it did not fit.

**Why it matters.** On a phone-width screen, the reason an account needs signing in read "This slot holds echo@sagemind..." with the rest hidden and no way to tap to see more. The operator was being asked to act without being able to read why.

**What changed.** One style rule: inside any "Needs you" card, the explaining line now wraps onto as many lines as it needs. A test checks that the rule stays.

**What did not change.** No wording, no counts, no sign-in behaviour, no server code. Rows outside "Needs you" cards still stay on one line, including the short list on Home, which leads to the full page.

**How it was checked.** The new style was loaded on the live Accounts page at phone width: the full sentence shows, across three lines, and the page does not scroll sideways.

**If it is wrong.** Reverting the one line restores the old look. Nothing is stored or migrated.
