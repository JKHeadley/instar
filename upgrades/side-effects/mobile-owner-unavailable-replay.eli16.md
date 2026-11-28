# Resume Saved Mobile Messages After Reconnect

When your app sends a message, the server saves it before trying to deliver it. If the machine that runs the chat is unavailable at that point, the server now remembers that it has never tried delivery. When the app repeats the original request after that machine comes back, the server can deliver the message it already saved.

The original message and files keep their identity. If two retries arrive together, one can take over delivery and the other sees that work is in progress. If the server loses track of a delivery it already started, it still reports the uncertain outcome so the message is never blindly dispatched again.
