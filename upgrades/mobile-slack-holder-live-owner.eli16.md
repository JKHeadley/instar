# Keep a waiting history read private when phone access changes

When your phone opens a Slack conversation held on another machine, the server may wait for that machine to answer. Checking the phone only when the request arrives leaves a gap: you could revoke the phone while the server waits, but the reply could still contain private history.

The server now remembers which phone key and person actually signed the request. Before each connection attempt and again before returning history, it checks that the phone is still active, its key and person have not changed, and its owner access is still valid. It also checks the recorded revocation intent even if updating the phone list failed. A named owner must still exist in the people list and still qualify as the owner. Turning pairing or native conversations off also stops the waiting read.

If the server cannot check revocations, it refuses this remote read. Older owner phones that were paired without a named person keep working when their current permission can be checked. A changed key or person needs a new signed request rather than letting an old request inherit new access.

The app uses the same history route. Sending messages and downloading files from another machine are separate work. This change does not deploy anything or enable the new Conversations hierarchy.
