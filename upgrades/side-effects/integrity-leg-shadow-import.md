# Side-effects review — cutover integrity-pass wiring

## The change

Wires the previously-unwired integrity leg of the cutover-readiness door. New surface:
- `POST /cutover-readiness/integrity-pass` (routes.ts) → `CutoverReadiness.runIntegrityPass()`.
- `runIntegrityImport` dep + closure (AgentServer) spawns `integrityPassRunner` as a child `node` process.
- `PersistedShadowImportTarget` — a durable JSONL-backed `ImportTarget`.
- Extended route budget (middleware) + capability-index entry.

## Blast radius — what this can and cannot touch

- **It cannot mutate canonical data.** The import target is a throwaway on-disk shadow dir (`stateDir/state/cutover-integrity-shadow`), `dispose()`d after each pass. There is NO Portal/Prisma write path here. Read side is `GET /api/instar/read` only (read-only token).
- **It cannot accidentally green the irreversible cutover door.** The door greens only when `recordIntegrityReport` is called with a passing report, which happens ONLY on an explicit `POST /cutover-readiness/integrity-pass`. Shipping/merging/deploying this route does nothing until that trigger fires. The cutover flip itself remains the operator's manual click — there is still no fire-cutover route.
- **A failing pass is safe + honest.** A failing integrity report is recorded too (door reads closed) so the door reflects the LATEST real verdict, never a stale green. A pre-import abort (fingerprint collision → null report) records nothing and leaves prior state. A failed fetch records nothing (absence of evidence).

## Concurrency + resource safety

- Shares `CutoverReadiness`'s single-flight `liveFetchInFlight` guard with parity-pass + import-dryrun — only one live source fetch at a time (the #948 lock-pileup guard). A concurrent integrity-pass is refused 409.
- The 145K-row fetch+import runs OFF the server event loop in a child process (the in-process import-dryrun budget-fails at 720s; #948). The child's internal fetch budget (600s) sits under `CutoverReadiness`'s 12-min max-hold backstop, which releases the lock if the child ever hangs; the child also carries an 11-min execFile wall-clock cap. Worst case is an orphaned child + a released lock, never a wedged server.
- Memory: `--max-old-space-size=4096` on the child; the shadow is JSONL on disk, not held in RAM beyond the readback.

## Failure modes considered

- Child exits non-zero with a valid failing verdict on stdout → parsed + recorded (door flips closed), not treated as a crash. Only a no-verdict crash (exit 2 / killed) throws → 409, nothing recorded.
- No paritySource configured → `runIntegrityImport` is null → 409 "no import source configured" (verified by the e2e feature-alive test on the real AgentServer init path).
- Stale/torn integrity report on disk → `integrityStatus()` reads deny-safe (not passed).

## Migration parity

No agent-installed file changes (no settings/hooks/CLAUDE.md template/config-default changes), so no `PostUpdateMigrator` entry is required. The route ships in server code and reaches existing agents on their normal server update. The new capability-index entry surfaces it to agents (Agent Awareness Standard).

## Tests

Unit (PersistedShadowImportTarget + runIntegrityPass both-sides-of-boundary), integration (route greens-on-pass / flips-on-fail / 409-fetch-fail / 503-unavailable), e2e (route alive on real AgentServer init path). All green; tsc clean.
