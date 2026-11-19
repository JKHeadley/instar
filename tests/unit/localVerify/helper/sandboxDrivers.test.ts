// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the sandbox (docs/specs/local-verify-borrowed-unit-slices.md, B2) without running one. The
 * Lima template's walls (no mounts, every port ignored, no agent forwarding, fixed size), the host
 * config checks, each in-sandbox check with its pass / fail / unrunnable reading, the runner script's
 * per-process walls (no-network namespace with its own loopback, AF_VSOCK refused, builder egress by
 * uid, read-only tree and per-slice overlay, results not from the overlay, bounded clean-up), the
 * control-channel command lines (a recording runner; nothing executes), the host-disk margin,
 * the 4 MB result cap, the tree export and GitHub's merged check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../../../src/localVerify/helper/commandRunner.js';
import { LimaDriver, limaConfigChecks, renderLimaTemplate, buildProvisionBundle } from '../../../../src/localVerify/helper/limaDriver.js';
import { WslDriver, WSL_BASE_IMAGE, parseWslList, wslConfChecks } from '../../../../src/localVerify/helper/wslDriver.js';
import { NFT_COUNTER_SED, normalizeNftListing, readHelperTemplate } from '../../../../src/localVerify/helper/runnerDriverBase.js';
import { REQUIRED_CHECKS_COMMON, RESULT_BEGIN, RESULT_END, forwardProbeChecks, hostDiskOk, parseContainmentOutput, readCapped, unframeResult } from '../../../../src/localVerify/helper/sandboxDriver.js';
import { GitHubCompareChecker, buildTar, parseCatFileBatch, parseLsTree } from '../../../../src/localVerify/helper/hostTree.js';
import { extractTar } from '../../../../src/localVerify/helper/testBypassDriver.js';

function recorder(out: (cmd: string, args: string[]) => { code: number; stdout?: string } = () => ({ code: 0 })): CommandRunner & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return { calls, async run(cmd, args) { calls.push({ cmd, args }); const r = out(cmd, args); return { code: r.code, stdout: r.stdout ?? '', stderr: '' }; } };
}

describe('Lima template and config checks', () => {
  it('renders with no mounts, every guest port ignored, no agent forwarding, no containerd and the fixed size', () => {
    const cfg = yaml.load(renderLimaTemplate({ cpus: 8, memoryGb: 8, diskGb: 30 }, undefined, { url: 'https://x/img', digest: 'sha256:abc' })) as Record<string, any>;
    expect(cfg.mounts).toEqual([]);
    expect(cfg.portForwards[0]).toEqual({ guestPortRange: [1, 65535], ignore: true });
    expect(cfg.ssh.forwardAgent).toBe(false);
    expect(cfg.containerd).toEqual({ system: false, user: false });
    expect([cfg.cpus, cfg.memory, cfg.disk]).toEqual([8, '8GiB', '30GiB']);
    expect(cfg.images[0].digest).toBe('sha256:abc');
    expect(limaConfigChecks(renderLimaTemplate({ cpus: 8, memoryGb: 8, diskGb: 30 })).every((c) => c.result === 'pass')).toBe(true);
  });

  it('fails a host mount, an enabled forward or agent forwarding; unreadable config is unrunnable', () => {
    const base = renderLimaTemplate({ cpus: 2, memoryGb: 2, diskGb: 10 });
    expect(limaConfigChecks(base.replace('mounts: []', 'mounts:\n  - location: "~"'))[0]).toMatchObject({ name: 'config-no-mounts', result: 'fail' });
    expect(limaConfigChecks(base.replace('    ignore: true', '    ignore: false'))[1]).toMatchObject({ name: 'config-no-forwards', result: 'fail' });
    expect(limaConfigChecks(base.replace('forwardAgent: false', 'forwardAgent: true'))[1].result).toBe('fail');
    expect(limaConfigChecks(null).map((c) => c.result)).toEqual(['unrunnable', 'unrunnable']);
  });

  it('WSL: automount and interop off pass; either on fails', () => {
    expect(wslConfChecks(readHelperTemplate('wsl.conf'))[0].result).toBe('pass');
    expect(wslConfChecks(readHelperTemplate('wsl.conf').replace('[automount]\nenabled=false', '[automount]\nenabled=true'))[0].result).toBe('fail');
    expect(wslConfChecks(readHelperTemplate('wsl.conf').replace('[interop]\nenabled=false', '[interop]\nenabled=true'))[0].result).toBe('fail');
    expect(wslConfChecks(null)[0].result).toBe('unrunnable');
  });
});

