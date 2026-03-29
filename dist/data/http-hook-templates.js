/**
 * Hook Event Templates — Configuration for Claude Code event reporting hooks.
 *
 * These templates are merged into .claude/settings.json during init.
 * They configure command hooks that POST event payloads to the Instar server
 * for session telemetry, observability, and session resumption (claudeSessionId).
 *
 * IMPORTANT: Uses command hooks (type: "command"), NOT HTTP hooks (type: "http").
 * HTTP hooks silently fail to fire in Claude Code <=2.1.78 (confirmed 2026-03-24).
 * Command hooks reliably fire, so we use a small Node script that POSTs to the server.
 *
 * Design decisions:
 * - Safety-critical hooks (dangerous-command-guard, session-start) stay as separate scripts
 * - Event reporter hooks are for OBSERVABILITY — they cannot reliably block actions
 * - All hooks POST to /hooks/events on the local Instar server via the reporter script
 * - Auth via bearer token from INSTAR_AUTH_TOKEN env var
 */
/**
 * All hook event templates for observability events.
 *
 * These are added alongside (not replacing) existing shell command hooks.
 * Events covered:
 * - PostToolUse: what tools sessions are using + session_id for resume
 * - SubagentStart: when subagents spawn (with agent_id, agent_type)
 * - SubagentStop: when subagents finish (with last_assistant_message, transcript path)
 * - Stop: when main agent finishes (with last_assistant_message)
 * - WorktreeCreate: when worktrees are created (connects to worktree awareness)
 * - WorktreeRemove: when worktrees are removed
 * - TaskCompleted: when tasks finish (with task_id, subject, description)
 * - SessionEnd: when sessions terminate (with exit reason)
 * - PreCompact: when context compaction is about to occur (with trigger reason)
 */
export const HOOK_EVENT_TEMPLATES = [
    { event: 'PostToolUse', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'SubagentStart', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'SubagentStop', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'Stop', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'WorktreeCreate', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'WorktreeRemove', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'TaskCompleted', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'SessionEnd', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
    { event: 'PreCompact', config: { type: 'command', command: 'node .instar/hooks/instar/hook-event-reporter.js', timeout: 3000 } },
];
// Backwards-compat export — old name, new behavior
export const HTTP_HOOK_TEMPLATES = HOOK_EVENT_TEMPLATES;
/**
 * Convert templates to the Claude Code settings.json hook format.
 * @param _serverUrl Ignored (kept for API compat). Command hooks use env vars.
 */
export function buildHttpHookSettings(_serverUrl) {
    const settings = {};
    for (const template of HOOK_EVENT_TEMPLATES) {
        if (!settings[template.event]) {
            settings[template.event] = [];
        }
        const entry = {
            matcher: template.matcher ?? '',
            hooks: [template.config],
        };
        settings[template.event].push(entry);
    }
    return settings;
}
//# sourceMappingURL=http-hook-templates.js.map