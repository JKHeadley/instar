# Telling the error checker why one catch is fine — Plain-English Overview

> The one-line version: a small helper that reads the prompt detector's answer was counted as hiding an error; it now says why it is not.

## The problem in one breath

The project counts places that catch an error and carry on quietly, and the count may not go up. The new helper that asks "does this answer mean the session is waiting on a question?" treats an answer it cannot read as "no". The checker counted that as a quiet error.

## What this changes

Nothing the program does. The helper now carries a note: an unreadable answer means "not waiting", exactly how the existing detector already treats an unreadable answer.

## The safeguards

Comment only: no behaviour, no interface and no limit changes, and the count stays where it was. Removing the comment undoes the change completely.