describe('containment report', () => {
  const allPass = REQUIRED_CHECKS_COMMON.map((n) => `CHECK ${n} pass`).join('\n');
  it('ok only when every required check passed; a missing check is unrunnable; a fail names itself', () => {
    expect(parseContainmentOutput(allPass, REQUIRED_CHECKS_COMMON).ok).toBe(true);
    const missing = parseContainmentOutput(allPass.replace('CHECK vsock-refused pass', ''), REQUIRED_CHECKS_COMMON);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('vsock-refused:unrunnable:not reported');
    const failed = parseContainmentOutput(allPass.replace('CHECK builder-drop-counter-rises pass', 'CHECK builder-drop-counter-rises fail before=3 after=3'), REQUIRED_CHECKS_COMMON);
    expect(failed.reason).toBe('builder-drop-counter-rises:fail:before=3 after=3');
    expect(parseContainmentOutput(null, REQUIRED_CHECKS_COMMON).ok).toBe(false);
    // Host-side checks (positive controls, no-forward probes) merge in and can fail the report.
    expect(parseContainmentOutput(allPass, REQUIRED_CHECKS_COMMON, [{ name: 'no-forward-from-testns', result: 'fail' }]).ok).toBe(false);
  });

  it('the check script reports every required check name', () => {
    const script = readHelperTemplate('instar-helper-checks.sh');
    for (const n of REQUIRED_CHECKS_COMMON.filter((x) => !['config-no-mounts', 'config-no-forwards', 'probe-positive-controls', 'no-forward-from-testns', 'no-forward-from-guest-user'].includes(x))) {
      expect(script.includes(`check ${n} `) || script.includes(`check "${n}`) || script.includes(`"$u-${n.split('-').slice(1).join('-')}"`), n).toBe(true);
    }
  });
});

