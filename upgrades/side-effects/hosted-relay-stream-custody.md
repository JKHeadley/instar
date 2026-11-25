# Side effects of optional relay stream custody

The disposable coordinator connects the lease gate to a tunnel's stream factory. It checks custody before opening and before returning a stream. Reconnect or takeover closes the previous connection and every stream it owns.

- A stale, expired, withdrawn or replaced lease closes its streams when checked. The listener must run periodic sweeps while active. Existing streams are intentionally interrupted on takeover and reconnect.
- A tunnel receives at most 64 concurrent streams. The listener owns global connection admission and its transport must provide fresh exclusive streams and close displaced sockets.
- This is a machine-local coordinator. Multi-host routing still requires a shared commit authority and a prompt cross-host displacement signal. The integration test uses two authorized holders and real TLS over loopback.
- The coordinator opens no listener, creates no authority, logs no payloads and changes no direct route. No deployment or data migration.

Independent rereview concurred with displacement, shutdown, and the concurrent stream ceiling.
