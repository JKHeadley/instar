---
title: "Private job definition and declared dependency replication"
slug: "lease-job-definition-replication"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/lease-job-definition-replication.eli16.md"
review-convergence: "2026-11-05T06:34:22.751Z"
review-iterations: 5
approved: true
review-completed-at: "2026-11-05T06:34:22.751Z"
review-report: "docs/specs/reports/lease-job-definition-replication-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex-cli timed out; gemini-cli not authenticated"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Private job definition and declared dependency replication

## Problem statement

A lease holder may have no scheduled job definitions even while the former holder has them. In Luna's October 27 handoff, jobs existed on the Studio, but the broader system also lacks a safe way to make custom job definitions and needed project files follow the agent. Git-sync cannot be used as the remedy: it would push token-bearing config into a backup. The separate lease scheduler fix starts the scheduler on the new holder; the coverage fix detects missing jobs, but detection alone does not restore portable jobs.

## Frontloaded decisions

- The job transfer uses registered machine keys and direct peer transport; it does not start git-sync, commit files, or send config/secret files to a remote backup.
- User-origin per-slug manifests and their Markdown bodies are transferable only after an explicit source portability declaration. Shipped instar-origin jobs remain owned by the add-only built-in installer. A background, idempotent legacy migration runs on the source before export; any legacy entry it cannot safely convert is listed as transfer-incomplete and alerted. No existing job is deleted or overwritten automatically.
- A job explicitly pinned by `machines` stays pinned; its absence on the new holder is an operator alert. `portable: true` and an explicit `requiredPaths` array are required, including `[]` for a reviewed self-contained job. Missing declarations mean dependency-unknown and prevent an enabled import. Script and skill targets must be covered by the declaration. Paths are never guessed from a command or prompt.
- The receiver pulls directly from registered non-revoked peers with a distinct recipient-bound encrypted bundle per peer. Its request carries a signed source-targeted nonce, recipient ID and key epoch, so a bearer alone cannot trigger a bundle build. Every response is signed over domain, protocol version, source and recipient identities/key epochs, nonce, monotonic content generation, and the complete ciphertext envelope; the receiver verifies the registry key and local nonce before decryption. Per-peer request rate limits, a bounded source collection budget, and durable transfer status bound disk walks and make retry failures visible.
- The receiver stages a missing definition in a private quarantine outside the scheduler path only if the source observation is complete and no other verified source presents a conflicting definition. A peer bundle alone grants no execution authority. A destination-local operator approval of the exact root authorizes installation and activation under the live lease. Changed content requires a fresh approval; an unapproved root remains quarantined and alerts. Files already present are kept untouched. An imported file is updated only if its current hash matches the last imported hash; otherwise conflict is reported. Deletions and disablement are never propagated as file deletion.
- A declaration is not a license to copy secrets. Paths under `.instar`, `config`, `auth`, `secret`, `token`, credential or `.env` segments are refused. A source-local operator export approval binds the exact manifest, body and dependency path/content hashes to one content root before export. The destination requires its own local operator activation approval of that exact root before installation; machine signatures and a shared bearer alone are never accepted as human approval. Any content change requires renewed approval on the source and each destination. This means a newly changed job may wait at an unexpected handoff, but it is quarantined and the holder alerts instead of silently missing work or executing peer-supplied code. Approval is an explicit interactive action through the machine's dashboard PIN plus a human confirmation of the exact root and file list; the shared bearer, peer route, and agent automation cannot mint it. Path names and heuristic scans alone do not prove safety. Names and heuristic secret scans alone do not prove it safe. Only regular files/directories with no symlinks are copied, under a per-file, per-job, and per-peer byte cap. A rejected dependency creates a visible gap, not a partial healthy verdict.

## Proposed design

### Transport and source projection

