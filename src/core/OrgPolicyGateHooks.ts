/**
 * The organization never rules check hook (docs/specs/org-never-actions.md §A–C), as file text for
 * migrateHooks. The wrapper costs a non-joined agent one file test; the script asks the server and
 * always decides within its own 9 s deadline (registered with a 12 s hook timeout).
 */
export const OrgPolicyGateHooks = {
  wrapper(): string {
    return `#!/bin/bash
# Organization never rules check (instar spec org-never-actions). Exits at once for an agent with no
# organization data; otherwise the server decides (it doesn't trust an edited membership file).
D="\${CLAUDE_PROJECT_DIR:-.}/.instar"
[ -d "$D/org" ] || grep -q '"block"' "$D/config.json" 2>/dev/null || exit 0
exec node "\${CLAUDE_PROJECT_DIR:-.}/.instar/hooks/instar/org-policy-gate.js"
`;
  },

  script(): string {
    return `#!/usr/bin/env node
// Organization never rules check (instar spec org-never-actions). PreToolUse hook for Bash and MCP tools
// of an agent that joined an organization. Observe: a note, never "allow". Block: deny with the reason.
const started = Date.now();
const DEADLINE = started + 9000;
let data = '';
process.stdin.on('data', (c) => data += c);
process.stdin.on('end', async () => {
  const nodeFs = await import('node:fs');
  const dir = process.env.CLAUDE_PROJECT_DIR || '.';
  const out = (o) => { process.stdout.write(JSON.stringify({ hookSpecificOutput: Object.assign({ hookEventName: 'PreToolUse' }, o) }), () => process.exit(0)); };
  const note = (why) => { try { nodeFs.appendFileSync(dir + '/.instar/org/action-checks.jsonl', JSON.stringify({ at: new Date().toISOString(), outcome: 'hook-failed', reason: why }) + '\\n'); } catch {} };
  // Never fail open in block mode (EXO 3.0): an unreadable config or input is a hold, and is recorded either way.
  let port = 4040; let auth = process.env.INSTAR_AUTH_TOKEN || ''; let block = false; let cfgOk = true;
  try {
    const cfg = JSON.parse(nodeFs.readFileSync(dir + '/.instar/config.json', 'utf-8'));
    port = cfg.port || 4040;
    if (!auth && typeof cfg.authToken === 'string') auth = cfg.authToken;
    const a = (cfg.orgPolicy && cfg.orgPolicy.actions) || {};
    block = a.mode === 'block' && a.blockingApproved === true;
  } catch { cfgOk = false; }
  // The server's own record of the mode decides; a config edited to observe can't switch the hook off.
  try { const mf = JSON.parse(nodeFs.readFileSync(dir + '/.instar/org/actions-mode.json', 'utf-8')); if (mf && mf.mode === 'block') block = true; } catch {}
  let input = null;
  try { input = JSON.parse(data); } catch { input = null; }
  if (!input) {
    note('hook input unreadable');
    // Block mode (or a mode we couldn't read) holds an action it can't read; observe adds a note.
    if (block || !cfgOk) return out({ permissionDecision: 'deny', permissionDecisionReason: "I couldn't read this action to check it against your organization's policy. Try again, or ask your person." });
    return out({ additionalContext: "Your organization's policy check couldn't read this action. If it might break a rule, ask your person first." });
  }
  if (!cfgOk) note('config unreadable; asking the server on the default port');
  // In block mode the agent may not change what the check reads: its organization files and config
  // (EXO 3.0 re-audit). Only the person, through the app and the server, changes these.
  if (block) {
    const ti0 = input.tool_input || {};
    // Real paths, so ./, //, .. and symlinks can't hide the target.
    const nodePath = await import('node:path');
    const real = (p) => { let cur = nodePath.resolve(input.cwd || dir, p); const tail = []; while (cur !== nodePath.dirname(cur)) { try { return nodePath.join(nodeFs.realpathSync(cur), ...tail.reverse()); } catch { tail.push(nodePath.basename(cur)); cur = nodePath.dirname(cur); } } return nodePath.resolve(input.cwd || dir, p); };
    let instarReal = dir + '/.instar'; try { instarReal = nodeFs.realpathSync(dir + '/.instar'); } catch {}
    const guarded = (p) => { if (typeof p !== 'string') return false; const r = real(p); return r === instarReal + '/config.json' || r === instarReal + '/org' || r.startsWith(instarReal + '/org/'); };
    const writesGuarded = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(input.tool_name || '') && (guarded(ti0.file_path) || guarded(ti0.notebook_path));
    // Shell commands: the paths in full, or the bare names when the command or its directory reaches .instar.
    const cmd = typeof ti0.command === 'string' ? ti0.command : '';
    const cwdReal = (() => { try { return nodeFs.realpathSync(input.cwd || dir); } catch { return input.cwd || dir; } })();
    const nearInstar = cmd.includes('.instar') || cwdReal === instarReal || cwdReal.startsWith(instarReal + '/');
    const bareName = /(^|[\\s'"\\/=;&|(<>])(config\\.json|org)([\\s'"\\/;&|)<>]|$)/.test(cmd);
    // Fail closed: a command that touches these files is allowed only when every part of it is a known
    // read-only tool and nothing is redirected into a file (EXO 3.0 re-audit round 7: no list of writers is complete).
    // Only tools with no way to write a file (sort -o, uniq, xxd -r, base64 -o and rg --pre can, so they are out).
    const READ_ONLY = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'jq', 'ls', 'stat', 'wc', 'diff', 'file', 'test', '[', 'echo', 'printf', 'cd', 'pwd', 'cut', 'tr', 'od', 'shasum', 'md5', 'true', 'nl']);
    const cleaned = cmd.replace(/[0-9]?>&[0-9]/g, '').replace(/[0-9]?>\\s*\\/dev\\/null/g, '');
    const redirectsToFile = cleaned.includes('>');
    const segments = cleaned.split(/[;&|\\n]+/).map((x) => x.trim()).filter(Boolean);
    // No NAME=value prefixes: PATH= or a loader variable could pick a different program.
    const firstWord = (seg) => seg.split(/\\s+/)[0] || '';
    const canWrite = redirectsToFile || cmd.includes(String.fromCharCode(96)) || cmd.includes('$(') || cmd.includes('<(') || cmd.includes('>(') || segments.some((seg) => !READ_ONLY.has(firstWord(seg)));
    // A command run from inside the organization folder touches its files whatever it names.
    const insideOrg = cwdReal === instarReal + '/org' || cwdReal.startsWith(instarReal + '/org/');
    // A wildcard or a variable can hide the guarded name, so near .instar either counts as touching it.
    const hidesName = ['*', '?', '[', '$'].some((c) => cmd.includes(c));
    const bashTouches = input.tool_name === 'Bash' && canWrite && (insideOrg || (nearInstar && hidesName) || cmd.includes('.instar/org') || cmd.includes('.instar/config.json') || (nearInstar && bareName));
    if (writesGuarded || bashTouches) {
      note('guarded org file write refused');
      return out({ permissionDecision: 'deny', permissionDecisionReason: "While your organization's rules are enforced, I can't run commands that could change its policy files or this agent's settings. Reading them is fine. Your person can manage the organization in the Instar app." });
    }
  }
  const ti = input.tool_input || {};
  const body = JSON.stringify({
    sessionId: input.session_id || '', toolName: input.tool_name || '', toolInput: ti,
    command: typeof ti.command === 'string' ? ti.command : undefined, cwd: input.cwd || dir,
    transcriptPath: input.transcript_path || '', deadlineMs: Math.max(0, DEADLINE - Date.now() - 300),
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(0, DEADLINE - Date.now()));
  let r = null;
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/org/check-action', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body, signal: ctl.signal });
    if (res.ok) r = await res.json();
  } catch { r = null; }
  clearTimeout(timer);
  if (!r) {
    note('server did not answer');
    // Block mode, or a mode we couldn't read: hold rather than let it through (EXO 3.0 never fail open).
    if (block || !cfgOk) return out({ permissionDecision: 'deny', permissionDecisionReason: "I couldn't check this against your organization's policy right now. Try again in a moment, or ask your person." });
    return out({ additionalContext: "Your organization's policy check didn't answer for this action. If it might break a rule, ask your person first." });
  }
  if (r.decision === 'deny') return out({ permissionDecision: 'deny', permissionDecisionReason: String(r.reason || 'Blocked by your organization policy.') });
  if (r.note) return out({ additionalContext: String(r.note) });
  process.exit(0);
});
`;
  },
};
