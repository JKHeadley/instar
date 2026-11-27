/**
 * SEC-171: playbook-hmac.py stored its HMAC key with `security add-generic-password ... -w <key>`, putting
 * the key in process arguments that `ps` shows to every account on the Mac. It now sends the command to
 * `security -i` on standard input (the SEC-155 approach), hex-encoded behind -X, with the 4096-byte line
 * guard. The real store_key runs here with subprocess.run replaced by a recorder (no keychain is touched).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'playbook-scripts', 'playbook-hmac.py');

function runPy(body: string): { status: number | null; stdout: string; stderr: string } {
  const harness = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ph", ${JSON.stringify(SCRIPT)})
ph = importlib.util.module_from_spec(spec); spec.loader.exec_module(ph)
calls = []
class R:
    def __init__(self, rc): self.returncode = rc; self.stdout = ""; self.stderr = "simulated"
def fake_run(cmd, **kw):
    calls.append({"cmd": cmd, "input": kw.get("input")})
    return R(FAKE_RC)
ph.subprocess.run = fake_run
${body}
print(json.dumps(calls))
`;
  const r = spawnSync('python3', ['-I', '-B', '-c', harness], { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const KEY = 'ab'.repeat(32); // a 32-byte key as hex, what generate_key() returns

describe('playbook-hmac.py store_key (SEC-171)', () => {
  it('sends the add on standard input to `security -i`; the key is never an argument', () => {
    const r = runPy(`FAKE_RC = 0\nph.store_key(${JSON.stringify(KEY)}, 3)`);
    expect(r.status, r.stderr).toBe(0);
    const calls = JSON.parse(r.stdout.trim().split('\n').pop()!) as Array<{ cmd: string[]; input: string | null }>;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toEqual(['/usr/bin/security', 'delete-generic-password', '-s', 'playbook-hmac', '-a', 'playbook-hmac-v3']);
    expect(calls[1]!.cmd).toEqual(['/usr/bin/security', '-i']);
    expect(calls[1]!.input).toBe(`add-generic-password -s "playbook-hmac" -a "playbook-hmac-v3" -X "${Buffer.from(KEY).toString('hex')}" -T ""\n`);
    for (const c of calls) expect(JSON.stringify(c.cmd)).not.toContain(KEY);
  });

  it('a failed write still fails the command', () => {
    const r = runPy(`FAKE_RC = 45\ntry:\n    ph.store_key(${JSON.stringify(KEY)}, 1)\nexcept SystemExit as e:\n    print("EXIT", e.code, file=sys.stderr)`);
    expect(r.stderr).toContain('Error storing key: simulated');
    expect(r.stderr).toContain('EXIT 1');
  });

  it('refuses a line too long for `security -i` to read whole, before running it', () => {
    const r = runPy(`FAKE_RC = 0\ntry:\n    ph.store_key("c" * 2100, 1)\nexcept SystemExit as e:\n    print("EXIT", e.code, file=sys.stderr)`);
    expect(r.stderr).toContain('key too long for a safe stdin write');
    expect(r.stderr).toContain('EXIT 1');
    const calls = JSON.parse(r.stdout.trim().split('\n').pop()!) as Array<{ cmd: string[] }>;
    expect(calls.map((c) => c.cmd[1])).toEqual(['delete-generic-password']); // no add was attempted
  });

  it('refuses a name that cannot be quoted safely', () => {
    const r = runPy(`FAKE_RC = 0\nfor bad in ['a"b', 'a\\\\b', 'a$b', 'a\`b', 'a\\nb', '']:\n    try:\n        ph._keychain_add_line("s", bad, "x")\n        print("ACCEPTED", repr(bad), file=sys.stderr)\n    except ValueError:\n        pass`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('ACCEPTED');
  });
});
