# Side effects of the optional relay agent session

The dormant agent adapter connects one caller-owned HTTP/2 session to the disposable relay. It signs one exact lease challenge and offers at most four streams. An admitted offer opens a launcher-supplied fixed local TLS socket.

- Invalid control or refused offers close the session and sockets. Early unmatched offer resets stop the session, preventing a tight retry loop. Normal idle offer expiry can replenish an offer.
- The caller supplies the verified relay session, current lease, signing function and fixed local destination. This adapter opens no network listener, selects no dynamic target, and installs no configuration.
- The disposable fixture uses the real agent adapter, pinned owner and signed lease verification, and encrypted TLS forwarding. Direct access is independent.
- Automatic reconnect and deployment remain disabled. Reverting requires no data migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. An explicitly started session owns bounded stream offers. Shutdown or an invalid session ends replenishment. The module starts no autonomous sessions or reconnect.

Independent rereview concurred with failed-start reporting, graceful local draining, and bounded offer replenishment.
