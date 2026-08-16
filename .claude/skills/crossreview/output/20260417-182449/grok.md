# Grok 4.1 Fast Iter 2 Review: PARALLEL-DEV-ISOLATION-SPEC.md

- **Model**: grok-4-1-fast
- **Date**: 2026-04-17
- **Focus**: iteration 2 convergence check

---

### 1. Overall Assessment
- **Score**: 9/10 (Exceptional depth in threat modeling, authority layers, and implementation details; minor gaps in cross-platform assumptions and key management deduct a point)
- **Status**: APPROVE
- This iteration 2 spec is a mature, battle-tested redesign that convincingly resolves all iter-1 must-fixes (multi-machine bindings via per-machine files, lock HMAC/server signatures + fencing/heartbeat hardening, explicit promotion replacing auto-classifier) while introducing robust new mechanisms like the push-time mirror gate and reconciliation matrix. It achieves structural enforcement of parallel dev isolation with minimal regressions, comprehensive ACs for testability, and a phased migration—ready for implementation with human sign-off on remaining R1-R3 questions.

### 2. Critical Issues (Must Fix)
No critical must-fix issues identified. All iter-1 must-fixes are verifiably resolved:
- **Multi-machine binding conflict**: Resolved via machine-local `topic-worktree-bindings.json` (gitignored, per-machine independent worktrees; AC-19 confirms hygiene).
- **.session.lock HMAC tamper**: Resolved via server-signed HMAC (`serverSignature`), atomic writes, O_NOFOLLOW/fstat, fencing tokens, and heartbeat server-stamping (lock protocol section).
- **Auto-creation classifier**: Resolved by explicit modes (read-only default, `/promote-to-dev` with ratification; auto-promote removed; AC-10/11).

### 3. Strengths
- **Threat model exhaustiveness**: Covers 20+ adversarial vectors (e.g., env spoofing, PID reuse, path traversal, prompt injection) with direct mappings to design elements—far beyond typical specs.
- **Layered authority model**: Clear table distinguishing advisory (pre-commit) vs. authoritative (push mirror) layers; signed semantic trailers avoid path leakage (resolves iter-1 trailer concerns).
- **State reconciliation matrix**: Single source of truth for bindings/path/git discrepancies; enables predictable reaper/WorktreeMonitor behavior (AC-16 explicitly tests all rows).
- **Force-take protocol**: Elegantly closes untracked WIP destruction (git stash --include-untracked + alert + history.jsonl); directly remediates the incident's part-two.
- **Phased migration/rollback**: Day -1 script, grandfathering, warn→block gating, flag-file kill-switch—low-risk rollout with AC-14/15 regression tests.
- **Observability**: 11+ metrics with dashboard integration; catches bypasses (e.g., `pushgate.rejects`) and anomalies (e.g., `lock.force_takes` spikes).
- **Testable ACs**: 25 detailed, verifiable criteria covering incidents, adversarial cases (AC-17/18), and perf (AC-23).

### 4. Gaps & Missing Elements
- **HMAC/server key management**: Unspecified how server HMAC keys are generated, rotated, or protected (e.g., per-machine keyring? env var?); assumes server process isolation but needs explicit "Key rotation: monthly via CLI, bindings re-signed on load."
- **Cross-platform disk assumptions**: Hardlinks (`cp -al`) and bootId/machineId generation tailored to macOS/APFS (e.g., `sw_vers`?); Linux (ext4 copy-on-write) or Windows (no native hardlinks) may balloon disk or slow spawns—add "Platform matrix: Linux uses rsync --hard-links, Windows symlinks with fallback."
- **Reaper decision tree details**: "Conservative decision tree" mentioned but not tabulated (e.g., thresholds for lastActivityAt vs. commit age); risks over-quarantining live worktrees.
- **Multi-machine session resumption**: If resuming a topic on machine B (no local binding), does it create a new worktree or fetch from remote branch? Unclear sync semantics beyond independence.
- **Error budgets/SLOs**: No targets for e.g., spawn latency p99 (<5s per AC-23?), preflight latency, or reaper false positives (<1%).
- **Security section**: Implicit but absent; consolidate adversarial mitigations into a table mapping threats→controls→ACs.

### 5. Industry Comparison
- **Git worktrees**: Builds directly on `git worktree` (list --porcelain reconciliation mirrors Git's own orphan detection) but adds session-binding, locking, and reaping—elevates from opt-in manual tool to enforced default, avoiding common footguns like manual `cd` loss.
- **GitHub Codespaces / Gitpod**: Parallels per-workspace isolation + auto-cleanup, but local-first (no cloud deps) with stronger tamper-resistance (server-mediated vs. env-only); push mirror akin to Codespaces' pre-push hooks but authoritative and bypass-proof.
- **Best practices**: Aligns with 12-factor (stateless server, env hints only), Google's locking patterns (fencing tokens, heartbeats), and Stripe's migration playbooks (day -1 script, grandfathering). Anti-patterns avoided: no git-synced state (cross-tenant risk), no auto-promote (privilege escalation).
- **Novelty**: Push-time mirror as "real authority" innovates beyond local hooks (common bypass via `--no-verify`); state matrix resembles Kubernetes reconciliation loops.

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Fully works; per-machine server/bindings handle 30+ active worktrees (budgeted), reaper daily, spawns <5s via templates.
- **Phase 2 (Growth, 50-500 users)**: Per-machine limits fine (independent bindings), but shared remote branches risk ref contention (force-push block helps); metrics detect `lock.force_takes` spikes early. Reaper disk budget (8GB) scales to 100s worktrees with LRU.
- **Phase 3 (Scale, 500-5000 users)**: Server in-memory bindings ok (<30 active), but binding-history table for push-gate (committer-date lookups) needs indexing (e.g., SQLite); cross-machine branch merges need `/multi-topic-build`. Reaper parallelized per-prefix.
- **Spike handling**: Lock acquires/heartbeats (15s cadence) could overload server under 1000 concurrent spawns (use in-memory mutex + rate-limit API); push mirror pre-receive serial but low-volume (commits rare); fails-closed on overload.

### 7. Recommendations (Prioritized)
1. **Add HMAC key management section**: Specify generation (e.g., `crypto.randomBytes(32)` per-machine), rotation CLI (`instar worktree rotate-keys`), load-time re-signing; test in AC-6 forgery case—highest security impact.
2. **Platform compatibility matrix**: Document bootId/machineId derivation (e.g., `dmidecode` Linux, `wmic` Windows), hardlink fallbacks (rsync Linux, robocopy Windows); add AC-23 variant for cold-start on Linux (<10s).
3. **Tabulate reaper decision tree**: Mirror state matrix with columns (lastActivityAt age, commit age, git list status) → action (quarantine/delete/keep); unit-test all paths in AC-9/16.
4. **Explicit multi-machine resume semantics**: Add to spawn flow: "If no local binding but remote branch exists, create fresh worktree from remote; alert 'new machine binding'." Update AC-19.
5. **SLO targets in observability**: Add to metrics table e.g., `spawn.p99 <=5s`, `preflight.p99 <=50ms`, `reaper.false_positives <0.1%`; dashboard alerts on breaches.
