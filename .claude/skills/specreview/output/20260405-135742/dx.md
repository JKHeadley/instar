# DX / API Design Review — Persistent Listener Daemon RFC

**Reviewer**: Developer Experience & API Design Specialist
**Review ID**: 20260405-135742
**Round**: 1
**Date**: 2026-04-05

---

### Approval Status: CONDITIONAL APPROVE

### Score: 7.5/10

Architecturally sound with thoughtful DX in several areas. Gaps in onboarding documentation, CLI discoverability, error messages, and migration UX.

---

### Research Findings

- **CLI daemon management:** PM2's community cites command naming inconsistency as top friction. systemctl's `status` output (uptime + last N logs + process tree) is gold standard.
- **Unix domain socket IPC:** ~50% lower latency than TCP loopback (130µs vs 334µs). Production-proven choice.
- **Agent framework onboarding:** CrewAI's low learning curve attributed to `doctor`-style check command and clear error messages. LangChain's complexity reputation stems from poor error messages, not technical capability.
- **LLM agent subprocess security (2025):** API keys via env vars to child processes NOT isolated by `--allowedTools` alone. Explicit env-var scrubbing now considered baseline.

---

### Critical Issues

**1. No "Getting Started" Path** (High)
- No description of day-one operator experience. What does a developer type to enable the daemon? Auto-start or explicit opt-in?
- **Fix:** Add a "Quick Start" section or reference to setup flow.

**2. `instar listener status` Output Underspecified** (High)
- Command listed but output never described. Without specification, implementation produces bare "running/stopped."
- **Fix:** Specify output: state, PID, uptime, connection state, last message time, log tail, metrics summary.

**3. Inbox Rotation Race Condition Unresolved** (Medium)
- Open Question #2's "100ms pause" has no error handling story.
- **Fix:** Resolve before implementation, not as open question.

**4. Config Namespace Collision** (Medium)
- Section 3.2 uses `listener.*`; Section 9.3 uses `threadline.listener.*`. Same config, different namespaces.
- **Fix:** Pick one. Be definitive.

---

### Recommendations

- **R1: Add `instar listener doctor` command** (High) — Checks all preconditions (identity, relay reachability, inbox writable, HMAC key, launchd available). Single highest-ROI DX addition.
- **R2: Specify `instar listener logs` filtering** — `--lines N`, `--level`, `--since`, `--json` options.
- **R3: Define health/metrics API contract** — Field types, nullability when daemon stopped, error responses, auth requirements.
- **R4: Resolve pipe session model selection** — Default to agent's configured model; allow override via `pipeMode.model`.
- **R5: Document offline queue TTL default** — Set 1 hour, document it, surface in `status`.
- **R6: Add `install`/`uninstall` lifecycle commands** — Separate launchd plist management from process management.

---

### Observations

- **O1:** Pipe/Interactive classifier uses brittle keyword matching — violates CLAUDE.md's "Intelligence Over String Matching" principle.
- **O2:** Architecture diagram (Section 3.1) is excellent and rare in internal RFCs. Keep updated.
- **O3:** Unix socket fallback to sentinel file is well-designed.
- **O4:** 5-minute pipe session timeout may be too short for large file reads + relay round-trip. Consider per-IQS-band timeouts.
- **O5:** Git sync latency (2-15s) vs failover budget (<30s) unquantified.
- **O6:** `POST /listener/restart` response undefined — sync or async? Error handling?
