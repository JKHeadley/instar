# Side-effects review for the scheduled scan and idle model drafts

This is a Tier 2 work-in-progress checkpoint. The scheduled scan draft changes fleet job defaults and the idle draft adds process identity evidence. These drafts are for review. Keep release and live activation on hold.

## Over-block

The packaged catalog read fails closed for unsigned, missing or changed assets. An old package can therefore lack the new read surface until a signed package is available. The committed observation reader also rejects legacy successful runs without an attested digest. The macOS sampler withholds identity evidence when the process exits, changes generation or cannot be inspected.

## Under-block

The scheduler verifies the staged observation and attaches its digest. The shared HTTP history reader and safe pruning remain pending. The packaged reader fixtures use temporary signing keys. They cannot establish signer custody for a release. Process generation alone cannot prove that the terminal owns the expected Codex thread or that switching is safe.

## Ownership and authority

The scheduler owns successful run records. The packaged catalog reader owns signature and asset digest verification. The process helper reports kernel evidence to its caller. Under [Signal vs Authority](../../docs/signal-vs-authority.md), these observations confer no authority to change models or route work.

## Interactions

The scan draft changes the default cadence. New jobs stay disabled. Existing enabled jobs are preserved. Existing explicit configuration, the kill switch, and legacy notice behavior require parity checks before release. The observation reader requires the exact scheduler run and machine. The idle helper has no production caller.

## External surfaces

The packaged catalog can change what existing HTTP readers report if enabled and backed by trusted assets. The job template is a fleet-facing change. The idle fixture ran only against disposable local processes.

## Multiple machines

The catalog is a signed package asset. Scan observations and process identity are machine-local. A scan on one machine cannot attest another machine's scheduler run. A process generation cannot transfer with a topic.

## Rollback

Discarding the drafts leaves the current runtime intact. If the scan is later deployed and needs to be suspended, the existing doorway-scan kill switch stops the job. Restoring prior defaults and installed manifests would require a release with migration parity checks.

## Review status

Focused scan/store and scheduler history checks passed, as did three disposable macOS fixture cases. All 55 lint steps passed on the staged drafts. Independent side-effects review, complete verification, and release evidence are pending.

The independent review raised three concerns. The new-job default has been restored to disabled. Blocking issues remain for already-enabled jobs: the installed wrapper can invoke the prober without verifying its executable digest, and the existing scheduled script can update shared manual scan state. This checkpoint cannot be cleared for release while those paths remain.

## Opt-in execution checkpoint

The scheduler now admits the signed free-probe profile through the existing script runner and its claims, supervision and global and per-job operator controls. The explicit profile permits the zero-model doorway job through the default first-wave list. A blocked packaged run cannot fall back to a model session. The runner passes the verified executable bytes through stdin, records each attempted doorway before it starts, and reopens the staged result before recording success with its digest. The new path writes only machine-local run artifacts. Turning off the profile restores legacy routing on a subsequent trigger. Both profile selection and the kill switch use the scheduler's state directory.

Unsigned assets, missing machine identity, invalid configuration and incomplete output prevent an attestation. Packaged execution sends no notices and does not advance the manual baseline. Full release evidence, retention and freshness reconciliation, and legacy delivery parity remain open. The opt-in stays absent from defaults.

## Scheduled observation read checkpoint

The scheduler records which ledger rows selected the packaged profile, including runs that fail before starting a probe. The read model keeps the latest job result, latest admitted attempt for each doorway, and last committed observation separate. It uses the scheduler's cron parser to calculate expiration and leaves conflicting wall-clock evidence unknown. There is no pruning or change to either HTTP reader in this checkpoint. The read model requires bounded local history and the current enabled schedule from its eventual caller.

Independent checkpoint review concurred after a regression test confirmed that corrupt admission records withhold current reachability. Before connecting either HTTP reader, apply the same rule when an admission record conflicts with its corresponding ledger row.

## Shared bounded history checkpoint

