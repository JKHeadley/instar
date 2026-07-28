# ELI16 — Stop shipped local API templates from using bearer-only auth

Instar's local server now expects two pieces of identity on authenticated local API calls: the bearer token proves the caller has the secret, and `X-Instar-AgentId` says which agent that secret is intended for. The server still accepts old bearer-only calls for compatibility, but it logs a deprecation warning because that old shape cannot distinguish "right token to right agent" from "a valid token sent to the wrong agent's local server."

Some shipped job and hook templates still used the old bearer-only shape. That meant normal installed jobs could call the local API successfully while producing noisy deprecation warnings. It also meant those templates were not ready for the future point where the compatibility window closes.

This change updates the installed-template surface rather than weakening the server. Job gates and direct script jobs now receive `INSTAR_AGENT_ID` from the scheduler, just like they already received `INSTAR_AUTH_TOKEN`. Spawned model sessions now receive the same identity variable from `SessionManager`, so prompt jobs and hooks have the value too. Templates that can also be run directly fall back to reading `projectName` from `.instar/config.json`.

The server policy is unchanged: missing headers are still accepted during the deprecation window, mismatched headers are still rejected, and `/whoami` still hard-requires the header. The fix is entirely on the client/template side: installed jobs, hooks, relay scripts, the clock helper, Secret Drop retrieval, and watchdog peer calls now send the header when they make bearer-authenticated local API requests.

The important safety detail is that fleet-watchdog peer calls use the peer's own `projectName`, not the calling agent's. A peer's bearer token must be bound to the peer's identity, because that request is sent to the peer's server.

Regression coverage scans shipped templates for bearer-authenticated local API calls that lack an `X-Instar-AgentId` header near the call site, and unit tests pin the scheduler/script-job env injection plus the generated Telegram topic hook's clock-helper identity argument.
