# Independent dashboard tunnel connector

Tier 1 inactive connector and loopback integration. The operator configures the named tunnel origin to the new loopback ingress port. The app port and public hostname remain the same. Requests stream directly to the fixed local app address; the ingress does not retry or authenticate them. Only connection refusal or the existing explicit app boot marker generates a restart page. Other app errors pass through unchanged. WebSocket upgrades use the same fixed app port.

The compiled process entry point is `node dist/tunnel/dashboardConnectorMain.js /absolute/path/to/config.json`. Its config requires `enabled: true`, `appPort`, `ingressPort`, `hostname`, and `cloudflaredConfigFile`. Run it under a supervisor separate from the app server. The named Cloudflare ingress must use the loopback ingress port and the server-owned connector must be disabled in the cutover to avoid mixed origins. Unexpected connector exit terminates the dedicated process so its supervisor can restart it. No production registration or hostname change occurs in this checkpoint.

## Class-Closure Declaration

- `unbounded-self-action` is not applicable. One explicitly invoked connector start and request-driven proxying. No self-triggered restart or page refresh.
