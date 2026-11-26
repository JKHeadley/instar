# Keep the dashboard address reachable during an app restart

When the Studio server restarts, its Cloudflare connector currently stops with it. Anyone who opens the dashboard during that gap sees a Cloudflare tunnel error. The local server already tells tools when it is starting, but that notice cannot help while the connection from Cloudflare is gone.

This adds a separate connector process with a loopback ingress. The named tunnel can stay connected while the app server shuts down or boots. During that gap the ingress responds with a short dashboard restart page with a five-second retry hint. Other requests receive a retry response. When the app starts listening again, the same ingress sends requests and dashboard connections to it. The app still decides whether each forwarded request is authorized.

The connector is off until explicitly configured. An installed deployment must point the named tunnel at the ingress and turn off the old in-server connector as part of the same cutover. The disposable test proves the local restart behavior. It does not change the Studio hostname or its current Cloudflare process.
