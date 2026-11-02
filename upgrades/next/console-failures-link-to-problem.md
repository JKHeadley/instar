## What Changed

- When a machine does not answer, the dashboard's note about it (on Sessions, Schedule and the home screen) now links to the Machines page, where that machine's state is shown.

## What to Tell Your User

"This machine did not answer" notes now link straight to the Machines page.

## Evidence

- A scan of every dashboard page for failure wording without a link found only the Sessions page's unanswered-machine lines; Schedule and the home screen use the same wording. Unit tests cover which notes get a link.

## Summary of New Capabilities

None. This adds links to existing notes.
