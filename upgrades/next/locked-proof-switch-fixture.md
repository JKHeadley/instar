<!-- bump: patch -->

## What Changed

The locked-Mac proof scripts can create and remove a second throwaway macOS account,
instarproofswitch, for the proof case that switches the console to another user and back.
The account choice is a closed option, so the scripts cannot be pointed at a real user.
Creating an account now also checks that it is not an admin, and removal refuses an account
that is on the screen, may be an admin, or was not made by the script.

## What to Tell Your User

Nothing changes for day-to-day use. The locked-screen proof run can now do its switch-user
check with a throwaway account instead of a person's own account.

## Summary of New Capabilities

None. Developer proof tooling only.
