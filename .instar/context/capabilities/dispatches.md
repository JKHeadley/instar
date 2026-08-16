# Dispatch System

Receive behavioral instructions from Instar maintainers. Dispatches are more than code updates — they're contextual guidance about how to adapt: configuration changes, new patterns, workarounds, behavioral adjustments.

## Endpoints

- **View dispatches**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/dispatches`
- **Pending dispatches**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/dispatches/pending`
- **Context updates**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/dispatches/context`
- **Apply a dispatch**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/dispatches/DISPATCH-ID/apply`
- **Auto-dispatch status**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/dispatches/auto`

## Auto-Dispatcher

The AutoDispatcher polls and applies dispatches automatically when configured.
