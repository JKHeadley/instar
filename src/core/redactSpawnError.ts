/**
 * redactSpawnError — render a failed `tmux new-session` as text that is safe
 * to put in a thrown Error, an HTTP body or a log line (#2184).
 *
 * Spawn sites pass per-session credentials to tmux as argv (`-e GH_TOKEN=…`,
 * `-e INSTAR_AUTH_TOKEN=…`, `-e ANTHROPIC_API_KEY=…`). When the command fails,
 * Node's child-process error message is `Command failed: <full argv>\n<stderr>`,
 * so echoing it verbatim (as POST /sessions/spawn did) hands every injected
 * secret to the caller. This keeps only what explains the failure: the exit
 * status/signal/code and a scrubbed, bounded stderr excerpt. The argv line is
 * dropped outright rather than pattern-scrubbed, so a secret of an unknown
 * shape cannot slip through it.
 */

import { scrubSecrets } from '../monitoring/scrubSecrets.js';

const MAX_DETAIL_CHARS = 500;

/** Strip values from `NAME=value` env assignments and known token shapes. */
function scrubDetail(text: string): string {
  return scrubSecrets(text)
    .replace(/\b([A-Z][A-Z0-9_]*)=\S+/g, '$1=[redacted]')
    .replace(/ior1_[A-Za-z0-9_-]{43}/g, '[origin-token-redacted]');
}

export function redactSpawnError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown; signal?: unknown; code?: unknown; stderr?: unknown;
  };

  // Never keep the `Command failed: <argv>` text. An argv element can itself
  // span lines (a multi-line prompt), so the message is discarded from
  // `Command failed:` on and the child-process error's own stderr, when it
  // carries one, stands in for the reason.
  const at = raw.indexOf('Command failed:');
  const commandFailed = at !== -1;
  const stderr = typeof e.stderr === 'string' ? e.stderr
    : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf-8') : '';
  let detail = commandFailed ? `${raw.slice(0, at)}${stderr}` : raw;
  detail = scrubDetail(detail).trim();
  if (detail.length > MAX_DETAIL_CHARS) detail = `${detail.slice(0, MAX_DETAIL_CHARS)}…`;
  if (!commandFailed) return detail || 'session spawn failed';

  const facts: string[] = [];
  if (typeof e.status === 'number') facts.push(`exit status ${e.status}`);
  if (typeof e.signal === 'string' && e.signal) facts.push(`signal ${e.signal}`);
  if (typeof e.code === 'string' && e.code) facts.push(`code ${e.code}`);

  const head = facts.length > 0 ? `tmux new-session failed (${facts.join(', ')})` : 'tmux new-session failed';
  return detail ? `${head}: ${detail}` : head;
}
