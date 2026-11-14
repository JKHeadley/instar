# Class review list: one pass, not one per item

The app's "How I'm doing inside" screen shows the agent's class reviews, which are records kept on each machine. To list them, the store went through every key, and for each key it re-read and re-checked every record copied from the other machines. With a lot of records that work grows very fast. On the Studio it froze the whole server for about eleven seconds each time the screen was opened, and a plain health check had to wait behind it.

This change reads the other machines' records once per list, then merges each key from that single read. The merge itself is the same code as before, so the answer does not change. A test checks that the list gives the same result both ways and scans only once.

Nothing changes for how records are stored, shared or trusted. Reads that fetch one record still work as they did. If this turned out wrong, reverting the commit puts the old behaviour back. There is nothing to decide here: it removes a server freeze from a feature that is already live.
