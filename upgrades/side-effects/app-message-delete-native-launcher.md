# Persistent loopback Delete acceptance launcher

Build the checkout, then run `node scripts/app-delete-native-acceptance.mjs <public-key-file>` on the same Mac as the native client. The file contains one uncompressed P-256 public key encoded as base64url. The matching private key stays with the test client. The launcher creates a fresh temporary agent, one synthetic conversation and two synthetic messages. It prints the loopback host, protocol, device ID, conversation key, custodian and exact event IDs in a single ready record. Connect over HTTP to that host and sign with the printed host, including its port.

Only the synthetic conversation's signed history, sync, context and Delete endpoints, and the signed conversation list, are reachable. The listener accepts no network binding beyond IPv4 loopback. Send SIGHUP to the printed process ID to rebuild the fixture journal index and exercise epoch reset. SIGTERM or SIGINT stops the listener and removes its temporary state. Prepare delayed-response and durable-merge timing in the native harness, so no delay hooks enter the server.

## 6b. Operator-surface quality

The native test client can keep a disposable conversation open while testing deletion, delayed history and a sync reset. Normal startup is unchanged.

## Framework generality

The launcher accepts the standard signed device key format and uses the same App HTTP routes on the test Mac.

## Independent review

Concur after registering termination handlers before initialization, suppressing readiness on interruption and joining one cleanup operation. The signed socket fixture passed and exited cleanly.
