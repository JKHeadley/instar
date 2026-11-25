# Side effects of the optional relay verified dialer

The dormant dialer connects to the configured HTTPS origin. It requires normal certificate-chain and hostname verification, an exact configured SPKI hash, and negotiated HTTP/2 before returning a session.

- Untrusted, misnamed or key-substituted certificates, non-HTTP/2 peers, deadline expiry and cancellation refuse the session. A rotated relay key requires separately reviewed pin configuration.
- The caller can supply a private CA for a self-hosted relay. A pin does not bypass normal certificate verification. No lease or credentials are sent by this dialer.
- Rejected attempts close their transport before returning. Successful attempts return actual close tracking for retry fencing.
- The optional dialer is dormant. It adds no listener, startup behavior, persisted state or change to direct routes. Reverting requires no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Each explicit dial attempts one configured origin and stops at a fixed deadline.

Independent review concurred with certificate, identity, pin, ALPN, and actual-close verification.
