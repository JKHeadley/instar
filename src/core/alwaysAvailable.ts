/**
 * "Always available" on macOS (docs/specs/create-agent-accounts-and-always-on.md §B.3, §B.5).
 *
 * When the person turns it on (Direct Mac build, FileVault off), the Instar app's privileged helper
 * installs a LaunchDaemon that runs this agent before anyone logs in, moves the agent's per-user
 * LaunchAgent plist aside, and writes a root-owned record:
 *
 *   /Library/Application Support/Instar/always-available/<agentName>.json
 *   { "version": 1, "agent": "<agentName>", "daemon": true, "daemonLabel": "ai.instar.always.<agentName>", ... }
 *
 * While `daemon` is true, nothing in Instar may put the per-user LaunchAgent back or start a second
 * copy of the agent: the autostart funnel, the fleet watchdog, the restart commands and the recovery
 * engine all read this record first. With FileVault on, the switch only keeps the Mac awake and
 * restarting (`daemon: false`), and the per-user LaunchAgent stays in charge.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ALWAYS_AVAILABLE_DIR = '/Library/Application Support/Instar/always-available';
const AGENT_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export interface AlwaysAvailableRecord {
  version: 1;
  agent: string;
  /** True when a LaunchDaemon runs this agent (FileVault off); false when only pmset was changed. */
  daemon: boolean;
  daemonLabel?: string;
  setAt?: string;
}

/** The record folder. Tests point it elsewhere with INSTAR_ALWAYS_AVAILABLE_DIR. */
export function alwaysAvailableDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.INSTAR_ALWAYS_AVAILABLE_DIR || ALWAYS_AVAILABLE_DIR;
}

/**
 * The record, or null when there is none. Only a clearly absent file (ENOENT) is "off". Anything
 * unclear counts as ON with a daemon: a file that can't be read (permissions, I/O), broken JSON, an
 * unknown version, a record naming another agent, or a `daemon` that isn't false. Starting a second
 * copy is the worse mistake (two servers fighting one state folder); the app's Settings shows how to
 * fix a damaged record. The watchdog script applies the same rule.
 */
export function readAlwaysAvailableRecord(agentName: string, env: NodeJS.ProcessEnv = process.env): AlwaysAvailableRecord | null {
  if (!AGENT_NAME.test(agentName) || agentName === '.' || agentName === '..') return null;
  const unclear: AlwaysAvailableRecord = { version: 1, agent: agentName, daemon: true };
  let raw: string;
  try { raw = fs.readFileSync(path.join(alwaysAvailableDir(env), `${agentName}.json`), 'utf-8'); } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : unclear; // @silent-fallback-ok — only a missing record means off
  }
  let r: Partial<AlwaysAvailableRecord>;
  try { r = JSON.parse(raw) as Partial<AlwaysAvailableRecord>; } catch { return unclear; } // @silent-fallback-ok — unreadable counts as on
  if (!r || r.version !== 1 || r.agent !== agentName) return unclear;
  return { version: 1, agent: agentName, daemon: r.daemon !== false, ...(typeof r.daemonLabel === 'string' ? { daemonLabel: r.daemonLabel } : {}), ...(typeof r.setAt === 'string' ? { setAt: r.setAt } : {}) };
}

/** True when a LaunchDaemon runs this agent, so its per-user LaunchAgent must stay off. */
export function daemonRunsAgent(agentName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readAlwaysAvailableRecord(agentName, env)?.daemon === true;
}

/** The agent name inside a per-user LaunchAgent label (`ai.instar.<name>`), or null. */
export function agentNameFromLabel(label: string): string | null {
  if (!label.startsWith('ai.instar.') || label === 'ai.instar.watchdog') return null;
  return label.slice('ai.instar.'.length) || null;
}

export const ALWAYS_AVAILABLE_REFUSAL =
  'Always available is on for this agent: a system service runs it, so its per-user start item stays off. Turn Always available off in the Instar app to change this.';

/** Why the per-user LaunchAgent must not be installed or loaded now, or null. */
export function alwaysAvailableRefusal(agentName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return daemonRunsAgent(agentName, env) ? ALWAYS_AVAILABLE_REFUSAL : null;
}
