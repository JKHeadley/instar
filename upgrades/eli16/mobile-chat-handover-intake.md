# Save the app message before claiming it is waiting

An app message could be refused while the machines were changing which one was responsible for receiving it. This first checkpoint adds a way for the app request store to remember that an exact message is waiting. The caller must save the signed message itself before recording that status. The request record keeps the message identifier and the original content fingerprint, so the same request can recover its original result after a restart. Reusing the request identifier for different text or a different conversation is still refused.

This checkpoint is an internal building block. The app send route still behaves as before. The next checkpoint needs to move the authenticated message to the current holder and make that machine claim it once before trying to deliver it.
