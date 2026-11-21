# Marking two intended fallbacks

The repository has a test that counts places where the code catches an error and quietly carries on. It must never go up. PR 3490 added two such places, both in the cleanup code for old work copies, and the count went from 494 to 496.

Both are deliberate. When the code cannot work out the real location of a folder, it falls back to the folder name as written. That is the safe direction: a folder it cannot locate is never treated as inside the area it is allowed to clean, so nothing extra can be removed because of it.

This change adds the standard comment that tells the test these two are intended and explains why. It changes no behaviour. The count goes back to 494.

What needs deciding: nothing. It is a comment-only change that lets PR 3490 (moving old work-copy removal off the server's main thread) pass the merge line's check. The two lines were found by comparing the test's list of flagged places on main with the same list on PR 3490's branch: only this file differed, by exactly these two lines.
