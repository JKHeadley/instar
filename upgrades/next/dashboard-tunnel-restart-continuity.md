<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Added a default-off independent named dashboard connector and a loopback ingress that serves a brief maintenance page while the app restarts.

## Evidence

Disposable integration keeps one ingress listening while the app stops, runs its boot beacon, and starts a replacement. It checks HTTP authentication forwarding, maintenance responses and WebSocket forwarding.
