// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Integration (Tier 2) — Real-Check Verification setup → state-file → hook-reader round-trip.
 * Spec: docs/specs/autonomous-completion-real-checks.md (§3, §9 "Integration").
 *
 * Two halves of one contract, exercised against the SHIPPED scripts (not copies):
 *
 *  1. setup-autonomous.sh --verification-command "<cmd>" --verification-cwd "<dir>"
 *     WRITES `verification_command:`, `verification_cwd:`, and `work_dir:` into the
 *     per-topic state file frontmatter (work_dir = the cwd setup ran in, captured
 *     structurally so the worktree-default build dir is correct — §3).
 *
 *  2. The hook's QUOTE-PRESERVING reader (fm_get_raw, the reason it exists) round-trips
 *     a verification_command CONTAINING LITERAL DOUBLE QUOTES intact — e.g.
 *     `grep -q "PASS" out.txt` survives the read unmangled. The legacy quote-STRIPPING
 *     fm_get reader (`tr -d '"'`) would mangle the same value; this test pins that
 *     fm_get_raw preserves the inner quotes while stripping only the YAML wrapping pair.
 *
 * Both scripts are real; no server is required (the setup script's can-start curl
 * degrades to a local file-count check when localhost is unreachable, then proceeds).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();
const SETUP = path.join(REPO, '.claude', 'skills', 'autonomous', 'scripts', 'setup-autonomous.sh');
const HOOK = path.join(REPO, '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const TOPIC = '7777';

let home: string;
// The script captures work_dir via `$(pwd)`, which resolves the macOS /var → /private/var
// symlink, so compare work_dir against the REALPATH of the temp home, not the raw mkdtemp path.
let homeReal: string;

function runSetup(args: string[]): { stdout: string; stderr: string } {
  // Run setup from inside the temp home so `work_dir: "$(pwd)"` captures `home`.
  const out = execFileSync('bash', [SETUP, ...args], {
    cwd: home,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sid-roundtrip-0001' },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: out, stderr: '' };
}

function statePath() { return path.join(home, '.instar', 'autonomous', `${TOPIC}.local.md`); }
function frontmatter(): string {
  // The frontmatter is the block between the first two `---` fences.
  const raw = fs.readFileSync(statePath(), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rc-setup-'));
  homeReal = fs.realpathSync(home);
  fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
  // Minimal config so the script's python3 port/authToken reads succeed; no server runs,
  // so the can-start curl is empty and the script falls back to the LOCAL file-count cap.
  fs.writeFileSync(path.join(home, '.instar', 'config.json'),
    JSON.stringify({ port: 59321, authToken: 'test-auth-token-value' }));
  // Seed an UNRELATED topic's state so the local-count fallback glob
  // (`ls .instar/autonomous/*.local.md`) matches at least one file — otherwise, with no
  // server up AND an empty dir, the glob is empty and `grep -c` exits non-zero under the
  // script's `set -euo pipefail`. One unrelated file (count 1 < cap 5) lets setup proceed.
  fs.mkdirSync(path.join(home, '.instar', 'autonomous'), { recursive: true });
  fs.writeFileSync(path.join(home, '.instar', 'autonomous', '1234.local.md'), '---\nactive: true\n---\n');
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('setup-autonomous.sh writes the real-check fields into per-topic state', () => {
  it('writes verification_command, verification_cwd, and work_dir into the frontmatter', () => {
    const cwdDir = path.join(home, 'worktree-build-dir');
    fs.mkdirSync(cwdDir, { recursive: true });

    runSetup([
      '--goal', 'ship the feature',
      '--duration', '1h',
      '--report-topic', TOPIC,
      '--completion-condition', 'all tests pass',
      '--verification-command', 'npm test',
      '--verification-cwd', cwdDir,
    ]);

    expect(fs.existsSync(statePath())).toBe(true);
    const fm = frontmatter();
    expect(fm).toContain('verification_command: "npm test"');
    expect(fm).toContain(`verification_cwd: "${cwdDir}"`);
    // work_dir is ALWAYS captured (= the directory setup ran in), structurally, so the
    // worktree-default build dir is correct even when --verification-cwd is omitted (§3).
    expect(fm).toContain(`work_dir: "${homeReal}"`);
  });

  it('omits verification_command/verification_cwd when the flags are absent (work_dir still captured)', () => {
    // Back-compat: a job that does not opt in is byte-identical to today EXCEPT work_dir,
    // which is always recorded so the CWD resolves structurally.
    runSetup([
      '--goal', 'no real check',
      '--duration', '1h',
      '--report-topic', TOPIC,
    ]);
    const fm = frontmatter();
    expect(fm).not.toContain('verification_command:');
    expect(fm).not.toContain('verification_cwd:');
    expect(fm).toContain(`work_dir: "${homeReal}"`);
  });
});

describe('the hook quote-preserving reader (fm_get_raw) round-trips a quoted command intact', () => {
  it('a verification_command containing literal double quotes survives the read unmangled', () => {
    // This is the WHOLE reason fm_get_raw exists: a command like `grep -q "PASS" out.txt`
    // must round-trip with its inner quotes intact. The quote-STRIPPING fm_get (`tr -d '"'`)
    // would turn it into `grep -q PASS out.txt` — a different (and possibly wrong) command.
    const quotedCmd = 'grep -q "PASS" out.txt';

    runSetup([
      '--goal', 'quoted command',
      '--duration', '1h',
      '--report-topic', TOPIC,
      '--verification-command', quotedCmd,
    ]);

    // Sanity: the raw state file preserved the inner quotes inside the YAML wrapper.
    const fm = frontmatter();
    expect(fm).toContain('verification_command: "grep -q "PASS" out.txt"');

    // Now exercise the SHIPPED hook reader directly. Source the hook's reader helpers
    // and call fm_get_raw / fm_get against the real state file's frontmatter, printing
    // each result so we can compare byte-for-byte. We extract the two reader functions
    // verbatim from the hook so this test pins the SHIPPED implementation, not a copy.
    const hookSrc = fs.readFileSync(HOOK, 'utf8');
    const grabFn = (name: string): string => {
      const m = hookSrc.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
      if (!m) throw new Error(`could not extract ${name} from the shipped hook`);
      return m[0];
    };
    const fmGet = grabFn('fm_get');
    const fmGetRaw = grabFn('fm_get_raw');

    const probe = `
set -uo pipefail
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "${statePath()}")
${fmGet}
${fmGetRaw}
# DELIM markers bound each value so trailing-newline differences can't blur the compare.
printf 'RAW<<%s>>\\n' "$(fm_get_raw verification_command)"
printf 'STRIP<<%s>>\\n' "$(fm_get verification_command)"
`;
    const out = execFileSync('bash', ['-c', probe], { encoding: 'utf-8' });
    const raw = out.match(/RAW<<([\s\S]*?)>>/)?.[1] ?? '';
    const strip = out.match(/STRIP<<([\s\S]*?)>>/)?.[1] ?? '';

    // fm_get_raw preserves the inner quotes verbatim (strips only the YAML wrapping pair).
    expect(raw).toBe('grep -q "PASS" out.txt');
    // The legacy fm_get mangles it (all quotes stripped) — proving fm_get_raw is required.
    expect(strip).toBe('grep -q PASS out.txt');
    expect(raw).not.toBe(strip);
  });

  it('verification_cwd and work_dir also round-trip through fm_get_raw', () => {
    const cwdDir = path.join(home, 'build dir with space');
    fs.mkdirSync(cwdDir, { recursive: true });
    runSetup([
      '--goal', 'cwd round-trip',
      '--duration', '1h',
      '--report-topic', TOPIC,
      '--verification-command', 'true',
      '--verification-cwd', cwdDir,
    ]);

    const hookSrc = fs.readFileSync(HOOK, 'utf8');
    const fmGetRaw = hookSrc.match(/^fm_get_raw\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(fmGetRaw).not.toBe('');

    const probe = `
set -uo pipefail
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "${statePath()}")
${fmGetRaw}
printf 'CWD<<%s>>\\n' "$(fm_get_raw verification_cwd)"
printf 'WORK<<%s>>\\n' "$(fm_get_raw work_dir)"
`;
    const out = execFileSync('bash', ['-c', probe], { encoding: 'utf-8' });
    expect(out.match(/CWD<<([\s\S]*?)>>/)?.[1]).toBe(cwdDir);
    expect(out.match(/WORK<<([\s\S]*?)>>/)?.[1]).toBe(homeReal);
  });
});
