# Enrollment completion drift-clear lag — ELI16

After you finish signing an account back in, the server may still remember the identity it saw before login for up to one polling interval. That can leave the account marked as drifted and make the grid briefly say “Needs sign-in” even though sign-in just succeeded.

The completion endpoint now throws away that old identity observation and immediately checks only the repaired account. While that check catches the durable pool row up, the browser's fresh completion result wins over the stale failure label and shows “Set up complete.” Already-active cells keep their existing active styling and success highlight.

If the immediate usage check is temporarily unavailable, enrollment still succeeds. The old identity cache is already invalidated, so the normal scheduled poll retries with fresh evidence.
