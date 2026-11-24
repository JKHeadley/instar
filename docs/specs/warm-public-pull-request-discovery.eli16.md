# Make the first Work search ready

Instar will start loading the public pull request list when it starts and keep that list up to date in the background. If you search while the first load is still running, Work will keep the first search open long enough to use the result. Usually, the list will already be ready.

It shares the list with the Chief of Staff lookup. The words you type stay on your machine. If GitHub is down or the list can no longer be verified as public, Work says what it could not check. The lookup only finds evidence and never starts work for you.

Work still shows when GitHub was last checked. An older list can point to a useful pull request, and Work labels that evidence so it cannot be mistaken for a new check. Pull request text and the words you search for stay out of the quota record. That small record only keeps Instar from spending the same GitHub allowance again after it restarts.

This first version can be enabled on one named development installation. The background scan uses the same public inventory as the existing search. Clearing a browser view stops waiting without interrupting someone else's request. The wider rollout needs proof that the ordinary setup behaves the same way.
