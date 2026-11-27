# Side-effects review for the Claude quota scan worker

## Scope

Move discovery, decoding, and transcript parsing out of the server thread in the existing Claude JSONL fallback. Keep the existing seven-day file and event selection, estimate formula, OAuth precedence, source confidence, and Codex collector behavior.

## Side effects

- The worker receives one existing local projects path and returns an estimate or an empty result. It inherits no environment variables and makes no provider requests.
- The manager already waits for a collection before scheduling the next poll. The worker has a bounded lifetime, and a failure is reported by the existing collector with no inline scan fallback.
- Transcript discovery and streaming use the same local files and parsing rules. The worker keeps the same disk and CPU work per pass. It moves parsing off the request loop and does not introduce persistent offsets or caches.
- The estimate remains a signal. This change grants no new authority to stop work, move sessions, select accounts, or trigger migration from estimated quota.
- The release includes a compiled worker next to the collector. Each machine reads only its local quota evidence.
- A rollback restores the previous scanner implementation without a state migration. Any temporary Laptop-only config mitigation stays under the Laptop owner's control.