Both authenticated HTTP reads use the scheduler's machine-scoped window of up to 16 relevant run rows. Skips, legacy rows and other machines cannot displace local evidence. A timestamp tie at the window boundary is withheld and reported as truncated. Admission records that conflict with the ledger make potentially affected readings unknown. The doorway response exposes scheduled history alongside the manual response. The capability response uses only current scheduled observations when that history is selected. Missing machine identity in the opted-in profile yields unavailable evidence. The ledger and artifact files are unchanged by reads. Safe pruning, observation history beyond the window, signed-release execution, and delivery parity remain separate release work.

## Installer checkpoint

New doorway jobs use 04:00 local time and remain disabled. Existing valid doorway manifests keep their schedule, enabled value, disable marker, and existing script or agent-message runner. A malformed or unsupported manifest stays available for operator review and is reported by the existing install result. The shared installer serves new installs and updates. The change does not alter the operator's master switch, probe execution, or delivery. Cadence and enablement remain local to the existing schedule control. Reverting the template changes the default for future installs, and previously saved schedules retain their values.

Independent checkpoint review concurred after confirming the existing awareness and prober drafts are outside the installer checkpoint.

## Schedule guidance checkpoint

New full-layout agent instructions and the update migrator use the same schedule guidance. Migration replaces the exact previously shipped bullet. Customized or absent bullets in an existing section stay as written. This text describes the saved job schedule and the existing master switch. It does not modify configuration, schedule entries, or delivery. The update is local to each agent's generated instructions and is repeatable.

## Executable fixture checkpoint

An ephemeral signing key binds the actual doorway prober and a deterministic CLI-only catalog in a package-shaped fixture. A separate agent directory runs the verified prober, records the exact run's digest, and reopens the committed observation from disk. The fixture uses a local Node version probe and creates no manual scan file. This test establishes executable compatibility outside a checkout. Release-signing custody and an installed release test remain separate.

## Ledger availability checkpoint

A failed packaged history read now reports unknown reachability to both read surfaces when the profile is opted in. The legacy ledger API still returns an empty compatibility result on read failure. Absence of a ledger file on a fresh agent remains a valid empty history. This handles I/O failure. The ledger's existing recovery of malformed JSON lines still needs a stricter completeness signal before it can authorize cleanup.

The retention boundary needs to distinguish a permanent historical receipt from a live artifact reference. A durable local cursor must retain the latest attested observation per doorway, admissions for current attempts, and the diagnostic window. It must advance only after the scheduler ledger durably records the successor. The cursor and artifact cleanup must share scheduler writer custody. A reader with an older cursor must finish or retry before cleanup removes any of its referenced artifacts. A missing or unreadable cursor or incomplete ledger blocks cleanup. A restart before cursor advancement preserves the old artifacts and reconstructs the next cursor from verified evidence. No cleanup is introduced by this checkpoint.

## Ledger completeness checkpoint

The opt-in doorway reader now treats skipped malformed records and unterminated final records as incomplete history. Legacy job history still exposes valid rows. Startup compaction leaves incomplete content on disk, a larger replacement ledger is reread from its beginning, and a local append gives a known torn line its own separator. Tests cover cached reads, append, restart, replacement, and an external writer completing a torn row. Independent review concurred with this read-only checkpoint. The cache still assumes that growth of the same file comes from append-only writers. A concurrent writer can leave a fresh torn tail before the scheduler reads it. Artifact removal still requires an authoritative writer fence and durable cursor.

## Durable cursor checkpoint

The observation store can publish a bounded cursor with an exact generation, per-door observation digests, admission references, and a diagnostic run window. It uses the state directory's shared writer lease, validates the expected generation, atomically replaces the cursor, and syncs its directory. Corrupt cursors and stale writers fail closed. The cursor is machine-local and grants no cleanup authority. The next caller must acquire the lease from the cursor's canonical state directory, verify references against the exact ledger and artifacts, and coordinate readers before removing any artifact. No scheduler or HTTP caller publishes or consumes the cursor in this checkpoint. Reverting the code simply leaves any fixture cursor unused.

Independent review concurred with the advisory cursor after confirming all writers for the shared cursor use the same scope.
