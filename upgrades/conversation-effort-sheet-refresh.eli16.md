# Conversations: the list updates when you close a sheet

Conversations is still off by default. On the dashboard, you create an effort and name it in a small panel called a sheet. If you saved a change and then closed the sheet with the × button, the list behind it stayed out of date, so your new effort seemed to be missing until you left the page and came back. The Done button did not have this problem.

Now the list refreshes once when a sheet closes after a change, whichever way you close it. If you close a sheet without changing anything, nothing reloads.

This only affects what the dashboard shows. No stored data changes, and nothing else behaves differently. A test covers both ways of closing, and that test failed before the fix.
