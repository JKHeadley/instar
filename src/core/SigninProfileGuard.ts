import fs from 'node:fs';
import path from 'node:path';

/** Google identity profiles are the durable seed for subscription sign-in repair. */
export function isSigninProfile(profile: { accounts?: Array<{ service: string }> }): boolean {
  return profile.accounts?.some(account => account.service.toLowerCase() === 'google') === true;
}

function canonical(directory: string): string {
  try { return fs.realpathSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.resolve(directory);
  }
}

/** Re-read before CDP launch/profile mutation. Normal Chrome overrides open(). */
export function assertNotSigninProfile(userDataDir: string): void {
  const roots = new Set<string>();
  if (process.env.INSTAR_AGENT_HOME) roots.add(process.env.INSTAR_AGENT_HOME);
  for (const start of [path.resolve(userDataDir), canonical(userDataDir)]) {
    for (let directory = start; ; directory = path.dirname(directory)) {
      if (path.basename(directory) === '.instar') roots.add(path.dirname(directory));
      if (path.dirname(directory) === directory) break;
    }
  }
  for (const root of roots) {
    let store: { profiles: Array<{ userDataDir: string | null; accounts: Array<{ service: string }> }> };
    try { store = JSON.parse(fs.readFileSync(path.join(root, '.instar/state/playwright-profiles.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('signin-profile-registry-unavailable');
    }
    if (!Array.isArray(store.profiles)) throw new Error('signin-profile-registry-unavailable');
    if (store.profiles.some(profile => isSigninProfile(profile) && profile.userDataDir && canonical(profile.userDataDir) === canonical(userDataDir))) {
      throw new Error('signin-profile-automation-refused: use normal Chrome and subscription-signin; use a disposable profile for tests');
    }
  }
}

/** Cooperative tool boundary, not an OS sandbox for hostile arbitrary code. */
export function signinProfileGuardHook(): string {
  return '#!/usr/bin/env node\n' + String.raw`(async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const deny = reason => { process.stderr.write('Sign-in profile guard: ' + reason + '. Use normal Chrome with subscription-signin for repair, or a disposable browser profile for tests.\n'); process.exitCode = 2; };
  let event;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { deny('invalid-tool-event'); return; }
  const name = String(event.tool_name || event.toolName || '').toLowerCase();
  let input = event.tool_input || event.arguments || {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
  const shell = /(?:^|[._/])(bash|shell|exec_command|shell_command)$/.test(name);
  const orchestrator = /(?:^|[._/])functions[._/]exec$/.test(name);
  const browser = /playwright|puppeteer|selenium|cdp|browser/.test(name);
  if (!shell && !browser && !orchestrator) return;
  let text = typeof input === 'string' ? input : shell ? String(input.command || input.cmd || '') : JSON.stringify(input);
  if (orchestrator) {
    // Source edits inside orchestration are data, not browser execution. Native
    // exec hooks inspect dynamic calls; inspect literal shell calls here too.
    const commands = [...text.matchAll(/tools\.(?:exec_command|shell_command)\s*\(\s*\{\s*cmd\s*:\s*(["'])([\s\S]*?)\1/g)].map(m => m[2]);
    if (!commands.length) return;
    text = commands.join('\n');
  }
  // A script launched by filename must not hide the profile/launch. Bound reads,
  // inspect source only; never execute a script to classify it.
  if ((shell || orchestrator) && /(?:^|[\s;&|])(?:node|python[0-9.]*)\s/.test(text)) {
    const cwd = input.workdir || event.cwd || process.cwd();
    for (const match of text.matchAll(/(?:^|[\s"'])([^\s"';|<>]+\.(?:mjs|cjs|js|py))(?=[\s"';|<>]|$)/g)) {
      const file = path.resolve(cwd, match[1]);
      try { if (fs.statSync(file).size <= 262144) text += '\n' + fs.readFileSync(file, 'utf8'); } catch {}
    }
  }
  const automated = browser || /launchPersistentContext|launch_persistent_context|connectOverCDP|connect_over_cdp|(?:from|require|import).*['"](?:playwright|puppeteer|selenium)|(?:npx|exec)\s+(?:@playwright|playwright|puppeteer)|--remote-debugging-(?:port|pipe)|--use-mock-keychain|--password-store=basic/i.test(text);
  if (!automated) return;
  const project = process.env.INSTAR_AGENT_HOME || process.env.INSTAR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd();
  let profiles;
  try {
    const store = JSON.parse(fs.readFileSync(path.join(project, '.instar/state/playwright-profiles.json'), 'utf8'));
    if (!Array.isArray(store.profiles)) throw new Error('invalid registry');
    profiles = store.profiles.filter(p => Array.isArray(p.accounts) && p.accounts.some(a => typeof a.service === 'string' && a.service.toLowerCase() === 'google'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    deny('signin-profile-registry-unavailable'); return;
  }
  const canonical = p => { try { return fs.realpathSync(p); } catch (error) { if (error.code !== 'ENOENT') throw error; return path.resolve(p); } };
  const protectedDirs = profiles.flatMap(p => [p.userDataDir, p.windowsUserDataDir]).filter(Boolean).map(p => canonical(p));
  const paths = [text];
  for (const match of text.matchAll(/(?:^|[\s"'=,([])(\/[^\s"',;)\]]+)/g)) paths.push(canonical(match[1]));
  if (profiles.some(p => (p.id && text.includes(p.id)) || ([p.userDataDir, p.windowsUserDataDir].filter(Boolean).some(dir => text.includes(dir) || text.includes(JSON.stringify(dir).slice(1, -1))))) || paths.some(p => protectedDirs.includes(p))) {
    deny('registered-signin-profile-automation-refused'); return;
  }
  if (!browser) return;
  // Browser tools often carry no profile. Check both MCP configuration locations.
  for (const file of ['.claude/settings.json', '.mcp.json']) {
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(project, file), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; deny('browser-config-unavailable'); return; }
    for (const [key, server] of Object.entries(config.mcpServers || {})) {
      if (!/playwright|browser|puppeteer|cdp/i.test(key)) continue;
      const args = server.args || [];
      let dir = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--user-data-dir') dir = args[i + 1];
        else if (typeof args[i] === 'string' && args[i].startsWith('--user-data-dir=')) dir = args[i].slice(16);
      }
      if ((dir && protectedDirs.includes(canonical(path.resolve(project, dir)))) || (!dir && profiles.some(p => p.userDataDir === null))) {
        deny('active-signin-profile-automation-refused'); return;
      }
    }
  }
})().catch(() => { process.stderr.write('Sign-in profile guard unavailable.\n'); process.exitCode = 2; });
`;
}
