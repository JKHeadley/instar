/**
 * Unit tests for the watchdog's macOS-26 TCC-spawn-blocked classifier + the
 * machine-level escalation spool append (Scope B). Spec:
 * docs/specs/macos26-launchd-tcc-runtime-relocation.md.
 *
 * Template-content checks run cross-platform (just grep the script). The
 * behavioral tests source the script in LIB_ONLY mode and exercise the bash
 * functions against synthetic plists + a fake $HOME for the spool — darwin-gated
 * because the source-trick under strict-set-e is flakier on Linux CI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const WATCHDOG_PATH = path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'instar-watchdog.sh');
const itDarwin = process.platform === 'darwin' ? it : it.skip;

function readScript(): string {
  return fs.readFileSync(WATCHDOG_PATH, 'utf-8');
}

describe('watchdog template — TCC classifier + spool (content checks)', () => {
  const body = readScript();

  it('defines the four helpers + the classifier', () => {
    expect(body).toContain('get_program_argv0()');
    expect(body).toContain('is_tcc_protected_path()');
    expect(body).toContain('episode_first_detected_down()');
    expect(body).toContain('spool_append()');
    expect(body).toContain('classify_and_spool_tcc_blocked()');
  });

  it('exit-78 classifier is the PRIMARY deterministic signal (no log show required)', () => {
    // The classifier short-circuits unless exit_status=="78".
    expect(body).toMatch(/classify_and_spool_tcc_blocked[\s\S]+?exit_status[^\n]*!=[^\n]*"78"[^\n]*return 1/);
    // No actual `log show` INVOCATION inside the classifier (a comment
    // mentioning it for context is fine — the executable code must not call it).
    const classifierBlock = body.split('classify_and_spool_tcc_blocked()')[1]?.split(/^}/m)[0] ?? '';
    // Strip shell comments before checking — `# ... log show ...` is allowed.
    const noComments = classifierBlock.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(noComments).not.toMatch(/\blog show\b/);
  });

  it('TCC-protected folder check covers Documents/Desktop/Downloads/iCloud (NEW-M4)', () => {
    expect(body).toMatch(/\$HOME\/Documents/);
    expect(body).toMatch(/\$HOME\/Desktop/);
    expect(body).toMatch(/\$HOME\/Downloads/);
    expect(body).toMatch(/com~apple~CloudDocs/);
  });

  it('spool + episode dir live in ~/.instar/ (outside any TCC folder)', () => {
    // INSTAR_MACHINE_DIR is the ~/.instar root the spool + episode dir hang off.
    expect(body).toContain('INSTAR_MACHINE_DIR="$HOME/.instar"');
    expect(body).toContain('ESCALATION_SPOOL="$INSTAR_MACHINE_DIR/watchdog-escalations.jsonl"');
    expect(body).toContain('EPISODE_DIR="$INSTAR_MACHINE_DIR/escalation-episodes"');
  });

  it('classifier is wired BEFORE generic self-heal in the crash-loop branch', () => {
    // The crash-loop branch must call the classifier first; on match it
    // `continue`s, skipping the generic self-heal that can't fix TCC.
    const crashLoopBlock = body.split('CRASH-LOOP: $label (exit $exit_status')[1] ?? '';
    const tccIdx = crashLoopBlock.indexOf('classify_and_spool_tcc_blocked');
    const healIdx = crashLoopBlock.indexOf('should_attempt_heal');
    expect(tccIdx).toBeGreaterThan(-1);
    expect(healIdx).toBeGreaterThan(-1);
    expect(tccIdx).toBeLessThan(healIdx);
    // And it `continue`s on match so heal does NOT run.
    expect(body).toMatch(/classify_and_spool_tcc_blocked[^\n]+then[\s\S]+?continue/);
  });

  it('LIB_ONLY gate lets tests source the helpers without running the main loop', () => {
    expect(body).toMatch(/INSTAR_WATCHDOG_LIB_ONLY/);
  });

  it('defines resolve_state_dir_for_plist + the three runtime-root consumers use it (NEW-H1 fix)', () => {
    expect(body).toContain('resolve_state_dir_for_plist()');
    // try_self_heal: takes optional plist + resolves through the helper.
    expect(body).toMatch(/try_self_heal\(\)[\s\S]+?resolve_state_dir_for_plist/);
    // probe_server_identity: same.
    expect(body).toMatch(/probe_server_identity\(\)[\s\S]+?resolve_state_dir_for_plist/);
    // check_stale_lifeline_signal: same.
    expect(body).toMatch(/check_stale_lifeline_signal\(\)[\s\S]+?resolve_state_dir_for_plist/);
    // The three call sites in the main loop pass the plist through.
    expect(body).toMatch(/try_self_heal "\$project_dir" "\$label" "\$plist"/);
    expect(body).toMatch(/probe_server_identity "\$project_dir" "\$label" "\$plist"/);
  });

  it('defines try_direct_telegram_send + the classifier wires it after spool_append', () => {
    expect(body).toContain('try_direct_telegram_send()');
    // Must use `curl -K -` so the URL (containing the token) is piped via stdin
    // — NOT in curl's argv (which is visible via `ps`).
    expect(body).toMatch(/curl -K -/);
    // Defensive: there must be NO `curl` invocation that interpolates the token
    // anywhere in argv. The only token reference inside try_direct_telegram_send
    // is inside `printf` (a bash BUILTIN, so no process-argv exposure) that
    // pipes into `curl -K -`.
    const sendBlock = body.split('try_direct_telegram_send()')[1]?.split(/^}/m)[0] ?? '';
    // No `curl ... $token`, `curl ... "$token"`, `curl ... ${token}` in argv.
    expect(sendBlock).not.toMatch(/\bcurl\b[^\n|]*\$\{?token\}?/);
    expect(sendBlock).not.toMatch(/\bcurl\b[^\n|]*"\$token"/);
    // Classifier wires the send call after a successful spool_append.
    expect(body).toMatch(/spool_append[\s\S]+?try_direct_telegram_send/);
  });

  it('escalation entry shape matches what EscalationSpool.ts expects', () => {
    // Same field names + types — drainers in TS read this directly.
    expect(body).toContain('"label":"%s"');
    expect(body).toContain('"projectDir":"%s"');
    expect(body).toContain('"cause":"%s"');
    expect(body).toContain('"firstDetectedDown":%s');
    expect(body).toContain('"remediation":"%s"');
    expect(body).toContain('"ts":"%s"');
  });
});

describe('watchdog — TCC classifier behavioral (darwin-gated)', () => {
  let fakeHome: string;
  let launchAgentsDir: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-wdtcc-'));
    launchAgentsDir = path.join(fakeHome, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    // Make the fake $HOME look like a real user home so the TCC-path check works.
    fs.mkdirSync(path.join(fakeHome, 'Documents', 'Projects', 'b2lead', '.instar', 'bin'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* */ }
  });

  function writePlist(label: string, argv0: string): string {
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${argv0}</string>
    <string>--dummy</string>
  </array>
  <key>WorkingDirectory</key><string>/</string>
</dict>
</plist>`;
    fs.writeFileSync(plistPath, xml);
    return plistPath;
  }

  function runClassifier(label: string, plistPath: string, exitStatus: string): { rc: number; stdout: string; stderr: string; spool: string } {
    // The watchdog script enables `set -euo pipefail` on source; without
    // disabling it AFTER sourcing, a function return code of 1 (the negative
    // tests' expected outcome) would terminate the shell before our RC echo.
    const script = `
export HOME='${fakeHome}'
export INSTAR_WATCHDOG_LIB_ONLY=1
export INSTAR_WATCHDOG_LOG_FILE='${fakeHome}/wd.log'
source '${WATCHDOG_PATH}'
set +eu
classify_and_spool_tcc_blocked '${label}' '${plistPath}' '${exitStatus}'
echo "RC=$?"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    const rcMatch = r.stdout.match(/RC=(\d+)/);
    const rc = rcMatch ? parseInt(rcMatch[1], 10) : -1;
    const spool = path.join(fakeHome, '.instar', 'watchdog-escalations.jsonl');
    return {
      rc,
      stdout: r.stdout,
      stderr: r.stderr,
      spool: fs.existsSync(spool) ? fs.readFileSync(spool, 'utf-8') : '',
    };
  }

  itDarwin('classifies + spools a TCC-blocked agent (exit 78 + argv0 under ~/Documents)', () => {
    const label = 'ai.instar.b2lead';
    const plist = writePlist(label, `${fakeHome}/Documents/Projects/b2lead/.instar/bin/node`);
    const r = runClassifier(label, plist, '78');
    expect(r.rc).toBe(0); // classified — caller should skip generic heal
    expect(r.spool).toContain(`"label":"${label}"`);
    expect(r.spool).toContain('"cause":"tcc-spawn-blocked"');
    expect(r.spool).toContain('"projectDir"');
    expect(r.spool).toMatch(/"firstDetectedDown":\d+/);
  });

  itDarwin('does NOT classify when exit is non-78 (falls through to generic heal)', () => {
    const label = 'ai.instar.other';
    const plist = writePlist(label, `${fakeHome}/Documents/Projects/other/.instar/bin/node`);
    const r = runClassifier(label, plist, '1');
    expect(r.rc).toBe(1); // unmatched — caller falls through
    expect(r.spool).toBe(''); // nothing spooled
  });

  itDarwin('does NOT classify when argv0 is outside any TCC folder (e.g. agent-home)', () => {
    const label = 'ai.instar.echo';
    fs.mkdirSync(path.join(fakeHome, '.instar', 'agents', 'echo', '.instar', 'bin'), { recursive: true });
    const plist = writePlist(label, `${fakeHome}/.instar/agents/echo/.instar/bin/node`);
    const r = runClassifier(label, plist, '78');
    expect(r.rc).toBe(1); // not a TCC path — unmatched
    expect(r.spool).toBe('');
  });

  itDarwin('try_direct_telegram_send invokes curl -K - and proves the token never lands in any process argv', () => {
    const label = 'ai.instar.b2lead';
    // Pre-arm the per-agent credential.
    const credDir = path.join(fakeHome, '.instar', 'registry');
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
    const VALID_TOKEN = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';
    fs.writeFileSync(
      path.join(credDir, `${label}.json`),
      JSON.stringify({ ownerTopicId: 5447, botToken: VALID_TOKEN }),
      { mode: 0o600 },
    );

    // Mock curl: record argv + stdin, exit 0 with "200" stdout (Telegram OK).
    const shimDir = path.join(fakeHome, 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    const argvLog = path.join(fakeHome, 'curl-argv.log');
    const stdinLog = path.join(fakeHome, 'curl-stdin.log');
    fs.writeFileSync(
      path.join(shimDir, 'curl'),
      `#!/bin/bash\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; done\ncat > "${stdinLog}"\nprintf '200'\n`,
      { mode: 0o755 },
    );

    const script = `
export PATH='${shimDir}:'$PATH
export HOME='${fakeHome}'
export INSTAR_WATCHDOG_LIB_ONLY=1
export INSTAR_WATCHDOG_LOG_FILE='${fakeHome}/wd.log'
source '${WATCHDOG_PATH}'
set +eu
try_direct_telegram_send '${label}' 'b2lead is down — run instar relocate'
echo "RC=$?"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.stdout).toMatch(/RC=0/);

    const argv = fs.readFileSync(argvLog, 'utf-8');
    const stdinReceived = fs.readFileSync(stdinLog, 'utf-8');

    // The curl shim was invoked with `-K -` so the URL/token came via stdin.
    expect(argv).toContain('-K');
    // THE security-critical assertion: the bot token must NEVER appear in any
    // argument curl received on its argv. It belongs in stdin only.
    expect(argv).not.toContain(VALID_TOKEN);
    // It SHOULD appear in stdin (inside the curl config the watchdog piped in).
    expect(stdinReceived).toContain(VALID_TOKEN);
    expect(stdinReceived).toContain('chat_id=5447');
  });

  itDarwin('try_direct_telegram_send returns failure when no credential is present (unarmed agent)', () => {
    const label = 'ai.instar.unarmed';
    // No credential file written.
    const script = `
export HOME='${fakeHome}'
export INSTAR_WATCHDOG_LIB_ONLY=1
export INSTAR_WATCHDOG_LOG_FILE='${fakeHome}/wd.log'
source '${WATCHDOG_PATH}'
set +eu
try_direct_telegram_send '${label}' 'page text'
echo "RC=$?"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.stdout).toMatch(/RC=1/);
  });

  itDarwin('resolve_state_dir_for_plist returns the absolute --runtime-root from the plist (no Documents traversal)', () => {
    const label = 'ai.instar.relocated';
    const runtimeRoot = `${fakeHome}/Library/Application Support/instar/relocated-abc12345`;
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    fs.writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${runtimeRoot}/bin/node</string>
    <string>${runtimeRoot}/instar-boot.cjs</string>
    <string>lifeline</string><string>start</string>
    <string>--dir</string><string>${fakeHome}/Documents/Projects/relocated</string>
    <string>--runtime-root</string><string>${runtimeRoot}</string>
  </array>
</dict></plist>`,
    );
    const script = `
export HOME='${fakeHome}'
export INSTAR_WATCHDOG_LIB_ONLY=1
source '${WATCHDOG_PATH}'
set +eu
resolve_state_dir_for_plist '${plistPath}' '${fakeHome}/Documents/Projects/relocated'
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.stdout.trim()).toBe(runtimeRoot);
    // CRITICAL: returns the Library path, never the Documents `.instar` path.
    expect(r.stdout).not.toContain('/Documents/');
  });

  itDarwin('resolve_state_dir_for_plist falls back to $project_dir/.instar for unrelocated agents (no --runtime-root arg)', () => {
    const label = 'ai.instar.unrelocated';
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    fs.writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/node</string>
    <string>${fakeHome}/Documents/Projects/unrelocated/.instar/instar-boot.cjs</string>
    <string>lifeline</string><string>start</string>
  </array>
</dict></plist>`,
    );
    const script = `
export HOME='${fakeHome}'
export INSTAR_WATCHDOG_LIB_ONLY=1
source '${WATCHDOG_PATH}'
set +eu
resolve_state_dir_for_plist '${plistPath}' '${fakeHome}/Documents/Projects/unrelocated'
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    expect(r.stdout.trim()).toBe(`${fakeHome}/Documents/Projects/unrelocated/.instar`);
  });

  itDarwin('dedups one-shot per episode (same label + firstDetectedDown → no second entry)', () => {
    const label = 'ai.instar.b2lead';
    const plist = writePlist(label, `${fakeHome}/Documents/Projects/b2lead/.instar/bin/node`);
    runClassifier(label, plist, '78');
    const r2 = runClassifier(label, plist, '78');
    expect(r2.rc).toBe(0); // still classified
    const lines = r2.spool.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1); // dedup held — only one spool entry across two ticks
  });
});
