/**
 * memorySessionPolicy — the launch policy for a session serving a person or a
 * shared place on a multi-person agent. Spec: docs/specs/memory-privacy.md §4.
 *
 * The proven leak was an ordinary `grep` over a shared memory file, so the
 * boundary is what the session can reach, not what each store remembers to hide.
 * Each rule below was checked against the real Claude Code binary:
 *  - A file-tool deny on a parent beats any allow, and `dontAsk` auto-allows
 *    reads in the working directory, so scope folders live OUTSIDE the agent home.
 *  - Denying the agent home's root stops CLAUDE.md loading, so the deny lists
 *    top-level entries and leaves CLAUDE.md and .claude readable.
 *  - Rules for absolute paths need the `//` prefix; a single `/` matches nothing.
 *  - `~/.claude*\/history.jsonl` holds every prompt, so the shell denies the whole
 *    home and the temp roots and re-allows an exact list.
 */

import fs from 'node:fs';
import path from 'node:path';

const INBOUND_FILE_MAX_AGE_MS = 10 * 60_000;

export const MEMORY_SESSION_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Skill', 'WebFetch', 'WebSearch', 'TodoWrite'] as const;

/** Top-level entries of the agent home a session must still be able to read. */
const READABLE_HOME_ENTRIES = new Set(['CLAUDE.md', '.claude']);

/** Files a session must not rewrite, because they load for everyone or run outside the sandbox. */
const PROTECTED_WRITES = ['CLAUDE.md', 'AGENT.md', '.claude/**'];

export interface MemorySessionPaths {
  agentHome: string;
  scopeDir: string;
  homeDir: string;
  /** Names of the agent home's top-level entries at spawn. */
  agentHomeEntries: readonly string[];
  /** Reply scripts the session needs to run. */
  replyScripts: readonly string[];
  /** Temp roots to deny, e.g. /tmp and /private/tmp. */
  tempRoots: readonly string[];
}

const abs = (tool: string, p: string): string => `${tool}(/${p})`;

export function buildMemorySessionSettings(p: MemorySessionPaths): Record<string, unknown> {
  const deny: string[] = [];
  for (const entry of p.agentHomeEntries) {
    if (READABLE_HOME_ENTRIES.has(entry)) continue;
    const target = path.join(p.agentHome, entry);
    for (const tool of ['Read', 'Edit', 'Write']) {
      deny.push(abs(tool, target), abs(tool, `${target}/**`));
    }
  }
  for (const rel of PROTECTED_WRITES) {
    const target = path.join(p.agentHome, rel);
    deny.push(abs('Edit', target), abs('Write', target));
  }
  return {
    autoMemoryDirectory: p.scopeDir,
    permissions: { deny },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: [...new Set([p.homeDir, p.agentHome, ...p.tempRoots])],
        allowRead: [p.scopeDir, ...p.replyScripts],
        allowWrite: [p.scopeDir],
      },
      network: {
        allowLocalBinding: true,
        allowUnixSockets: [],
        allowedDomains: ['localhost', '127.0.0.1', '*.com', '*.org', '*.net', '*.io', '*.ai', '*.dev', '*.app'],
      },
    },
  };
}

/**
 * Linux only: let the session's curl reach the agent server. bubblewrap gives the
 * session its own network namespace, so localhost inside it is not the agent's
 * server, and the sandbox's NO_PROXY sends localhost past the proxy that could
 * carry it. Every reply script uses plain curl, so a curl config that clears
 * NO_PROXY sends localhost through the sandbox proxy, which allows it (it is in
 * allowedDomains). Reach is the same as on macOS, where the session shares the
 * host's loopback. Measured with Claude Code 2.1.318 on Ubuntu 24.04: without
 * this, curl exit 7; with it, HTTP 200 from the server and outside hosts unchanged.
 * Returns the folder to pass as CURL_HOME, or null where nothing is needed.
 */
export function prepareSessionCurlHome(scopeDir: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'linux') return null;
  const curlHome = path.join(scopeDir, '.curl');
  fs.mkdirSync(curlHome, { recursive: true, mode: 0o700 });
  // Rewritten at every spawn: the folder is the session's own, so it may have changed it.
  fs.writeFileSync(path.join(curlHome, '.curlrc'), 'noproxy = ""\n', { mode: 0o600 });
  return curlHome;
}

/** `--allowedTools` entries: the plain tools, and file tools on the scope folder only. */
export function memorySessionAllowedTools(scopeDir: string): string[] {
  return [
    ...MEMORY_SESSION_TOOLS.filter((t) => !['Read', 'Edit', 'Write'].includes(t)),
    abs('Read', `${scopeDir}/**`),
    abs('Edit', `${scopeDir}/**`),
    abs('Write', `${scopeDir}/**`),
  ];
}

/**
 * Rewrite a claude-code launch into the memory-session form, in place. Throws when
 * the form was not applied, so a spawn can never silently run with full reach.
 */
export function applyMemorySessionLaunch(argv: string[], settingsPath: string, scopeDir: string): void {
  for (let at = argv.indexOf('--dangerously-skip-permissions'); at >= 0; at = argv.indexOf('--dangerously-skip-permissions')) {
    argv.splice(at, 1);
  }
  const form = [
    '--permission-mode', 'dontAsk',
    '--tools', MEMORY_SESSION_TOOLS.join(','),
    '--allowedTools', ...memorySessionAllowedTools(scopeDir),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', settingsPath,
  ];
  const dashP = argv.indexOf('-p');
  argv.splice(dashP > 0 ? dashP : argv.length, 0, ...form);
  if (argv.includes('--dangerously-skip-permissions') || !argv.includes('dontAsk') || !argv.includes(settingsPath)) {
    throw new Error('memory-session-launch-missing: the memory session form was not applied');
  }
}

/**
 * Copy files named in an inbound message into the session's own inbox and point
 * the text at the copies. A person's long messages and attachments are saved
 * under shared folders the session cannot read; without this the agent would
 * answer them blind. Only paths under `roots` are touched, so a path a person
 * typed elsewhere stays plain text and cannot pull in another file.
 */
export function moveInboundFilesIntoScope(text: string, scopeDir: string, roots: readonly string[], now: number = Date.now()): string {
  let out = text;
  for (const root of roots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}/[^\\s"'\`)\\]]+`, 'g');
    out = out.replace(pattern, (match) => {
      const resolved = path.resolve(match);
      if (!resolved.startsWith(`${root}/`)) return match;
      const target = path.join(scopeDir, 'inbox', path.basename(resolved));
      try {
        // Only what just arrived: a person cannot pull in an older attachment by typing its path.
        if (now - fs.statSync(resolved).mtimeMs > INBOUND_FILE_MAX_AGE_MS) return match;
        fs.copyFileSync(resolved, target);
        return target;
      } catch {
        // @silent-fallback-ok — no such file: the text is left as it was typed.
        return match;
      }
    });
  }
  return out;
}