The coverage monitor polls peers every five minutes, including from a scheduler-less standby, and retains metadata-only signed observations as designed in `lease-job-coverage-and-catchup`. The transfer poll runs after a verified peer coverage observation on the five-minute coverage tick. A bounded durable cursor rotates through portable jobs, and a failed transfer stays in the holder's gap alert. A newly changed source file fails exact-root export approval until the local operator reviews that root. A separate `POST /jobs/portable-bundle` authenticated peer route validates a signed requester identity, nonce and recipient before it projects only source-approved `origin:user` per-slug manifests, their matching `jobs/user/<slug>.md` bodies where required, and files beneath explicitly declared `requiredPaths`. It reads from disk through a no-follow, containment-safe walk. It does not read `.instar/jobs.json`, any `.instar/config.json`, secrets store, run state, or arbitrary files named in execution text. The source validates each manifest using the same loader schema, then projects a strict allowlist of known fields and rejects unknown fields rather than copying the original object. It rejects malformed files and symlinked inputs. The source recomputes the exact manifest/body/dependency content root and compares it to its local operator export approval before any export; `portable: true` alone is not consent to transmit changed bytes. Legacy migration is a separate, boot/update task; the read route never writes. A bundle is incomplete if any chosen job or dependency cannot be represented within limits. It contains per-file relative path, bytes and SHA-256; the signed envelope carries source generation and root. A refused bundle is reported as a transfer error. The source encrypts the bundle to the registered recipient's X25519 key using the existing `encryptForSync` envelope and signs a domain-separated canonical envelope including the full encrypted payload. A source-local, monotonic content generation and Merkle-style file-hash root bind every byte; unchanged metadata with changed content advances the generation. The serialized encrypted response is at most 6 MiB; the pre-base64 plaintext JSON bundle is at most 2 MiB; each regular file at most 256 KiB; 500 catalog entries and 64 total bundle files maximum. Both bounds are enforced, including JSON/base64 overhead. No raw path or file body is in logs or the public pool view.

The receiver allows only its own machine ID as recipient, a fresh 32-byte nonce, a non-revoked registered source key and key epoch, and a successful signature over exact encrypted bytes. It decrypts with its own X25519 key, checks monotonic content generation/root against its last verified source bundle, then validates every path, size, hash, manifest/body relationship and collision before any write. The bundle is separately signed because the metadata-only coverage snapshot does not carry content hashes; a missing or stale bundle cannot establish definition readiness. A failed or incomplete bundle is retained as evidence only and never partly installed. The source must not be able to choose a destination outside the project root. The receiver rejects encrypted payloads if the source cannot be tied to a fresh coverage observation. Network timeout is three seconds and no redirect; two peer requests concurrently, no overlap. A failed transfer records durable per-peer and job status for the existing one-hour coverage alert retry floor; repeated bearer-authenticated requests are rate limited before disk traversal. Bundles are never relayed through a third machine as fresh evidence.

### Apply and conflicts

A receiver writes an atomic, mode 0600 import journal containing source ID, content root and hashes of every imported path. A separate durable apply latch and pending record are synced before any file changes. The loader withholds latched or pending jobs after interruption, and the trigger rechecks all imported file hashes before launch and after any asynchronous gate. Unapproved bundles remain in a private quarantine outside `.instar/jobs/` and project dependency locations. After verifying its own local, non-revoked operator approval for the exact root, the receiver writes each file through a private same-directory temporary file, then atomically installs dependency/body files before the manifest, with the scheduler's refresh and spawn admission fenced throughout the apply. Descriptor-relative no-follow operations protect every read and write, including parent components. A concurrent same-user writer can still replace a leaf between its prior-hash check and atomic rename; this local concurrency limit is recorded in the side-effects review. To update a previously imported file, it first checks that the current file hash still equals the import journal's prior hash. Local edits or colliding sources become conflicts; no source wins arbitrarily. It does not overwrite a locally disabled manifest or enable git-sync. If an import fails partway, the loader withholds a pending job and the holder reports a gap; cleanup restores or removes only files whose hashes still equal the imported hashes. A crash leaves the pending record visible for explicit rollback. A validated, destination-approved import triggers a local catalog reload on the holder before its next schedule window. It does not itself trigger catch-up execution. A standby maintains the copies before promotion so it can run without contacting the former holder.

Each required dependency is checked against the same declared allowlist on both sides. A directory walk excludes symlinks and special files, caps depth at 12, caps path length at 256, and rejects secret-like path components at every level. A job with a refused, unapproved or missing required path remains quarantined with a dependency reason in the coverage alert. The source export approval record names exact path/content hashes; an innocently named secret-bearing file is not exported by default. The recipient separately approves execution of the exact root before the files enter the scheduler path. The scheduler must not treat a job as ready merely because the manifest arrived. The public coverage view never lists raw dependency paths or content.

### Authority, alerting and rollout

A peer bundle is data, not execution authority. The receiver refuses an invalid bundle, keeps the last good import, and reports unavailable/unknown coverage; it never launches a job based on a peer request. Lease and machine pinning govern local execution. The current awake holder emits one consolidated durable alert for missing, conflicted, pinned or dependency-blocked jobs through the existing attention destination, with the coverage monitor's one-hour failed-send retry and daily reminder. Successful repair closes the alert.

