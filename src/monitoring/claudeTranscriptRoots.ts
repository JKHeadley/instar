/**
 * Every Claude Code transcript root on this machine that a session of this
 * agent can write to (context budget §11; fixes fb-7e0b2088-ae5).
 *
 * The TokenLedger used to scan `~/.claude/projects` only. A session routed to a
 * subscription-pool login runs under that login's config home
 * (`CLAUDE_CONFIG_DIR`, e.g. `~/.claude-followme-<account>`), and its
 * transcript lands in `<config home>/projects`, so the ledger missed nearly
 * every session on a pooled agent.
 *
 * Sources, unioned (a home in more than one source is listed once):
 *  - the process default home (`CLAUDE_CONFIG_DIR` or `~/.claude`), which an
 *    unpooled session runs under;
 *  - every `~/.claude` / `~/.claude-*` directory on the host
 *    (`listClaudeConfigHomes`, the same enumeration the agent-owned memory link
 *    uses), which covers every follow-me login the pool created here;
 *  - every claude-code account in the subscription pool (its `configHome`),
 *    which covers a login whose home is outside `~`.
 *
 * Read-only: only directory listings and stats. Each root is
 * `<config home>/projects` and is returned only when it exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultClaudeConfigHome, listClaudeConfigHomes } from '../core/AgentOwnedMemory.js';

export interface TranscriptRootPool {
  list(): Array<{ framework?: string; configHome?: string }>;
}

export function claudeTranscriptRoots(opts: { pool?: TranscriptRootPool | null; home?: string; defaultHome?: string } = {}): string[] {
  const homes: string[] = [opts.defaultHome ?? defaultClaudeConfigHome()];
  homes.push(...listClaudeConfigHomes(opts.home ?? os.homedir()));
  try {
    for (const a of opts.pool?.list() ?? []) {
      if ((a.framework ?? 'claude-code') === 'claude-code' && typeof a.configHome === 'string' && a.configHome) homes.push(a.configHome);
    }
  } catch (err) {
    // Not silent: the host enumeration above still covers every home under ~.
    console.warn(`[token-ledger] subscription pool unreadable for transcript roots; using the host homes only: ${(err as Error).message}`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of homes) {
    // `~/.claude-followme-<id>.lock` directories are login locks, not homes.
    if (h.endsWith('.lock')) continue;
    const root = path.join(h, 'projects');
    let real: string;
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      real = fs.realpathSync(root);
    } catch { continue; /* @silent-fallback-ok — a login with no transcripts yet has no root */ }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(root);
  }
  return out;
}
