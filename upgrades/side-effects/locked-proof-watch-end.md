# Side-effects review: watch-end proof fixture

Tier 2, approved `docs/specs/desktop-locked-screen.md` P12. Harness-only authority to pause exact proof-account actors warrants independent safety review. No production/native policy change. Review and commit counts are recorded in the parent delivery handoff.

## Chosen design

Wait for a positively locked watch, durable supervisor ACK, then stop foreground launchd A and its exact guard. A/B configuration names must be present and distinct, and the marker belongs to A: controller sweeps skip other owners. No B admission/resume operation occurs during this case. Probe state.lock nonblocking after STOP; a held lock is a setup failure and recovery resumes actors. Never query frozen A over HTTP. Resume guard at watch end+1s; require actual native relock-failed at/after watch end before resuming the same Node. The exact duty security item must be created within10s of guardAt. A guard paused mid-loop may relock after resuming: that is a setup miss, not a passing proof.

## Over-block and under-block

Unknown console/process observations, missing timing, absent B identity, changed guard, delayed action/receipt, wrong attention duty and unconfirmed cleanup fail. Conservative polling can reject a human run. The judge binds the exact duty marker and persisted process identities; it cannot infer success from absent measurements. No four-manual-unlock count is asserted. Case12.11 retains its separate repeated-unlock failure behavior.

## Recovery boundaries

Private owned receipt directory, no-follow owned single-link files, atomic fsynced receipt and ready ACK precede suspension. Supervisor is detached, has an immutable recovery plan and fixed monotonic deadline (watch+138s), and resumes only matching PID/UID/kernel-start/full-command identities. Native process-start observation uses the retained helper without acquiring the state lock. Bookkeeping failure does not suppress resume/lock attempts. A bounded child performs a same-boot/login/onConsole lock with no keyboard fallback. Unknown or another login refuses lock. Results/failures persist when storage permits; permanent storage loss cannot honestly yield confirmed recovery. Driver finish waits for a terminal recovery receipt before changing launchd/server topology.

## Layer and authority

Closed case identifiers and exact process/session evidence govern an explicitly requested test fixture. No user-intent heuristic, product authorization, routing, or global recovery policy changes. The detached fixture is not installed or started by ordinary product boot. Tests pin its inert worker entrypoint; a nonce on an arbitrary command is insufficient.

## External and machine surfaces

Only instarproof paths and exact recorded proof processes during an explicit proof run. No fleet state, migration, credential persistence, helper signing, TCC, global transport or production code changes. The independent deadline begins recovery before the watch+150s stale-admission boundary; no hard OS scheduling guarantee is claimed. All commands and probes have bounded waits. No live Mac actions or real Telegram sends were executed for validation.

## Rollback

Do not remove a live supervisor or receipt. First finish the fixture and inspect its terminal recovery result; unresolved recovery needs operator handling. Between runs revert this harness commit. No product migration is required.

## Validation

Targeted unit tests run the actual detached supervisor on inert temporary workers, including parent death, deadline, changed context, corrupt/mutated receipt and held store lock. Timeline tests exercise watch-end ordering, exact attention correlation, delayed attention and fail-closed verdicts. Full/integration/E2E/live-Mac tests intentionally not run under the parent's bounded test authorization. Independent review remains required before commit.

Final author validation:134/134 targeted checks across watch-end(23), driver(74), human steps(37). The write-failure regression replaces receipt.json with a directory after freeze: atomic recovery-start persistence fails, both inert workers still resume and the context-lock attempt still executes, with no false clean receipt. Busy finish waits read-only; unresolved independent recovery blocks launchd restoration. Running A/B /health.project must match configured distinct identities before freeze. git diff --check passes. Independent safety reviewer found no remaining source blocker after the corrections, requested the write-failure regression now included; parent owns final concurrence and delivery gates.

Final verdict review requires complete finite process identities (not equality of missing fields), and matching nonempty fixture nonce/key across the armed and recovered receipts. Negative cases cover empty identities, missing UID/command, invalid PID, wrong nonce and wrong duty. A loaded targeted run had four inert fixture failures; original assertions omitted subprocess diagnostics and cleanup removed receipts, so exact causes were not recoverable. The follow-up134/134 run passed, but timing luck is not the remedy: workers now announce readiness instead of relying on100ms sleep, corruption/write-failure tests get5s bounded test-only injection windows, and assertions expose command/receipt diagnostics. Production deadlines remain unchanged.

The improved diagnostic run exposed a real receipt-read race: atomic replacement can unlink an already opened receipt before fstat, yielding link count0. Requiring exactly1 incorrectly rejected that safe owned regular inode and could trigger early recovery. Receipt reads now accept0 or1 links on the already-open nofollow owned regular descriptor, still rejecting multiple links; operation/state locks remain single-link only. A deterministic open→replace→fstat regression reproduces the boundary and verifies hardlink refusal. This supersedes the earlier unproven contention explanation.
