import { BODY_CARRYING_TELEGRAM_METHODS } from '../invisible-payload.js';
import { createHash } from 'node:crypto';

/** Cooperative tool boundary, not an OS sandbox. Edits/searches stay usable;
 * registered typed server operations hold the only supported write capability. */
const CLASSIFIER = String.raw`function classify(tool, input, methods, managedDirs) {
  const name = tool.toLowerCase();
  const shell = /(?:^|[._/])(bash|shell|exec_command|shell_command)$/.test(name);
  const orchestrator = /(?:^|[._/])functions[._/]exec$/.test(name);
  const browser = /(?:playwright|browser|chrome|cdp)/.test(name);
  const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
  if (orchestrator) {
    const source = typeof input === 'string' ? input : typeof input.code === 'string' ? input.code : '';
    // Inspect literal nested shell calls too. Native exec_command hooks remain
    // the authoritative boundary for dynamically constructed commands.
    for (const match of source.matchAll(/tools\.(?:exec_command|shell_command)\s*\(\s*\{\s*cmd\s*:\s*(["'])([\s\S]*?)\1/g)) {
      const reason = classify('exec_command', { cmd: match[2] }, methods, managedDirs);
      if (reason) return reason;
    }
  }
  let text = shell ? command : JSON.stringify(input);
  try { text = decodeURIComponent(text); } catch { /* Inspect the literal text if it is not URL encoded. */ }
  const normalized = name.replace(/[^a-z]/g, '');
  if (name.startsWith('mcp') && name.includes('telegram') &&
    (methods.some(method => normalized.endsWith(method.toLowerCase())) || /(?:send|edit|forward|copy|upload)$/.test(normalized))) return 'unrecorded-telegram-tool';
  if (browser && (/web\.telegram\.org/i.test(text) || /(?:appManagers|apiManager).*(?:invokeApi|sendMessage|editMessage)/s.test(text))) return 'telegram-browser-broker-required';
  if (shell) {
    const networkCommand = /(?:^|[;&|\n])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)|(?:\S*\/)?(?:env|command|exec)|--?)\s+)*(?:\S*\/)?(?:curl|wget|http|https|node|python[0-9.]*|ruby|perl|php)\b/.test(command);
    if (networkCommand && /api\.telegram\.org/i.test(text) && methods.some(method => new RegExp('\\b' + method + '\\b', 'i').test(text))) return 'recorded-telegram-relay-required';
    if (/--(?:user-data-dir|profile-directory|remote-debugging-(?:port|pipe))\b/.test(text) && /web\.telegram\.org/i.test(text)) return 'telegram-browser-broker-required';
  }
  if ((browser || shell && /(?:chromium|chrome|playwright|--user-data-dir|--remote-debugging)/i.test(text)) &&
    managedDirs.some(dir => text.includes(dir))) return 'managed-telegram-profile-private';
  return null;
}`;

export function originToolGuardHook(): string {
  const methods = [...BODY_CARRYING_TELEGRAM_METHODS].filter(method => !['createForumTopic', 'editForumTopic'].includes(method));
  return `#!/usr/bin/env node
// Instar Telegram origin tool guard. Generated from the shared method census.
(async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const classify = ${CLASSIFIER};
  let event;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const tool = String(event.tool_name || event.toolName || '');
  const input = event.tool_input || event.arguments || {};
  const project = process.env.INSTAR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let managed = [];
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(project, '.instar/state/playwright-profiles.json'), 'utf8'));
    managed = registry.profiles.filter(p => p.executionOwner === 'telegram-origin-broker' && p.userDataDir)
      .flatMap(p => [p.userDataDir, fs.existsSync(p.userDataDir) ? fs.realpathSync(p.userDataDir) : p.userDataDir]);
  } catch (error) {
    if (error.code !== 'ENOENT' && /playwright|browser|chrome|cdp/i.test(tool)) {
      process.stderr.write('Telegram profile ownership is unavailable; use the typed broker snapshot/send endpoints.\\n'); process.exitCode = 2; return;
    }
  }
  const reason = classify(tool, input, ${JSON.stringify(methods)}, managed);
  if (reason) {
    process.stderr.write('Telegram origin guard: ' + reason + '. Use telegram-reply.sh or the authenticated typed Telegram browser endpoint so origin is recorded before sending.\\n');
    process.exitCode = 2;
  }
  // Emit proof only when this current session can obtain an authenticated
  // challenge. The server still requires a native CLI hook-result record;
  // this HTTP response alone never marks enforcement ready.
  try {
    const token = process.env.INSTAR_ORIGIN_TOKEN;
    const nativeSessionId = event.session_id || event.sessionId;
    const toolUseId = event.tool_use_id || event.toolUseId;
    if (!token || typeof nativeSessionId !== 'string' || typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 512 || !tool ||
      (event.hook_event_name || event.hookEventName) !== 'PreToolUse') return;
    const config = JSON.parse(fs.readFileSync(path.join(project, '.instar/config.json'), 'utf8'));
    const port = Number(process.env.INSTAR_PORT || config.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !config.authToken) return;
    const crypto = await import('node:crypto'); const http = await import('node:http');
    const guardDigest = crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex');
    const body = JSON.stringify({ nativeSessionId, guardDigest });
    const challenge = await new Promise(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/telegram/origins/native-hook/challenge', method: 'POST',
        headers: { Authorization: 'Bearer ' + config.authToken, 'X-Instar-Origin-Session': token,
          'X-Instar-AgentId': config.projectName || '', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', part => { data += part; if (data.length > 2048) req.destroy(); });
        res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(data) : null); } catch { resolve(null); } });
        res.on('error', () => resolve(null));
      });
      const timer = setTimeout(() => { req.destroy(); resolve(null); }, 500);
      req.on('close', () => { clearTimeout(timer); resolve(null); }); req.on('error', () => resolve(null)); req.end(body);
    });
    if (challenge && challenge.guardDigest === guardDigest && challenge.nativeSessionId === nativeSessionId) {
      const marker = 'INSTAR_ORIGIN_HOOK_PROOF_V1:' + Buffer.from(JSON.stringify({ ...challenge,
        command: 'node ' + path.resolve(process.argv[1]), toolUseId, hookEvent: 'PreToolUse' })).toString('base64url');
      // Claude records stderr on native hook attachments. Codex records the
      // structured context with its native hooks.additional_context metadata.
      process.stderr.write(marker + '\\n');
      if (!reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: marker } }) + '\\n');
    }
  } catch { /* Missing proof holds activation; it does not obstruct unrelated tools. */ }
})().catch(() => { process.stderr.write('Telegram origin guard unavailable.\\n'); process.exitCode = 2; });
`;
}

export function originToolGuardDigest(): string { return createHash('sha256').update(originToolGuardHook()).digest('hex'); }
