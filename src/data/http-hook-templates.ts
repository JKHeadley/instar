/**
 * HTTP Hook Templates — Configuration for Claude Code HTTP hooks.
 *
 * These templates are merged into .claude/settings.json during init.
 * They configure HTTP hooks that POST event payloads to the Instar server
 * for session telemetry and observability.
 *
 * Part of the Claude Code Feature Integration Audit:
 * - Item 2 (HTTP Hooks): Ship HTTP hook templates for observability events
 * - Item 3 (New Hook Events): SubagentStart/Stop, Stop, SessionEnd, etc.
 *
 * Design decisions:
 * - Safety-critical hooks (dangerous-command-guard, session-start) stay as shell commands
 * - HTTP hooks are for OBSERVABILITY only — they cannot reliably block actions
 * - All hooks POST to /hooks/events on the local Instar server
 * - Auth via bearer token from INSTAR_AUTH_TOKEN env var
 */

export interface HttpHookTemplate {
  event: string;
  matcher?: string;
  config: {
    type: 'http';
    url: string;
    timeout?: number;
    headers?: Record<string, string>;
    allowedEnvVars?: string[];
  };
}

/**
 * Base URL template — resolved at install time to the actual server port.
 * Uses INSTAR_SERVER_URL env var which is set in session-start.sh.
 */
const BASE_URL = '${INSTAR_SERVER_URL}/hooks/events?instar_sid=${INSTAR_SESSION_ID}';

/**
 * All HTTP hook templates for observability events.
 *
 * These are added alongside (not replacing) existing shell command hooks.
 * Events covered:
 * - PostToolUse: what tools sessions are using
 * - SubagentStart: when subagents spawn (with agent_id, agent_type)
 * - SubagentStop: when subagents finish (with last_assistant_message, transcript path)
 * - Stop: when main agent finishes (with last_assistant_message)
 * - WorktreeCreate: when worktrees are created (connects to worktree awareness)
 * - WorktreeRemove: when worktrees are removed
 * - TaskCompleted: when tasks finish (with task_id, subject, description)
 * - SessionEnd: when sessions terminate (with exit reason)
 * - PreCompact: when context compaction is about to occur (with trigger reason)
 */
export const HTTP_HOOK_TEMPLATES: HttpHookTemplate[] = [
  {
    event: 'PostToolUse',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'SubagentStart',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'SubagentStop',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'Stop',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'WorktreeCreate',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'WorktreeRemove',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'TaskCompleted',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'SessionEnd',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
  {
    event: 'PreCompact',
    config: {
      type: 'http',
      url: BASE_URL,
      timeout: 5,
      headers: { Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}' },
      allowedEnvVars: ['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID'],
    },
  },
];

/**
 * Convert templates to the Claude Code settings.json hook format.
 * @param serverUrl The actual Instar server URL (e.g., "http://localhost:3030")
 */
export function buildHttpHookSettings(serverUrl: string): Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> {
  const settings: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> = {};

  for (const template of HTTP_HOOK_TEMPLATES) {
    const hookConfig = {
      ...template.config,
      url: template.config.url.replace('${INSTAR_SERVER_URL}', serverUrl),
    };

    if (!settings[template.event]) {
      settings[template.event] = [];
    }

    const entry: { matcher?: string; hooks: Array<Record<string, unknown>> } = {
      hooks: [hookConfig as unknown as Record<string, unknown>],
    };
    if (template.matcher) {
      entry.matcher = template.matcher;
    }

    settings[template.event].push(entry);
  }

  return settings;
}
