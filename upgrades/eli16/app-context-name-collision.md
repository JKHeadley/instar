# A name clash that broke the build

When the app sends a message to a session, the server writes a small notes file for that session. A recent change made that write refuse to overwrite a file, which is a good safety step. The file name only used the clock, though, down to the millisecond. So two writes in the same millisecond got the same name, and the second one failed. A test caught this every time on main, which stopped every other change from passing.

The name now ends with a few random characters, the same way the file next to it is named. The safety step stays. Nothing else changes, and reverting this puts everything back.

## Why it matters beyond the test

The same clash could happen for real. If someone sent a message from the app at the moment their session was starting, both steps wrote the notes file together, and the message could fail instead of reaching the session. It was rare, because the two writes had to land in the same thousandth of a second, but a fast start makes that likely.

## What you need to decide

Nothing. This goes first in the test queue because every other change is waiting on it.