describe('runner script walls (static)', () => {
  const runner = readHelperTemplate('instar-helper-runner.sh');
  it('builds and slices in new network and mount namespaces with loopback up; only npm ci shares the network', () => {
    expect(runner.match(/unshare -m -n --propagation private/g)?.length).toBeGreaterThanOrEqual(2);
    expect(runner).toContain('ip link set lo up');
    const npmCi = runner.slice(runner.indexOf('  npm-ci)'), runner.indexOf('  build)'));
    expect(npmCi).toContain('unshare -m --propagation private');
    expect(npmCi).not.toContain('unshare -m -n');
    expect(npmCi).toContain('nft table hash mismatch');
    expect(npmCi.indexOf('kill_user builder')).toBeLessThan(npmCi.indexOf('npm ci --no-audit'));
  });
  it('refuses AF_VSOCK by seccomp for every unit, runs builder and tester without privileges', () => {
    expect(runner).toMatch(/RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK/);
    expect(runner).not.toMatch(/RestrictAddressFamilies=[^"]*AF_VSOCK/);
    expect(runner).toContain('NoNewPrivileges=yes');
    expect(runner).toMatch(/setpriv --reuid=\$TESTER_UID .*--no-new-privs/);
  });
  it('seals the tree read-only, gives each slice a fresh overlay it discards, and reads results from a root pipe', () => {
    expect(runner).toContain('find -P "$t" ! -type l -exec chmod a-w {} +');
    expect(runner).toContain('[ -L "$t/node_modules" ] && die');
    expect(runner).toContain('mount -t overlay overlay');
    expect(runner).toContain('rm -rf "$ov"');
    expect(runner).toContain(`echo "${RESULT_BEGIN} exit=$rc $summary"`);
    expect(runner).toContain(`echo "${RESULT_END}"`);
    expect(runner).toContain('> "$out"');
    expect(runner).toMatch(/out="\/srv\/results\/\$n\.json"/);
  });
  it('clean-up kills at most 3 times', () => {
    expect(runner).toMatch(/for i in 1 2 3; do\s+pkill -KILL -u "\$u"/);
  });
  it('builder egress rules match builder by uid and drop private ranges, tailnet and IPv6', () => {
    const nft = readHelperTemplate('builder-egress.nft');
    expect(nft).toContain('meta skuid != 61001 accept');
    expect(nft).toContain('100.64.0.0/10');
    expect(nft).toContain('meta nfproto ipv6 counter name builder_drop drop');
    expect(nft).toContain('tcp dport 443 counter name builder_allow accept');
    expect(nft).toContain('priority -10');
  });
  it('the provisioning bundle writes the runner, checks and rules, then provisions', () => {
    const b = buildProvisionBundle();
    expect(b).toContain("cat > '/usr/local/sbin/instar-helper-runner'");
    expect(b).toContain("cat > '/etc/instar-helper/builder-egress.nft'");
    expect(b.indexOf('provisioned')).toBeGreaterThan(b.indexOf('INSTAR_HELPER_EOF_2'));
  });
});

describe('second-pass fixes', () => {
  it('the nft hash strips counter values token by token, so a rule with an anonymous counter stays in the hashed text', () => {
    const runner = readHelperTemplate('instar-helper-runner.sh');
    expect(runner).toContain(`nft list table inet instar_helper 2>/dev/null | sed -E '${NFT_COUNTER_SED}' | sha256sum`);
    expect(runner).not.toMatch(/nft list table[^\n]*grep -v/);
    const base = 'table inet instar_helper {\n\tcounter builder_drop {\n\t\tpackets 3 bytes 180\n\t}\n\tchain output {\n\t\tmeta skuid != 61001 accept\n\t\tip daddr @blocked4 counter name builder_drop drop\n\t}\n}\n';
    const moreTraffic = base.replace('packets 3 bytes 180', 'packets 99 bytes 7000');
    expect(normalizeNftListing(moreTraffic)).toBe(normalizeNftListing(base));
    const injected = base.replace('\t\tmeta skuid != 61001 accept\n', '\t\tmeta skuid != 61001 accept\n\t\tmeta skuid 61001 counter packets 0 bytes 0 accept\n');
    expect(normalizeNftListing(injected)).not.toBe(normalizeNftListing(base));
    expect(normalizeNftListing(injected)).toContain('meta skuid 61001 counter  accept');
  });

  it('vsock-refused passes only on the specific refusal; a missing python3 fails it; provisioning installs python3', () => {
    const checks = readHelperTemplate('instar-helper-checks.sh');
    expect(checks).toContain('errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES');
    expect(checks).toContain('[ $r -eq 0 ]; check vsock-refused');
    expect(checks).not.toMatch(/\[ \$r -ne 0 \]; check vsock-refused/);
    expect(readHelperTemplate('provision-sandbox.sh')).toMatch(/apt-get install[^\n]*python3-minimal/);
  });

  it('no-forwarding probes need their positive control: a listener that never came up fails, even though unreachable', () => {
    const up = 'CHECK forward-listener-testns-up pass\nCHECK forward-listener-guest-up pass\n';
    expect(forwardProbeChecks(up, { fromTestNs: false, fromGuest: false }).map((c) => c.result)).toEqual(['pass', 'pass']);
    expect(forwardProbeChecks(up, { fromTestNs: true, fromGuest: false }).map((c) => c.result)).toEqual(['fail', 'pass']);
    const down = 'CHECK forward-listener-testns-up fail\n';
    expect(forwardProbeChecks(down, { fromTestNs: false, fromGuest: false }).map((c) => c.result)).toEqual(['fail', 'fail']);
    expect(REQUIRED_CHECKS_COMMON).toEqual(expect.arrayContaining(['forward-listener-testns-up', 'forward-listener-guest-up']));
    const checks = readHelperTemplate('instar-helper-checks.sh');
    expect(checks).toContain('console.log("LISTENER-UP")');
    expect(checks).toContain('check forward-listener-testns-up $?');
  });

  it('WSL: the base image is checked by digest before import; missing or mismatched digest refuses', async () => {
    expect(WSL_BASE_IMAGE.sha256).toBeNull();
    const mk = (want: string | null | undefined, got: string) => {
      const rec = recorder();
      return { rec, d: new WslDriver({ runner: rec, installDir: 'C:\\h', rootfsTar: 'C:\\r.tar', rootfsTarLocal: '/mnt/c/r.tar', ...(want !== undefined ? { rootfsSha256: want } : {}), hashFile: async () => got, signalFile: '/nonexistent' }) };
    };
    const size = { cpus: 2, memoryGb: 2, diskGb: 10 };
    const unpinned = mk(undefined, 'a'.repeat(64));
    await expect(unpinned.d.create(size)).rejects.toThrow('image-digest-unpinned');
    const wrong = mk('b'.repeat(64), 'a'.repeat(64));
    await expect(wrong.d.create(size)).rejects.toThrow('image-digest-mismatch');
    expect(wrong.rec.calls.some((c) => c.args.includes('--import'))).toBe(false);
    const ok = mk('a'.repeat(64), 'a'.repeat(64));
    await ok.d.create(size).catch(() => undefined);
    expect(ok.rec.calls[0].args.slice(0, 2)).toEqual(['--import', 'instar-helper']);
  });

  it('Lima config check also requires plain mode and no extra networks', () => {
    const base = renderLimaTemplate({ cpus: 2, memoryGb: 2, diskGb: 10 });
    expect(limaConfigChecks(base.replace('plain: true', 'plain: false'))[1].result).toBe('fail');
    expect(limaConfigChecks(base + '\nnetworks:\n  - lima: shared\n')[1].result).toBe('fail');
  });
});

describe('control-channel command lines (recording runner, nothing runs)', () => {
  it('Lima: every sandbox command goes through limactl shell … sudo -n to the runner, with LIMA_HOME under ~/.instar-helper', async () => {
    const rec = recorder((_c, a) => (a.includes('test') ? { code: 0, stdout: `${RESULT_BEGIN} exit=0 unhandled=0 start_ms=700\n{"testResults":[]}\n${RESULT_END}\n` } : { code: 0, stdout: 'survivors=0' }));
    const d = new LimaDriver({ runner: rec, limactl: '/agent/.instar/helper/lima/bin/limactl', helperHome: '/Users/x/.instar-helper' });
    const t = await d.execAsTester('0123456789abcdef', { files: ['tests/unit/a.test.ts'], workers: 3, signal: new AbortController().signal });
    expect(rec.calls[0].args).toEqual(['shell', '--workdir', '/', 'instar-helper', 'sudo', '-n', '/usr/local/sbin/instar-helper-runner', 'test', '0123456789abcdef', '3', '--', 'tests/unit/a.test.ts']);
    expect(t).toMatchObject({ exitCode: 0, vitestStartMs: 700, resultText: '{"testResults":[]}', rootDir: '/srv/slice/0123456789abcdef' });
    expect((await d.reap()).survivors).toBe(0);
    await expect(d.execAsTester('../etc', { files: [], workers: 1, signal: new AbortController().signal })).rejects.toThrow('invalid tree id');
    await d.stop();
    expect(rec.calls.at(-1)).toEqual({ cmd: '/agent/.instar/helper/lima/bin/limactl', args: ['stop', 'instar-helper'] });
  });

  it('WSL: stop is terminate (never --shutdown); uninstall unregisters only instar-helper and removes the owner-signal task', async () => {
    const rec = recorder();
    const d = new WslDriver({ runner: rec, installDir: 'C:\\h', rootfsTar: 'C:\\r.tar', rootfsTarLocal: '/mnt/c/r.tar', signalFile: '/nonexistent/signal.json' });
    await d.stop();
    await d.uninstall();
    const all = rec.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(all).toContain('wsl.exe --terminate instar-helper');
    expect(all).toContain('wsl.exe --unregister instar-helper');
    expect(all.some((x) => x.includes('--shutdown'))).toBe(false);
    expect(all.filter((x) => x.includes('--unregister')).every((x) => x.endsWith('--unregister instar-helper'))).toBe(true);
    expect(all).toContain('schtasks.exe /Delete /TN \\Instar\\OwnerSignal /F');
    expect(parseWslList('  NAME            STATE           VERSION\n* Ubuntu          Running         2\n  instar-helper   Stopped         2\n'.split('').join('\u0000'))).toEqual([{ name: 'Ubuntu', state: 'Running' }, { name: 'instar-helper', state: 'Stopped' }]);
  });
});

describe('limits and parsing', () => {
  it('host disk: free space must cover the sandbox disk\'s remaining growth plus 5 GB', () => {
    const G = 1024 ** 3;
    expect(hostDiskOk(34 * G, 30, 1 * G)).toBe(true);
    expect(hostDiskOk(34 * G - 1, 30, 1 * G)).toBe(false);
    expect(hostDiskOk(null, 30, 0)).toBe(false);
  });
  it('reads at most 4 MB and refuses the whole result past it (never truncates)', async () => {
    const big = Readable.from([Buffer.alloc(3 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024)]);
    expect(await readCapped(big)).toEqual({ oversize: { bytesSeen: 5 * 1024 * 1024 } });
    expect(await readCapped(Readable.from([Buffer.from('ok')]))).toEqual({ text: 'ok' });
  });
  it('unframes the runner result; a broken frame is null', () => {
    expect(unframeResult(`noise\n${RESULT_BEGIN} exit=1 unhandled=1 start_ms=null\n{"a":1}\n${RESULT_END}\n`)).toEqual({ exitCode: 1, unhandledErrors: 1, vitestStartMs: null, report: '{"a":1}' });
    expect(unframeResult(`${RESULT_BEGIN} garbage\n{}\n${RESULT_END}`)).toBeNull();
    expect(unframeResult('{}')).toBeNull();
  });
  it('exports a commit as a plain tar (no .git) that round-trips', () => {
    const tar = buildTar([{ path: 'a/b.txt', mode: '100644', data: Buffer.from('hello') }, { path: `${'d/'.repeat(60)}x.ts`, mode: '100755', data: Buffer.from('x') }]);
    expect(tar.length % 512).toBe(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtar-'));
    try {
      expect(extractTar(tar, dir)).toBe(2);
      expect(fs.readFileSync(path.join(dir, 'a/b.txt'), 'utf-8')).toBe('hello');
      expect(fs.readFileSync(path.join(dir, `${'d/'.repeat(60)}x.ts`), 'utf-8')).toBe('x');
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'sandboxDrivers.test.ts' }); }
    expect(parseLsTree(Buffer.from(`100644 blob ${'a'.repeat(40)}\ttests/unit/a.test.ts\u0000040000 tree ${'b'.repeat(40)}\tsrc\u0000`))).toEqual([{ mode: '100644', object: 'a'.repeat(40), path: 'tests/unit/a.test.ts' }]);
    const batch = parseCatFileBatch(Buffer.from(`${'a'.repeat(40)} blob 5\nhello\n${'b'.repeat(40)} blob 2\nhi\n`));
    expect(batch.get('a'.repeat(40))?.toString()).toBe('hello');
    expect(batch.get('b'.repeat(40))?.toString()).toBe('hi');
  });
  it('GitHub merged check: identical / behind is on main; ahead / diverged / 404 is not; anything else or no token is unknown', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const s = 'a'.repeat(40);
    expect(await new GitHubCompareChecker({ token: () => 't', fetchImpl: answer(200, { status: 'behind' }) }).isOnMain('o/r', s)).toBe(true);
    expect(await new GitHubCompareChecker({ token: () => 't', fetchImpl: answer(200, { status: 'identical' }) }).isOnMain('o/r', s)).toBe(true);
    expect(await new GitHubCompareChecker({ token: () => 't', fetchImpl: answer(200, { status: 'ahead' }) }).isOnMain('o/r', s)).toBe(false);
    expect(await new GitHubCompareChecker({ token: () => 't', fetchImpl: answer(404, {}) }).isOnMain('o/r', s)).toBe(false);
    expect(await new GitHubCompareChecker({ token: () => 't', fetchImpl: answer(500, {}) }).isOnMain('o/r', s)).toBeNull();
    expect(await new GitHubCompareChecker({ token: () => null, fetchImpl: answer(200, { status: 'behind' }) }).isOnMain('o/r', s)).toBeNull();
  });
});
