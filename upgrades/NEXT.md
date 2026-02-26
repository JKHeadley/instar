# Upgrade Guide — vNEXT

## What Changed

### LLM-Supervised Execution: Intelligence Layer Wired Throughout

Previously, several critical pathways bypassed the intelligence layer and relied on regex pattern matching alone for decisions that affect user experience. This release wires a shared `IntelligenceProvider` through all critical decision points:

**MessageSentinel (Layer 2 now active)**
- The sentinel's LLM classification layer was dead code — constructed with `new MessageSentinel({})` (no intelligence). Now wired with a shared intelligence provider. Messages that pass the word count gate but don't match fast-path patterns are classified by LLM instead of defaulting to pass-through.

**Telegram Stall/Promise Alerts (LLM-gated)**
- Fallback stall alerts (when StallTriageNurse is unavailable) now pass through an LLM confirmation before sending user-facing messages. Prevents false positive alerts about sessions that are actually working on complex tasks.
- Promise expiration alerts follow the same LLM gate.

**SessionWatchdog (LLM command analysis)**
- Before escalating from monitoring to Ctrl+C, the watchdog now asks the intelligence provider whether the long-running command is legitimately slow (builds, installs, migrations) or actually stuck. Legitimate commands are temporarily excluded from escalation.

**Shared Intelligence Provider**
- A single `IntelligenceProvider` instance (Anthropic API preferred, Claude CLI fallback) is created at startup and shared across Sentinel, TelegramAdapter, SessionWatchdog, and StallTriageNurse. This eliminates redundant provider creation and ensures consistent LLM access.

### Technical Details

- All LLM gates are fail-open: if the intelligence provider fails, the original behavior is preserved
- Shared intelligence is created early in startup, before component initialization
- Startup log now shows intelligence status: `sentinel=LLM-supervised`, `stall alerts: LLM-gated`

## What to Tell Your User

Your agent's safety systems now use LLM intelligence for critical decisions that previously relied on regex alone. The message sentinel can now classify ambiguous messages using an LLM instead of just pattern matching. Stall alerts and the session watchdog check with an LLM before taking action, reducing false positives. No configuration needed — this works automatically when an Anthropic API key or Claude CLI is available.

## Summary of New Capabilities

- **Sentinel LLM classification**: Ambiguous messages now classified by LLM (Layer 2 was previously dead code)
- **LLM-gated stall alerts**: Fallback alerts confirmed by intelligence before sending to user
- **LLM-gated watchdog**: Long-running commands evaluated by LLM before escalation
- **Shared intelligence provider**: Single provider instance shared across all components
