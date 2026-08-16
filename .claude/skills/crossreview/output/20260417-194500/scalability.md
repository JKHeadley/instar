# Scalability Review — PARALLEL-DEV-ISOLATION-SPEC iter 4

**Reviewer:** Scalability / Operational viability
**Verdict:** **CONVERGED — with operational caveats** (no new blockers introduced by iter-4 architectural changes; all surfaced concerns are addressable via documented config/playbook items, not redesign)

The iter-4 changes (Ed25519 + GH Ruleset + GH-side cache + mandatory destructive shim + `cp -al` removal + server-keychain machineId + headless fallback + binding-history sync + Day -2 TOFU) coherently close the iter-3 trust-boundary holes without introducing a new fundamental scalability cliff. The remaining concerns are about operational *cost curve* (CI minutes, disk growth from full `cp -R`, fsnotify load, GH Repo Variable churn, PAT lifecycle) — they are real and need monitoring, but do not block approval.

---

## Top 3 scalability risks introduced by iter-4 changes

### 1. Full `cp -R` replacing `cp -al` on ext4/HFS+ — disk + spawn-latency cliff at growth phase

**What changed:** `cp -al` removed entirely (correctly — hardlink aliasing breaks isolation). On ext4, HFS+, tmpfs, and network mounts, every new worktree is now a full copy of the working tree. AC-26 still requires a 5s p99 spawn for new topics; the template-clone strategy is the only thing keeping that target reachable.

**Operational impact:**
- **MVP (1–3 active worktrees, APFS user):** Negligible. APFS `cp -c` clonefile stays sub-second.
- **Growth (5–10 active worktrees, mixed Linux ext4 dev):** A 2 GB working tree (typical for a Node project after `node_modules`) becomes 10–20 GB resident across worktrees. ext4 full copy of 2 GB ≈ 8–15s on consumer NVMe — **breaches the 5s AC-26 p99 by 2–3×.** Spec acknowledges "ext4 hardlinks ~10s" in §Disk strategy but this is now stale wording — it should say "ext4 full-copy ~10–15s." The pre-warmed `.template/` mitigates but only after first warm-up; cold start on a new repo is the worst case.
- **Scale (12 GB disk budget hit):** Reaper churn becomes the dominant cost. With 50 commits/day across 10 topics and 14d snapshot retention, `.snapshots/` alone can hold ~500 tarballs. Reaper p99 ≤ 30s target needs a re-validation under that load.

**Recommendation:** Tighten AC-26 wording to specify "5s on APFS/btrfs CoW; 15s on ext4/HFS+ full-copy with template warm." Add SLO: "spawn latency by FS type" as a metric.

### 2. `binding-history-log.jsonl` git-synced — sync-fan-in scaling at multi-machine scale

**What changed:** Append-only signed log (200 B/entry × ~50K entries/year per active project) git-committed and synced on every commit-trailer signing. Compaction at 90 days.

**Operational impact:**
- **MVP (1 machine):** Effectively unused; local SQLite suffices.
- **Growth (2–3 machines, same project):** Each commit triggers an append → auto-commit → push → other machines pull → ingest. Round-trip latency for cross-machine nonce visibility = the auto-sync cadence. If a developer commits on machine A and pushes from machine B within seconds, **the GH check on B may legitimately not yet see A's nonce in the log**, falling back to `INSTAR_VERIFY_CACHE` (which only sees server-issued caches). Spec says "race recovery: re-commit with new nonce" — that's user-visible friction at growth phase.
- **Scale (5+ machines, monorepo with many topics):** Union-merge driver auto-resolves conflicts but does not prevent the file from becoming a write-hot path in git-sync. 50 topics × 1000 commits/year = 50K appends/year = ~10 MB/year/repo growth (matches spec). But auto-commit cadence × append rate produces a steady commit stream that pollutes the user's `git log --all`. The 90-day compaction-to-monthly-digest mitigates but only after 90 days.

**Recommendation:** Track `binding_history_log.append_rate` and `binding_history_log.cross_machine_visibility_lag_p99` as SLO metrics. Document that the cross-machine nonce-collision recovery (`re-commit with new nonce`) IS the expected race outcome, not a bug.

### 3. fsnotify watcher on `.instar/worktrees/topic-*/` — IO load at scale + macOS FSEvents coalescing

