/**
 * Wiring integrity — the claude transcript resolver honors a session's LIVE
 * CLAUDE_CONFIG_DIR, and the two production consumers that hold a session
 * actually pass it.
 *
 * Why this exists: Echo's W32 observer is a subscription-pool-routed
 * claude-code session whose transcript lives under `<configHome>/projects`.
 * The resolver hard-coded `~/.claude/projects`, so the W32 heartbeat predicate
 * read "heartbeat-missing" for a live session and the age-kill transcript
 * probe was a structural no-op for pooled claude sessions. A refactor that
 * drops the option from either consumer silently re-blinds them; this pins it.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('claude transcript config-home wiring', () => {
  it('the resolver exposes configHome and routes claude-code under <configHome>/projects (rootOverride still wins)', () => {
    const src = read('src/core/FrameworkSessionStore.ts');
    expect(src).toMatch(/configHome\?: string;/);
    expect(src).toMatch(/opts\.rootOverride \?\? \(configHome \? path\.join\(configHome, 'projects'\) : path\.join\(home, '\.claude', 'projects'\)\)/);
  });

  it('the W32 liveness sample provider resolves the executor transcript with the session\'s live config home', () => {
    const src = read('src/server/AgentServer.ts');
    expect(src).toMatch(/options\.sessionManager\.configHomeForSession\(session\.tmuxSession\)/);
    expect(src).toMatch(/resolveFrameworkTranscriptPath\(\{ framework: session\.framework, sessionId: session\.claudeSessionId, projectDir: session\.cwd \?\? options\.config\.projectDir, \.\.\.\(configHome \? \{ configHome \} : \{\}\) \}\)/);
  });

  it('the three server-side transcript probes (session recovery, stale backstop, reaper gate E) pass the config home', () => {
    const server = read('src/commands/server.ts');
    expect(server).toMatch(/const recoveryProbeHome = \(session\.framework \?\? 'claude-code'\) === 'claude-code'\s*\? sessionManager\.configHomeForSession\(session\.tmuxSession\) : undefined;/);
    expect(server).toMatch(/\.\.\.\(recoveryProbeHome \? \{ configHome: recoveryProbeHome \} : \{\}\)/);
    expect(server).toMatch(/const backstopProbeHome = framework === 'claude-code' \? sessionManager\.configHomeForSession\(session\.tmuxSession\) : undefined;/);
    expect(server).toMatch(/configHomeForSession: \(s\) => sessionManager\.configHomeForSession\(s\),/);
    const reaper = read('src/monitoring/SessionReaper.ts');
    expect(reaper).toMatch(/configHomeForSession\?: \(tmuxSession: string\) => string \| undefined;/);
    expect(reaper).toMatch(/const configHome = framework === 'claude-code' \? this\.#deps\.configHomeForSession\?\.\(session\.tmuxSession\) : undefined;/);
  });

  it('both SessionManager transcript probes pass the claude config-home option', () => {
    const src = read('src/core/SessionManager.ts');
    const occurrences = src.match(/\.\.\.this\.claudeConfigHomeOption\(session\),/g) ?? [];
    expect(occurrences.length).toBe(2);
    expect(src).toMatch(/private claudeConfigHomeOption\(session: Session\): \{ configHome\?: string \}/);
    // Non-claude frameworks never consult CLAUDE_CONFIG_DIR.
    expect(src).toMatch(/if \(\(session\.framework \?\? 'claude-code'\) !== 'claude-code' \|\| !session\.tmuxSession\) return \{\};/);
  });
});
