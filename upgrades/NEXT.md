# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

<!-- Describe what changed technically. What new features, APIs, behavioral changes? -->
<!-- Write this for the AGENT — they need to understand the system deeply. -->

- Replaced all shell-dependent npm calls in server startup (better-sqlite3 auto-rebuild) with shell-free alternatives using npm's CLI JS directly via Node.js. Fixes "spawnSync /bin/sh ENOENT" failures in minimal/containerized environments.
- Added findNpmCli helper that locates npm's entry point without requiring a shell.
- Affects ensureSqliteBindings preflight and TopicMemory auto-rebuild fallback.

## What to Tell Your User

<!-- Write talking points the agent should relay to their user. -->
<!-- This should be warm, conversational, user-facing — not a changelog. -->
<!-- Focus on what THEY can now do, not internal plumbing. -->
<!--                                                                    -->
<!-- PROHIBITED in this section (will fail validation):                 -->
<!--   camelCase config keys: silentReject, maxRetries, telegramNotify -->
<!--   Inline code backtick references like silentReject: false        -->
<!--   Fenced code blocks                                              -->
<!--   Instructions to edit files or run commands                      -->
<!--                                                                    -->
<!-- CORRECT style: "I can turn that on for you" not "set X to false"  -->
<!-- The agent relays this to their user — keep it human.              -->

- **Better startup reliability**: "Agents running in Docker or minimal Linux environments should no longer see memory system degradation at startup. The native module rebuild now works without requiring a system shell."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shell-free native module rebuild | Automatic — no user action needed |
