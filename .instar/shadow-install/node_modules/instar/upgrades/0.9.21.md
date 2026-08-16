# Upgrade Guide — vNEXT

## What Changed

### MessageSentinel Word Count Gate
The MessageSentinel now applies a **word count gate** to prevent conversational messages from being misclassified as emergency stops. Previously, any message starting with "please stop" (including "Please stop warning me about memory") would kill the session via regex pattern match — bypassing the LLM entirely.

**New behavior:**
- Messages with **4 or fewer words** are still fast-path classified (regex patterns fire as before)
- Messages with **5+ words** skip regex patterns entirely and route to LLM classification (or pass-through if no LLM is configured)
- **Slash commands** (`/stop`, `/pause`, etc.) are always processed regardless of message length
- Short emergency signals like "stop", "please stop", "cancel everything" still work instantly

This ensures the Sentinel catches true emergencies while letting conversational instructions reach the agent's LLM for proper interpretation.

### Runtime Memory Threshold Configuration
Memory pressure thresholds (warning, elevated, critical) can now be adjusted at runtime via the REST API. Previously, thresholds were fixed at startup.

**New endpoints:**
- `GET /monitoring/memory` — current memory state and thresholds
- `PATCH /monitoring/memory/thresholds` — update thresholds (e.g., `{ "warning": 80, "elevated": 90 }`)

When the user tells the agent "stop warning me about memory below 90%", the agent can now adjust the threshold via API instead of the Sentinel killing the session.

**Agent instruction update:** A new contextual action tells the agent about these endpoints when users request memory threshold changes.

## What to Tell Your User

Your agent now handles conversational messages more intelligently. Previously, messages like "please stop warning me about X" would accidentally kill your session. Now only short, clear emergency signals trigger fast-path session termination. Full sentences are properly routed to the AI for interpretation.

You can also now adjust memory warning thresholds through conversation — just tell your agent what threshold you prefer.

## Summary of New Capabilities

- **Smarter emergency detection**: Word count gate prevents false positive session kills on conversational messages
- **Configurable memory alerts**: Runtime threshold adjustment via REST API
- **Better agent instructions**: Agents are taught about memory threshold endpoints in their contextual action guide