**What changed:** Mandatory fsnotify-watching on every active worktree to catch IDE-direct destructive ops (since PATH shim cannot intercept `/usr/bin/git` from VS Code).

**Operational impact:**
- **MVP:** 1–2 watchers, negligible.
- **Growth:** 5–10 worktrees × 50K files each (post-`npm install`) = 250K–500K fsnotify watches. **Linux default `fs.inotify.max_user_watches` is 8192–524288** — easy to exhaust on a Linux dev box with ≥10 worktrees. On macOS, FSEvents coalesces but introduces ~100–500ms latency for the "file count drop > 5" detection — the exact window in which an IDE can finish deleting hundreds of files. Spec acknowledges this but the SLO consequences aren't captured.
- **Scale:** A user with 20+ active topics on Linux WILL hit `ENOSPC: System limit for number of file watchers reached`. Server start should pre-flight `cat /proc/sys/fs/inotify/max_user_watches` and either raise it or alert.

**Recommendation:** Add to migration script: pre-flight check for `fs.inotify.max_user_watches ≥ 524288`; alert + provide `sudo sysctl` instructions if low. Add metric `fsnotify.active_watchers_count` and SLO ceiling.

---

## Top 3 operational concerns

### 1. GitHub Actions minute consumption from `worktree-trailer-sig-check` per push

The workflow runs on **every push** to `topic/*`, `platform/*`, `main`, AND on every PR (R9 leans toward enforce-on-every-push). With active dev → ~30 pushes/day/dev × 5 devs = 150 runs/day. At ~30s/run × 150 = 75 min/day = **~2,250 GH Actions minutes/month per active project.** This is ~one-third of the GitHub Free tier (3000 min/mo) for a single project. Multi-project orgs on Free tier will burn through the budget.

**Mitigation needed:** Ed25519 verify is offline and fast; the run can complete in <10s if cache-warm. Spec should target ≤10s/run and document expected monthly consumption per project tier.

### 2. GH PAT lifecycle for `INSTAR_VERIFY_CACHE` + `INSTAR_VERIFY_TUNNEL_URL` updates

Server pushes cache every 5 min via `gh api repos/.../actions/variables/...` requiring a PAT with `actions:write`. R13 acknowledges this. **Concerns:**
- PAT expiry (max 1 year) → silent degradation: when it expires, cache stops updating, `INSTAR_VERIFY_TUNNEL_URL` becomes stale, GH check fails-closed across the org.
- PAT rotation has no automation in the spec — only "lives in `.instar/config.local.json`."
- 5-min cache push × ~12K calls/month/project = within rate limits, but contributes to org-wide PAT rate accounting.

**Mitigation needed:** Add SLO `gh_pat.expiry_days_remaining` with alert at 30 days; add `instar worktree gh-rulesets rotate-pat` command; consider GitHub App installation token (auto-rotates) as a future migration.

### 3. GH Repo Variable size limit + churn

`INSTAR_VERIFY_CACHE` has a documented 48 KB ceiling. At 200 B/entry ≈ **240 entries max** per cache push. With 10 active topics × `maxPushDelay=7d` × ~5 commits/topic/day = 350 active nonces — **exceeds the cache ceiling at growth phase.** Spec's R8 acknowledges and proposes auto-shard or migrate-to-branch but doesn't pick. Additionally, 5-min push cadence × 12 pushes/hour × 24h = 288 writes/day/project to the same Repo Variable — there is no documented rate limit on Variables but this is heavier traffic than Variables were designed for.

**Mitigation needed:** Resolve R8 before Day -2 ships. Recommend cache strategy: include only nonces issued within last 1h (cache TTL) — drops the working set to ~50 entries comfortably under 48 KB.

---

## NEW critical issues that should block approval

**None that block.** The following are upgraded to explicit pre-Day-0 actions but do not require redesign:

1. **R8 must be resolved before Day -2 ships** (cache-overflow at growth phase is foreseeable, not theoretical).
2. **AC-26 latency wording must be FS-typed** (current spec implies 5s on ext4 which is unachievable for full `cp -R` on large repos).
3. **inotify watcher pre-flight required at server start on Linux** (otherwise scale failure is silent + sudden).
4. **GH PAT expiry monitoring is not in the metrics list** (`gh_pat.expiry_days_remaining` should be added to §Observability counters).

All four are config/observability tweaks consistent with the iter-4 architecture, not architectural pushback.
