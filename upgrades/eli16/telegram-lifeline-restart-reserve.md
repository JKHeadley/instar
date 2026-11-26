# Keep Telegram replies moving during a Lifeline restart

A running server could have a reply ready while Lifeline was restarting. Lifeline owned the local send permission socket, so the server had to wait for the replacement process even though the machine still held the Telegram lease.

The dark rehearsal keeps one send slot available to the server and gives the Lifeline nine of the original ten slots. The server uses its slot only when the credential socket is absent or explicitly refuses the connection. It still checks the lease and the request's original deadline. An explicit denial from a running owner and a socket timeout still leave the reply pending. The retry uses the same retained operation and Telegram receipt.

Both processes need compatible configuration before this can be turned on. This checkpoint leaves startup wiring off while the paired deployment and rollback are verified.
