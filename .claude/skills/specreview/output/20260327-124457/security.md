# Security Review — Presence Proxy (Intelligent Response Standby)

**Review ID**: 20260327-124457 | **Round**: 1 | **Date**: 2026-03-27
**Reviewer**: Security
**Score**: 5/10
**Approval Status**: CONDITIONAL — DO NOT IMPLEMENT AS WRITTEN

---

## Research Findings

**Prompt Injection in LLM Monitoring Systems**: OWASP LLM01:2025, NVIDIA, and academic research confirm indirect prompt injection is the dominant attack vector when LLMs summarize untrusted data sources. Any text in tmux output becomes part of the prompt context. The Presence Proxy feeds raw terminal output to LLMs across all three tiers with no sanitization described.

**Tmux Session Capture Risks**: Security research documents that terminal scrollback buffers routinely contain API keys, passwords, OAuth tokens, database connection strings, and private file contents. The spec captures up to 200 lines and — when `ANTHROPIC_API_KEY` is set — transmits this to Anthropic's external servers.

**LLM Proxy Impersonation**: Research shows 82.4% of LLMs can be compromised through inter-agent trust exploitation. The Presence Proxy is exactly this peer-agent surface: its messages appear in conversation history, and the real agent ingests proxy messages as context.

---

## Critical Issues

### CRITICAL-1: Prompt Injection via Tmux Output
**Location**: All tiers — LLM prompt context sections

Raw tmux output is fed directly into LLM prompts. A malicious npm package, compromised API response, or crafted README file can embed instructions in terminal output. The proxy would faithfully summarize or be manipulated to include attacker content in a message that appears trusted.

**Fix**: Wrap all tmux output in untrusted-data delimiters in the system prompt. Strip ANSI codes and control characters. Hard-cap output length with blunt truncation.

### CRITICAL-2: Unauthenticated Command Execution (unstick / restart / quiet)
**Location**: "User Commands" table; Edge Case 6

Anyone who can send a Telegram message to the bot can execute `restart` (destroys a running session) or `unstick` (sends Ctrl+C to the agent). Edge Case 6 explicitly says "unstick should still work" regardless of proxy state — making it universally triggerable. No sender authentication, rate limiting, or confirmation step exists.

**Fix**: Validate Telegram `from.id` against a config-defined authorized user ID whitelist before executing any command. Require confirmation for `restart`. Rate-limit `unstick` to 3/topic/hour.

### CRITICAL-3: Sensitive Data Exfiltration to External LLM API
**Location**: "LLM Provider: No API Key Required" section

When `ANTHROPIC_API_KEY` is configured, up to 200 lines of terminal output (containing credentials, tokens, private code) are transmitted to Anthropic's external servers. The spec frames this as a seamless convenience feature with no data sensitivity controls.

**Fix**: Default `allowExternalLLM` to `false`. Run a local credential scanner (strip lines matching `sk-*`, `Bearer `, `password=`, connection string patterns) before any external transmission. Document this data flow explicitly.

---

## High-Severity Issues

**HIGH-1: Proxy Impersonation / Trust Confusion** — The proxy speaks in nearly the same voice as the agent. Agent sessions ingest proxy messages as conversation history context. A prompt-injected proxy message could mislead the agent about its own prior state. Fix: inject a system-level disambiguation notice into agent context when proxy messages exist.

**HIGH-2: Timer State Loss Enables Restart Attack** — Timers are in-memory only. An attacker who triggers a restart causes mass re-initialization of all topic timers — simultaneously firing LLM calls for every active topic (cost amplification). Fix: persist PresenceState to disk; add restart-debounce.

**HIGH-3: No LLM Call Rate Limiting** — An attacker sending messages every 19 seconds generates a Haiku call every 20 seconds indefinitely. Fix: cap at ~20 LLM calls/topic/hour.

**HIGH-4: `quiet` Command Is a Monitoring Bypass** — Combined with CRITICAL-2, an attacker can silence the proxy for 30 minutes, then trigger a stall or forced restart with no user notification. Fix: apply the same sender authentication fix.

---

## Moderate Issues

**MOD-1**: No snapshot size cap in PresenceState — large tmux output can cause memory exhaustion across many topics. Cap at 10KB/snapshot.

**MOD-2**: The `metadata.source: "presence-proxy"` field on `/telegram/reply/{topicId}` is not restricted to internal callers. External callers could forge proxy provenance in logs. Restrict to internal code paths only.

**MOD-3**: Process whitelist matches on name, not full path. A script named `npm` or `pytest` in the working directory auto-classifies as `waiting` indefinitely. Match on full process path from known locations.

**MOD-4**: No audit log for proxy LLM call inputs. Outputs are logged but prompts (containing tmux snapshots) are ephemeral. A prompt injection incident would leave no forensic evidence of the input. Add `presence-proxy-audit.jsonl`.

---

## Recommendations (Prioritized)

| Priority | Fix |
|----------|-----|
| P0 | Prompt injection defenses for all tmux-output-to-LLM paths |
| P0 | Telegram sender ID authentication for all action commands |
| P0 | Default external LLM to disabled; add local credential scrubbing |
| P1 | Audit log for proxy LLM call inputs (`presence-proxy-audit.jsonl`) |
| P1 | Per-topic LLM call rate limit (~20/hour) |
| P1 | Persist PresenceState to disk (prevent restart amplification) |
| P2 | System-level disambiguation notice for proxy messages in agent context |
| P2 | 10KB cap per tmux snapshot in PresenceState |
| P2 | Restrict `metadata.source` to internal code paths |
| P3 | Confirmation step for `restart` command |

---

## Scalability Assessment

Adequate for single-user, single-machine use. Inadequate under adversarial conditions without rate limiting. Multi-machine deployments are not addressed — PresenceState is lost on failover.

**The three critical issues must be resolved before implementation begins.** The Presence Proxy is a sound operational design that needs a security pass equal to the care given to its false-positive safeguards.
