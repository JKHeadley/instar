# ELI16 — Double-send route guard

Some server routes can accidentally send an HTTP response and then keep running. If later code tries
to send another response, Express throws the familiar "Cannot set headers after they are sent to the
client" error. The original bug is usually a missing `return` after an early `res.json()` or
`res.status(...).json()` branch.

This change adds two protections.

First, the server now installs a duplicate-response guard before routes run. If a handler has already
committed a response and later tries to send another JSON/send-style response, the guard logs the
duplicate with a stack and suppresses the second send instead of letting it throw through the request
path.

Second, the central Express error handler now checks whether the response was already sent. If an
error arrives after a route has already replied, it logs the late error with stack context and returns
without trying to send a second 500 response.

There is also a source-level audit test for the classic missing-return shape: an early branch that
sends a response without returning, followed by a later direct response in the same route handler. The
test includes a bad fixture to prove the detector catches the pattern, then scans the current server
route sources to keep that shape out.

This does not change successful API responses. It only changes what happens after code tries to send
again after a response is already committed: the server logs the mistake and preserves the first
response.