Metadata observation is default-on. Bundle transfer starts dark on test agents, then read-only preview on development agents; installation and activation roll out after the stated graduation checks. Old peers without the endpoint retain coverage alerts and are labeled transfer-unavailable. Single-machine agents are unchanged. A mixed-version fleet never deletes or rewrites the existing files. Emergency rollback first runs the shipped `node scripts/job-portable-sync-rollback.mjs --state-dir <path>` command, after stopping the agent; it verifies the agent is stopped and moves only journal-proven imported manifests out of scheduler paths after hash checks. The PIN-gated live rollback route fences scheduler admission and persists a disarm latch before quarantine. It leaves local edits and file bytes intact. Only then is source reverted. A rollback attempted without that command must be reported as incomplete because the old loader would keep running an imported manifest. Git-sync stays disabled on Luna and is not used by this flow.

## Decision points touched

- **Invariant:** key, nonce, recipient, signature, generation, size, path, schema, and hash verification reject untrusted transfer before any write.
- **Invariant:** local or conflicting files are preserved; only a clean missing file or unchanged prior import may be installed.
- **Judgment-candidate:** a missing or refused dependency is surfaced for operator review; it cannot silently be treated as ready.
- **Invariant:** live lease, machine pin, and catch-up policy remain the only execution authority. Replication itself never spawns work.

## Multi-machine posture

- **Approval ledgers:** source export approval and destination activation approval are machine-local authority records, created only by explicit interactive operator action on that machine and bound to exact content roots. `machine-local-justification: physical-credential-locality` — each record is bound to that machine's operator-held dashboard PIN confirmation of an exact root; another machine cannot use that local credential or record as its own approval. They are not replicated or inferred from a peer signature. Each destination is approved once for a root before it can run that version. A changed root requires new approvals. A local revocation pauses the imported job before its next admission. A disconnected destination cannot learn a source revocation; it keeps its last locally approved version and reports source coverage as stale/unknown. This is an explicit availability tradeoff, not a claim of instant global revocation.
- **Content generation:** source-local monotonic state, signed in every direct bundle. The signed generation/root is distributed to every receiver as source-owned metadata; receiver replicas are unified observations rather than independent local authority. Each receiver retains its own last verified root and generation, rejecting rollback; no peer may relay a prior nonce-bound answer as fresh.
- **Import journal and quarantine:** machine-local mechanics with source/root provenance, since disk apply differs per machine. `machine-local-justification: hardware-bound-resource` — the journal proves what happened on this machine's filesystem and cannot be substituted by another machine's journal. The pool coverage view merges their status and names any machine that lacks an approved copy; a local journal never grants execution authority.
- **Job files and dependencies:** agent-wide intended content, replicated per recipient after approval. Actual disk copies are machine-local replicas with hash/provenance; a machine pin remains an intentional execution restriction rather than a transfer omission.

## Testing and acceptance

1. Two throwaway registered machines: an opted-in portable user job and source-approved declared project file copied to standby while source is online; after source goes offline and standby takes the lease, a destination-approved exact content root is loaded and can run on its next schedule. An unapproved root remains quarantined and alerts.
2. A pinned job remains pinned and alerts on takeover. A local disabled or modified manifest is never replaced. A source conflict yields an explicit conflict and no write.
3. The bundle and audit contain no undeclared or unapproved dependency; source refuses symlinks, traversal, secret path segments, oversized trees, and special files. Content may contain secrets despite an innocuous path, so only source-approved exact hashes are exported and no plaintext body is logged. Encrypted payload is recipient-bound, signed, and nonce-bound.
4. A failed/incomplete transfer does not install a partial job or produce a healthy verdict. Restart recovers an interrupted apply journal and preserves local state.
5. A mixed-version peer and an offline former holder produce a visible alert. Git-sync remains disabled, and no backup receives token-bearing config.

## Maturation plan

- **test-agent-live:** Exercise a paired throwaway agent with portable and pinned jobs, an offline source, conflict, and security refusals.
- **dev-agent-live:** Observe Echo's paired machines for seven days in read-only preview, then approved imports, including a planned handoff.
- **fleet:** Enable install only after the development pair passes.
- **graduation criterion:** No missing approved portable jobs, no overwritten local edits, no plaintext transfer, no duplicate catch-up runs, and a visible alert for every unapproved/legacy gap.
- **dark-window:** At most 14 days to a fleet decision; a failed security or duplicate-run drill resets the window.
- **ladder:** multiMachine.jobDefinitionSync

Feature-owned audit logs record poll, refusal, approval, apply, alert, and rollback outcomes.

## Rollback

Stop the agent, then run `node scripts/job-portable-sync-rollback.mjs --state-dir <path>` to quarantine journal-proven imported manifests. The script refuses a live agent. For a running agent, the PIN-gated rollback route pauses admission and persists a disarm latch before quarantine. Then revert the feature. No manual pre-handoff check is required for a healthy verdict.

## Open questions

*(none)*
