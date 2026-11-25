# Side effects of the optional relay client locator

A dormant client helper redeems one code over a dedicated, verified relay connection. It returns a frozen locator for one relay-assigned hostname in the configured DNS zone.

- The helper requires a canonical single DNS label under the configured routing domain, an exact JSON response, and a no-store header. It rejects redirects, extra fields, oversized responses and other domains.
- The receipt carries no credential, ownership proof or agent certificate. It only names a candidate address for the independent ownership and agent identity checks. The relay's own TLS pin does not pin that agent.
- A five-second deadline bounds dialing and reading. The helper waits for its dedicated connection to close before returning.
- The secure loopback fixture uses the actual verified dialer and disposable service. No native UI, production routing or state changes. Reverting requires no migration.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. One caller-requested redemption owns one bounded connection.

Independent review concurred. A cancellation fixture also proves that a partial response cannot leave the dedicated client socket open.
