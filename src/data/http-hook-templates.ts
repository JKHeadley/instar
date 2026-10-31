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
export const HOOK_EVENT_TEMPLATES: HookEventTemplate[] = [
  { event: 'PostToolUse', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'SubagentStart', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'SubagentStop', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'Stop', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'WorktreeCreate', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'WorktreeRemove', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'TaskCompleted', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'SessionEnd', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
  { event: 'PreCompact', config: { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"', timeout: 3000 } },
];

// Backwards-compat export — old name, new behavior
export const HTTP_HOOK_TEMPLATES = HOOK_EVENT_TEMPLATES;
export type HttpHookTemplate = HookEventTemplate;

/**
 * Convert templates to the Claude Code settings.json hook format.
 * @param _serverUrl Ignored (kept for API compat). Command hooks use env vars.
 */
export function buildHttpHookSettings(_serverUrl: string): Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> {
  const settings: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> = {};

  for (const template of HOOK_EVENT_TEMPLATES) {
    if (!settings[template.event]) {
      settings[template.event] = [];
    }

    const entry: { matcher: string; hooks: Array<Record<string, unknown>> } = {
      matcher: template.matcher ?? '',
      hooks: [template.config as unknown as Record<string, unknown>],
    };

    settings[template.event].push(entry);
  }

  return settings;
}

// ── Native hook events (docs/specs/native-hook-events.md D1/D4) ─────
//
// When `hooks.nativeEventReporter.enabled` is true (and the gate in
// src/core/nativeHookEventsGate.ts admits it), the reporter command entry on
// each of the 7 reporting events is replaced by a Claude Code `type: "http"`
// hook that POSTs straight to the server — no process per event. The worktree
// events are deliberately NOT in this set: a hook on WorktreeCreate/Remove
// replaces Claude Code's own git behaviour (D3 removes them separately), and
// this reconcile must never emit or restore them in either direction.

/** The 7 reporting events the native reporter covers. */
export const NATIVE_REPORTER_EVENTS = [
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'TaskCompleted',
  'SessionEnd',
  'PreCompact',
] as const;
export type NativeReporterEvent = typeof NATIVE_REPORTER_EVENTS[number];

/**
 * The native route path. Deliberately NOT containing `/hooks/events`, which
 * `migrateHttpHookSessionId` and `migrateHttpHooksToCommandHooks` match by
 * substring and would rewrite or revert.
 */
export const NATIVE_HOOK_EVENTS_PATH = '/hooks/native-events';

/** The exact command reporter hook today's template writes (restored on rollback). */
export const REPORTER_COMMAND_HOOK: Readonly<{ type: 'command'; command: string; timeout: number }> = Object.freeze({
  type: 'command',
  command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"',
  timeout: 3000,
});

export const NATIVE_HOOK_ALLOWED_ENV_VARS = ['INSTAR_AUTH_TOKEN', 'INSTAR_SESSION_ID', 'INSTAR_SESSION_NAME', 'INSTAR_AGENT_ID'] as const;

/** Build the native reporter hook for a loopback base URL (`http://127.0.0.1:<port>`). */
export function buildNativeReporterHook(baseUrl: string): Record<string, unknown> {
  return {
    type: 'http',
    url: `${baseUrl.replace(/\/+$/, '')}${NATIVE_HOOK_EVENTS_PATH}`,
    // Claude Code reads hook timeouts in SECONDS.
    timeout: 1,
    headers: {
      Authorization: 'Bearer ${INSTAR_AUTH_TOKEN}',
      'X-Instar-Session-Id': '${INSTAR_SESSION_ID}',
      'X-Instar-Session': '${INSTAR_SESSION_NAME}',
      'X-Instar-AgentId': '${INSTAR_AGENT_ID}',
    },
    allowedEnvVars: [...NATIVE_HOOK_ALLOWED_ENV_VARS],
  };
}

/** True when `h` is the instar-owned native reporter hook (any port). */
export function isNativeReporterHook(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const o = h as Record<string, unknown>;
  return o.type === 'http' && typeof o.url === 'string' && o.url.includes(NATIVE_HOOK_EVENTS_PATH);
}

/** True when `h` is the instar-owned reporter command (identified by its `hooks/instar/` path). */
export function isReporterCommandHook(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const o = h as Record<string, unknown>;
  return o.type === 'command' && typeof o.command === 'string' && /hooks\/instar\/hook-event-reporter\.js/.test(o.command);
}

function isReporterHook(h: unknown): boolean {
  return isNativeReporterHook(h) || isReporterCommandHook(h);
}

function sameHook(a: unknown, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ReconcileReporterOptions {
  /** true ⇒ native http entries; false ⇒ today's command entries. */
  native: boolean;
  /** Loopback base URL for the native entries (required when native). */
  baseUrl?: string;
}

/**
 * Rewrite the instar-owned reporter entries on the 7 reporting events to match
 * the decision, in place. Only hooks identified as instar's reporter (the
 * `hooks/instar/hook-event-reporter.js` command or the native URL) are
 * touched; every other hook, entry and matcher is left alone, and events
 * outside the 7 (WorktreeCreate/WorktreeRemove among them) are never read or
 * written. Within an event, a second reporter hook (e.g. a merge left both a
 * command and a native one) is removed so the event reports once. No entry is
 * ever ADDED here (ensureHttpHooksExist owns installing the reporter).
 * Idempotent: a second call returns false.
 */
export function reconcileReporterHooks(
  hooks: Record<string, unknown>,
  opts: ReconcileReporterOptions,
): boolean {
  if (opts.native && !opts.baseUrl) throw new Error('reconcileReporterHooks: baseUrl required when native');
  const desired: Record<string, unknown> = opts.native
    ? buildNativeReporterHook(opts.baseUrl!)
    : { ...REPORTER_COMMAND_HOOK };
  let changed = false;
  for (const event of NATIVE_REPORTER_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    let seen = false;
    const emptied = new Set<unknown>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (!Array.isArray(e.hooks)) continue;
      const list = e.hooks as unknown[];
      for (let j = 0; j < list.length; j++) {
        if (!isReporterHook(list[j])) continue;
        if (seen) {
          list.splice(j, 1);
          j--;
          changed = true;
          if (list.length === 0) emptied.add(entry);
          continue;
        }
        seen = true;
        if (!sameHook(list[j], desired)) {
          list[j] = JSON.parse(JSON.stringify(desired));
          changed = true;
        }
      }
    }
    // Drop only an entry the de-duplication itself emptied.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (emptied.has(entries[i])) entries.splice(i, 1);
    }
  }
  return changed;
}

/** Pure check: does `hooks` already match the decision? (no mutation) */
export function reporterHooksMatch(hooks: Record<string, unknown>, opts: ReconcileReporterOptions): boolean {
  const copy = JSON.parse(JSON.stringify(hooks ?? {})) as Record<string, unknown>;
  return !reconcileReporterHooks(copy, opts);
}
