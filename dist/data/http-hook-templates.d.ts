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
export interface HookEventTemplate {
    event: string;
    matcher?: string;
    config: {
        type: 'command';
        command: string;
        timeout?: number;
    };
}
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
export declare const HOOK_EVENT_TEMPLATES: HookEventTemplate[];
export declare const HTTP_HOOK_TEMPLATES: HookEventTemplate[];
export type HttpHookTemplate = HookEventTemplate;
/**
 * Convert templates to the Claude Code settings.json hook format.
 * @param _serverUrl Ignored (kept for API compat). Command hooks use env vars.
 */
export declare function buildHttpHookSettings(_serverUrl: string): Record<string, Array<{
    matcher?: string;
    hooks: Array<Record<string, unknown>>;
}>>;
//# sourceMappingURL=http-hook-templates.d.ts.map