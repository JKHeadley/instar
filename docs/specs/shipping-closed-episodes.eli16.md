# Keep closed pull requests out of Shipping

The Development page shows pull requests whose automated merge attempt reached a stopping point. These are useful while the pull request is open, but a pull request that someone later closes or merges can remain on the page. That makes the count look larger than the number of pull requests anyone can still fix.

The merge watcher will check a few of these old entries during each normal refresh. It clears an entry only after GitHub confirms that the pull request is closed or merged. GitHub can omit open pull requests from the watcher's regular list, so an entry missing from that list receives a direct check. An unavailable or unclear result leaves the entry in place. Clearing the entry removes it from the Shipping count and records the reason in the existing audit. This change does not request a merge, close a pull request, or grant any permission.
