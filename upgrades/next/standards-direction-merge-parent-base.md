# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The standards check's approval guard now compares a pull request against the same copy of main that the test run checks, instead of the older copy recorded at the pull request's last push. Standards that arrived on main in the meantime no longer look like the pull request's own additions. CI only; agents are unaffected.

## What to Tell Your User

Nothing; this only affects how Instar itself is developed.
