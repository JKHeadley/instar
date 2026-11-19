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
import { LimaDriver, limaConfigChecks, limaDiskListed, renderLimaTemplate, buildProvisionBundle } from '../../../../src/localVerify/helper/limaDriver.js';
import { WslDriver, WSL_BASE_IMAGE, parseWslList, wslConfChecks } from '../../../../src/localVerify/helper/wslDriver.js';
import { NFT_COUNTER_SED, PACKAGE_VOLUME, PACKAGE_VOLUME_CAP_BYTES, PROGRESS_REPORTER_PATH, isTailnetAddress, lanAddress, normalizeNftListing, packageVolumeConf, readHelperTemplate, sandboxSettingsHash, tailnetAddress } from '../../../../src/localVerify/helper/runnerDriverBase.js';
import {
  LANE_VITEST_CONFIG, PKG_VOLUME_MISSING_EXIT, PROGRESS_PREFIX, REQUIRED_CHECKS_COMMON, REQUIRED_CHECKS_WSL, RESULT_BEGIN, RESULT_END, SANDBOX_PROPERTY_CHECKS,
  forwardProbeChecks, hostDiskOk, pairedRouteChecks, parseContainmentOutput, parseProgressLine, readCapped, unframeResult, type TesterProgress,
} from '../../../../src/localVerify/helper/sandboxDriver.js';
import { readLinesCapped } from '../../../../src/localVerify/helper/commandRunner.js';
import { LANES } from '../../../../src/localVerify/inventory.js';
import { HELPER_LIMITS } from '../../../../src/localVerify/helper/helperProtocol.js';
import { GitHubCompareChecker, buildTar, parseCatFileBatch, parseLsTree } from '../../../../src/localVerify/helper/hostTree.js';
import { extractTar } from '../../../../src/localVerify/helper/testBypassDriver.js';

/**
 * A recording runner: nothing executes. It keeps each command line and, beside it, the environment
 * the command was given; like the real runner it offers each stdout line to `onStdoutLine` and
 * keeps only the lines that were not consumed.
 */
function recorder(out: (cmd: string, args: string[]) => { code: number; stdout?: string } = () => ({ code: 0 })): CommandRunner & { calls: Array<{ cmd: string; args: string[] }>; envs: Array<NodeJS.ProcessEnv | undefined> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  return {
    calls, envs,
    async run(cmd, args, opts) {
      calls.push({ cmd, args });
      envs.push(opts?.env);
      const r = out(cmd, args);
      let stdout = r.stdout ?? '';
      if (opts?.onStdoutLine) stdout = stdout.split('\n').filter((line) => !opts.onStdoutLine!(line)).join('\n');
      return { code: r.code, stdout, stderr: '' };
    },
  };
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
    // The sandbox property test's per-user checks are printed by one loop (`check "$1-$f"`): see sandboxProperty.test.ts.
    const perUserProperty = SANDBOX_PROPERTY_CHECKS.filter((x) => x.startsWith('tester-') || x.startsWith('builder-'));
    for (const n of REQUIRED_CHECKS_COMMON.filter((x) => !['config-no-mounts', 'config-no-forwards', 'probe-positive-controls', 'no-forward-from-testns', 'no-forward-from-guest-user', ...perUserProperty].includes(x))) {
      expect(script.includes(`check ${n} `) || script.includes(`check "${n}`) || script.includes(`"$u-${n.split('-').slice(1).join('-')}"`), n).toBe(true);
    }
    expect(script).toContain('check "$1-$f"');
    // The fixed-address tailnet probe of the first design is gone from the test-namespace checks: the paired listener test replaces it.
    expect(REQUIRED_CHECKS_COMMON).not.toContain('testns-no-route-tailnet');
    expect(script).not.toContain('check testns-no-route-tailnet $?');
    expect(REQUIRED_CHECKS_WSL).toEqual(expect.arrayContaining([...REQUIRED_CHECKS_COMMON]));
  });
});

describe('runner script walls (static)', () => {
  const runner = readHelperTemplate('instar-helper-runner.sh');
  it('builds and slices in new network and mount namespaces with loopback up; only npm ci shares the network', () => {
    expect(runner.match(/unshare -m -n --propagation private/g)?.length).toBeGreaterThanOrEqual(2);
    expect(runner).toContain('ip link set lo up');
    const npmCi = runner.slice(runner.indexOf('  install)'), runner.indexOf('  place)'));
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
      return { rec, d: new WslDriver({ runner: rec, installDir: 'C:\\h', rootfsTar: 'C:\\r.tar', rootfsTarLocal: '/mnt/c/r.tar', pkgVhd: 'C:\\h\\pkg.vhdx', ...(want !== undefined ? { rootfsSha256: want } : {}), hashFile: async () => got, signalFile: '/nonexistent' }) };
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
    const t = await d.execAsTester('0123456789abcdef', { lane: 'unit', files: ['tests/unit/a.test.ts'], workers: 3, signal: new AbortController().signal });
    expect(rec.calls[0].args).toEqual(['shell', '--workdir', '/', 'instar-helper', 'sudo', '-n', '/usr/local/sbin/instar-helper-runner', 'test', '0123456789abcdef', 'unit', '3', '--', 'tests/unit/a.test.ts']);
    expect(t).toMatchObject({ exitCode: 0, vitestStartMs: 700, resultText: '{"testResults":[]}', rootDir: '/srv/slice/0123456789abcdef' });
    expect((await d.reap()).survivors).toBe(0);
    await expect(d.execAsTester('../etc', { lane: 'unit', files: [], workers: 1, signal: new AbortController().signal })).rejects.toThrow('invalid tree id');
    await d.stop();
    expect(rec.calls.at(-1)).toEqual({ cmd: '/agent/.instar/helper/lima/bin/limactl', args: ['stop', 'instar-helper'] });
  });

  it('WSL: stop is terminate (never --shutdown); uninstall unregisters only instar-helper and removes the owner-signal task', async () => {
    const rec = recorder();
    const d = new WslDriver({ runner: rec, installDir: 'C:\\h', rootfsTar: 'C:\\r.tar', rootfsTarLocal: '/mnt/c/r.tar', pkgVhd: 'C:\\h\\pkg.vhdx', signalFile: '/nonexistent/signal.json' });
    await d.stop();
    await d.uninstall();
    const all = rec.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(all).toContain('wsl.exe --terminate instar-helper');
    expect(all).toContain('wsl.exe --unregister instar-helper');
    expect(all.some((x) => x.includes('--shutdown'))).toBe(false);
    expect(all.filter((x) => x.includes('--unregister')).every((x) => x.endsWith('--unregister instar-helper'))).toBe(true);
    expect(all).toContain('schtasks.exe /Delete /TN \\Instar\\OwnerSignal /F');
    // Uninstall also detaches the package volume; the daily re-creation (destroy) never does.
    expect(all).toContain('wsl.exe --unmount C:\\h\\pkg.vhdx');
    expect(parseWslList('  NAME            STATE           VERSION\n* Ubuntu          Running         2\n  instar-helper   Stopped         2\n'.split('').join('\u0000'))).toEqual([{ name: 'Ubuntu', state: 'Running' }, { name: 'instar-helper', state: 'Stopped' }]);
  });
});

describe('packages: only from merged code, locked, on their own volume (amendment C, static and command lines)', () => {
  const runner = readHelperTemplate('instar-helper-runner.sh');
  const mode = (name: string, next: string) => runner.slice(runner.indexOf(`  ${name})`), runner.indexOf(`  ${next})`));
  const H = 'a'.repeat(64), M = 'b'.repeat(64), TREE = '0123456789abcdef0123456789abcdef01234567';
  const lima = (out: (cmd: string, args: string[]) => { code: number; stdout?: string } = () => ({ code: 0 })) => {
    const rec = recorder(out);
    return { rec, d: new LimaDriver({ runner: rec, limactl: '/agent/.instar/helper/lima/bin/limactl', helperHome: '/Users/x/.instar-helper' }) };
  };
  const shell = ['shell', '--workdir', '/', 'instar-helper', 'sudo', '-n', '/usr/local/sbin/instar-helper-runner'];

  it('the runner has no npm ci outside `install`, and `install` refuses a placed tree or one that already has node_modules', () => {
    expect(runner).not.toContain('  npm-ci)');
    expect(runner.match(/npm ci --no-audit/g)?.length).toBe(1);
    const install = mode('install', 'place');
    expect(install).toContain('npm ci --no-audit --no-fund');
    expect(install).toContain('die "install in a placed tree"');
    expect(install).toContain('die "tree already has node_modules"');
    // The network is the builder's filtered one, and no other mode has any: the build and slices unshare the network.
    expect(mode('build', 'seal')).toContain('unshare -m -n --propagation private');
    expect(mode('build', 'seal')).not.toContain('npm ci');
  });

  it('`install` locks the packages root-owned and read-only on the volume before it returns, and prints the manifest digest', () => {
    const install = mode('install', 'place');
    const order = ['npm ci --no-audit', 'kill_user builder)" = 0 ] || die "builder processes survived npm ci"', 'cp -a "$t/node_modules" "$d/node_modules"', 'chown -R -P root:root "$d"', 'chmod a-w', 'pkg_manifest "$d" > "$d/manifest.sha256"', 'echo "manifest='];
    const at = order.map((x) => install.indexOf(x));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(install).toContain('d="$PKG/$hash"');
    expect(runner).toContain('PKG=/srv/nm');
  });

  it('the manifest covers every file\'s hash, every link\'s target, and any entry that is not root\'s or is writable; `pkg-verify` recomputes it and compares', () => {
    const manifest = runner.slice(runner.indexOf('pkg_manifest() {'), runner.indexOf('pkg_of() {'));
    expect(manifest).toContain('find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum');
    expect(manifest).toContain("find . -type l -printf 'L %p -> %l\\n'");
    expect(manifest).toContain("find . ! -user root -printf 'O %p\\n'");
    expect(manifest).toContain("find . ! -type l -perm /222 -printf 'W %p\\n'");
    const verify = mode('pkg-verify', 'pkg-discard');
    expect(verify).toContain('got="$(pkg_manifest "$d" | sha256sum | cut -d\' \' -f1)"');
    expect(verify).toContain('if [ "$got" != "$want" ] || [ "$stored" != "$want" ]; then echo "packages=mismatch"; exit 3; fi');
    expect(verify).toContain('echo "packages=absent"; exit 3');
    expect(verify.indexOf('pkg_mount')).toBeLessThan(verify.indexOf('pkg_manifest'));
  });

  it('`place` puts root\'s empty node_modules in a fresh tree before any file; `copy-in … placed` requires it and refuses a tar with node_modules', () => {
    const place = mode('place', 'build');
    expect(place).toContain('die "package manifest mismatch"');
    expect(place.indexOf('rm -rf "$t"')).toBeLessThan(place.indexOf('install -d -m 0555 -o root -g root "$t/node_modules"'));
    expect(place).toContain('printf \'%s\\n\' "$hash" > "$PKG_MARKS/$tree"');
    const copy = mode('copy-in', 'pkg-verify');
    expect(copy).toContain("grep -Eq '^(\\./)?node_modules(/|$)'");
    expect(copy).toContain('die "tree carries node_modules"');
    expect(copy).toContain('pkg_of "$tree" >/dev/null');
    expect(copy).toContain('die "placed tree is not empty"');
    expect(copy.indexOf('tree carries node_modules')).toBeLessThan(copy.indexOf('tar -x --no-same-owner'));
    // pkg_of: the mount point must still be root's own directory, never a link.
    const pkgOf = runner.slice(runner.indexOf('pkg_of() {'), runner.indexOf('mode="${1:-}"'));
    expect(pkgOf).toContain('[ -d "$nm" ] && [ ! -L "$nm" ] && [ "$(stat -c %u "$nm")" = 0 ] || die');
  });

  it('the build and every slice bind the packages read-only inside their own mount namespace, before builder or tester starts', () => {
    const build = mode('build', 'seal');
    const bind = "mount --bind '$PKG/$h/node_modules' '$root/work/node_modules' && mount -o remount,bind,ro,nosuid,nodev '$root/work/node_modules' || exit 97";
    expect(build).toContain(bind);
    expect(build.indexOf(bind)).toBeLessThan(build.indexOf('setpriv --reuid=$BUILDER_UID'));
    expect(build).toContain('h="$(pkg_of "$tree")"');
    const test = mode('test', 'reap');
    expect(test).toContain('mount -o remount,bind,ro,nosuid,nodev \\"\\$root/work/node_modules\\" || exit 97');
    expect(test.indexOf('remount,bind,ro,nosuid,nodev')).toBeLessThan(test.indexOf('setpriv --reuid=$TESTER_UID'));
    // The first design's cache keyed on the raw lock file is gone.
    expect(runner).not.toContain('lock="$(sha256sum "$t/package-lock.json"');
  });

  it('the package volume is its own disk: mounted by label, formatted only when exactly one empty disk of the configured size exists', () => {
    const mount = runner.slice(runner.indexOf('pkg_mount() {'), runner.indexOf('pkg_manifest() {'));
    expect(mount).toContain('blkid -L "$PKG_LABEL"');
    expect(mount).toContain('[ "${#cand[@]}" = 1 ] || die_no_volume "package volume not found"');
    expect(mount).toContain('die "package volume has partitions"');
    expect(mount).toContain('mount -o nodev,nosuid "$dev" "$PKG"');
    expect(packageVolumeConf()).toBe(`PKG_LABEL=instar-pkg\nPKG_SIZE_BYTES=${12 * 1024 ** 3}\n`);
    expect(buildProvisionBundle()).toContain("cat > '/etc/instar-helper/pkg-volume.conf'");
    expect(readHelperTemplate('provision-sandbox.sh')).toMatch(/apt-get install[^\n]*e2fsprogs/);
    // Lima: an additional disk, not a host folder; the walls' config checks are unchanged by it.
    const cfg = yaml.load(renderLimaTemplate({ cpus: 2, memoryGb: 2, diskGb: 10 })) as Record<string, any>;
    expect(cfg.additionalDisks).toEqual([{ name: PACKAGE_VOLUME.name, format: false }]);
    expect(cfg.mounts).toEqual([]);
    expect(limaConfigChecks(renderLimaTemplate({ cpus: 2, memoryGb: 2, diskGb: 10 })).every((c) => c.result === 'pass')).toBe(true);
  });

  it('Lima command lines: verify, discard, install, place, copy-in and build all go through the runner with validated ids', async () => {
    const { rec, d } = lima((_c, a) => (a.includes('pkg-verify') ? { code: 0, stdout: 'packages=ok\n' } : a.includes('install') ? { code: 0, stdout: `noise\nmanifest=${M}\n` } : { code: 0 }));
    expect(await d.verifyPackages(H, M)).toBe(true);
    expect(await d.installPackages(H, TREE, new AbortController().signal)).toEqual({ exitCode: 0, manifestDigest: M });
    await d.placePackages(TREE, H, M);
    await d.copyIn(TREE, Readable.from([Buffer.from('x')]), { placed: true });
    await d.copyIn(TREE, Readable.from([Buffer.from('x')]));
    expect(await d.build(TREE, new AbortController().signal)).toEqual({ exitCode: 0 });
    await d.discardPackages(H);
    expect(rec.calls.map((c) => c.args.slice(shell.length))).toEqual([
      ['pkg-verify', H, M], ['install', H, TREE], ['place', TREE, H, M], ['copy-in', TREE, 'placed'], ['copy-in', TREE, 'fresh'], ['build', TREE], ['pkg-discard', H],
    ]);
    expect(rec.calls.every((c) => c.args.slice(0, shell.length).join(' ') === shell.join(' '))).toBe(true);
    // Ids that are not hashes or tree ids never reach the sandbox.
    const n = rec.calls.length;
    await expect(d.verifyPackages('../x', M)).rejects.toThrow('invalid hash');
    await expect(d.installPackages(H, '$(reboot)', new AbortController().signal)).rejects.toThrow('invalid tree id');
    await expect(d.placePackages(TREE, H, 'short')).rejects.toThrow('invalid hash');
    expect(rec.calls.length).toBe(n);
  });

  it('a manifest mismatch, an absent set and a failed install read as such; a failed place throws', async () => {
    const mismatch = lima(() => ({ code: 3, stdout: 'packages=mismatch\n' }));
    expect(await mismatch.d.verifyPackages(H, M)).toBe(false);
    const absent = lima(() => ({ code: 3, stdout: 'packages=absent\n' }));
    expect(await absent.d.verifyPackages(H, M)).toBe(false);
    // "ok" printed by a runner that then failed is not ok.
    const liar = lima(() => ({ code: 2, stdout: 'packages=ok\n' }));
    expect(await liar.d.verifyPackages(H, M)).toBe(false);
    const failed = lima(() => ({ code: 1, stdout: `manifest=${M}\n` }));
    expect(await failed.d.installPackages(H, TREE, new AbortController().signal)).toEqual({ exitCode: 1, manifestDigest: null });
    const noManifest = lima(() => ({ code: 0, stdout: 'installed\n' }));
    expect((await noManifest.d.installPackages(H, TREE, new AbortController().signal)).manifestDigest).toBeNull();
    await expect(failed.d.placePackages(TREE, H, M)).rejects.toThrow('place failed');
  });

  it('Lima: the package disk is created once and survives the daily re-creation; only uninstall deletes it', async () => {
    expect(limaDiskListed('{"name":"other"}\n{"name":"instar-helper-pkg","size":1}\n', 'instar-helper-pkg')).toBe(true);
    expect(limaDiskListed('{"name":"other"}\nnot json\n', 'instar-helper-pkg')).toBe(false);
    const { rec, d } = lima();
    await d.destroy();
    expect(rec.calls.map((c) => c.args.join(' '))).toEqual(['stop --force instar-helper', 'delete --force instar-helper']);
    await d.uninstall().catch(() => undefined);
    expect(rec.calls.map((c) => c.args.join(' '))).toContain('disk delete --force instar-helper-pkg');
  });

  it('WSL: start attaches the package volume unmounted; the daily re-creation unregisters only the distro', async () => {
    const rec = recorder();
    const d = new WslDriver({ runner: rec, installDir: 'C:\\h', rootfsTar: 'C:\\r.tar', rootfsTarLocal: '/mnt/c/r.tar', pkgVhd: 'C:\\h\\pkg.vhdx', signalFile: '/nonexistent/signal.json' });
    await d.start();
    expect(rec.calls[0]).toEqual({ cmd: 'wsl.exe', args: ['--mount', '--vhd', 'C:\\h\\pkg.vhdx', '--bare'] });
    expect(rec.calls[1].args).toEqual(['-d', 'instar-helper', '-u', 'root', '--', 'true']);
    rec.calls.length = 0;
    await d.destroy();
    expect(rec.calls.map((c) => c.args.join(' '))).toEqual(['--terminate instar-helper', '--unregister instar-helper']);
    await d.verifyPackages(H, M);
    expect(rec.calls.at(-1)!.args).toEqual(['-d', 'instar-helper', '-u', 'root', '--', '/usr/local/sbin/instar-helper-runner', 'pkg-verify', H, M]);
  });

  it('image identity: the pinned digest and a settings hash that moves with the size and the walls, not with time; unpinned is null', async () => {
    // Both shipped images are unpinned until the throwaway rung pins them: no identity, so no waiting change.
    expect(await lima().d.imageIdentity({ cpus: 2, memoryGb: 2, diskGb: 10 })).toBeNull();
    const wsl = (sha: string | null) => new WslDriver({ runner: recorder(), installDir: 'C:\\h', rootfsTar: 'C:\\r.tar', rootfsTarLocal: '/mnt/c/r.tar', pkgVhd: 'C:\\h\\pkg.vhdx', rootfsSha256: sha, signalFile: '/nonexistent' });
    expect(await wsl(null).imageIdentity({ cpus: 2, memoryGb: 2, diskGb: 10 })).toBeNull();
    const a = await wsl('A'.repeat(64)).imageIdentity({ cpus: 2, memoryGb: 2, diskGb: 10 });
    expect(a?.imageDigest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(a?.settingsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await wsl('a'.repeat(64)).imageIdentity({ cpus: 2, memoryGb: 2, diskGb: 10 })).toEqual(a); // the same on every call (a daily re-creation)
    expect((await wsl('a'.repeat(64)).imageIdentity({ cpus: 4, memoryGb: 2, diskGb: 10 }))?.settingsHash).not.toBe(a?.settingsHash);
    expect((await wsl('c'.repeat(64)).imageIdentity({ cpus: 2, memoryGb: 2, diskGb: 10 }))?.imageDigest).not.toBe(a?.imageDigest);
    // The hash frames each part by its length: moving text between parts changes it.
    expect(sandboxSettingsHash(['ab', 'c'])).not.toBe(sandboxSettingsHash(['a', 'bc']));
    expect(sandboxSettingsHash(['ab', 'c'])).toBe(sandboxSettingsHash(['ab', 'c']));
  });
});

describe('limits and parsing', () => {
  it('host disk: free space must cover the sandbox disk\'s remaining growth plus 5 GB', () => {
    const G = 1024 ** 3;
    expect(hostDiskOk(34 * G, 30, 1 * G)).toBe(true);
    expect(hostDiskOk(34 * G - 1, 30, 1 * G)).toBe(false);
    expect(hostDiskOk(null, 30, 0)).toBe(false);
  });
  it('host disk: the package disk\'s remaining growth is counted too; an unknown size counts its whole cap', () => {
    const G = 1024 ** 3;
    const pkg = (fileBytes: number | null) => ({ capBytes: PACKAGE_VOLUME_CAP_BYTES, fileBytes });
    expect(PACKAGE_VOLUME_CAP_BYTES).toBe(12 * G);
    // 29 GB (sandbox) + 10 GB (package disk, 2 of 12 written) + 5 GB margin = 44 GB.
    expect(hostDiskOk(44 * G, 30, 1 * G, pkg(2 * G))).toBe(true);
    expect(hostDiskOk(44 * G - 1, 30, 1 * G, pkg(2 * G))).toBe(false);
    // A full package disk adds nothing; one of unknown size adds all 12 GB.
    expect(hostDiskOk(34 * G, 30, 1 * G, pkg(12 * G))).toBe(true);
    expect(hostDiskOk(46 * G, 30, 1 * G, pkg(null))).toBe(true);
    expect(hostDiskOk(46 * G - 1, 30, 1 * G, pkg(null))).toBe(false);
    expect(hostDiskOk(null, 30, 0, pkg(0))).toBe(false);
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

describe('B2 amended: the test network (static)', () => {
  const runner = readHelperTemplate('instar-helper-runner.sh');
  const checks = readHelperTemplate('instar-helper-checks.sh');
  const mode = (name: string, next: string) => runner.slice(runner.indexOf(`  ${name})`), runner.indexOf(`  ${next})`));

  it('every test namespace gets its own loopback and one dummy interface, 10.77.0.2/24, with no default route', () => {
    const fn = runner.slice(runner.indexOf('testns_net() {'), runner.indexOf('}', runner.indexOf('testns_net() {')));
    expect(fn).toContain('ip link set lo up');
    expect(fn).toContain('ip link add dummy0 type dummy');
    expect(fn).toContain('ip addr add 10.77.0.2/24 dev dummy0');
    expect(fn).toContain('ip link set dummy0 up');
    expect(runner).not.toMatch(/ip (-6 )?route add/);
    expect(fn).toContain('ip route del default');
    // A slice and the check script's test namespace both get it, and a namespace that cannot be set up does not run.
    expect(mode('test', 'reap')).toContain('testns_net || exit 96');
    expect(mode('ns-exec', '\\*')).toContain("if [ '$kind' = testns ]; then testns_net || exit 96; fi");
    // The build keeps loopback only (the spec gives the interface to tests).
    expect(mode('build', 'seal')).toContain('ip link set lo up');
    expect(mode('build', 'seal')).not.toContain('testns_net');
    // npm ci still shares the network and gets neither.
    expect(mode('install', 'place')).not.toContain('dummy0');
  });

  it('the start-up checks look for the interface as a test would, for an absent default route, and for the tailnet listener', () => {
    expect(checks).toContain('networkInterfaces().dummy0');
    expect(checks).toContain('"10.77.0.2"');
    expect(checks).toContain('check testns-dummy-iface-present $?');
    expect(checks).toContain('"$IP" -4 route show default');
    expect(checks).toContain('"$IP" -6 route show default');
    expect(checks).toContain('check testns-no-default-route $?');
    expect(checks).toContain('--host-tailnet-addr) TAILNET_ADDR=');
    expect(checks).toContain('in_testns node -e "$CONNECT" "$TAILNET_ADDR" "$TAILNET_PORT"');
    // The script reports its tailnet attempt only when it was given an address: it never passes by default.
    expect(checks).toContain('if [ "$TAILNET_ADDR" != none ]; then');
    for (const n of ['testns-dummy-iface-present', 'testns-no-default-route', 'testns-no-route-lan', 'testns-no-route-tailnet-listener']) expect(REQUIRED_CHECKS_COMMON, n).toContain(n);
  });

  it('the paired network test: a failed connection from inside counts only beside its own listener answering from the host', () => {
    const out = 'CHECK testns-no-route-lan pass\nCHECK testns-no-route-tailnet-listener pass\n';
    const pair = (name: string, kind: string, address: string | null, answeredFromHost: boolean) => ({ name, kind, address, answeredFromHost });
    const lan = (address: string | null, answered: boolean, script = out) => pairedRouteChecks(script, [pair('testns-no-route-lan', 'local-network', address, answered)])[0];
    const tail = (address: string | null, answered: boolean, script = out) => pairedRouteChecks(script, [pair('testns-no-route-tailnet-listener', 'tailnet', address, answered)])[0];
    // Both halves hold: the wall is proven.
    expect(lan('192.168.1.20', true)).toEqual({ name: 'testns-no-route-lan', result: 'pass' });
    expect(tail('100.64.0.7', true)).toEqual({ name: 'testns-no-route-tailnet-listener', result: 'pass' });
    // The listener never answered from the host side: a failed connection from inside proves nothing.
    expect(lan('192.168.1.20', false)).toMatchObject({ result: 'fail', detail: expect.stringContaining('no positive control') });
    expect(tail('100.64.0.7', false)).toMatchObject({ result: 'fail', detail: expect.stringContaining('no positive control') });
    // No such address on this host: the check cannot run, and the helper does not.
    expect(lan(null, false)).toEqual({ name: 'testns-no-route-lan', result: 'unrunnable', detail: 'no local-network address on this host' });
    expect(tail(null, false)).toEqual({ name: 'testns-no-route-tailnet-listener', result: 'unrunnable', detail: 'no tailnet address on this host' });
    // The sandbox reached the listener: the wall is broken.
    expect(tail('100.64.0.7', true, 'CHECK testns-no-route-tailnet-listener fail\n')).toMatchObject({ result: 'fail', detail: expect.stringContaining('reachable from inside a test namespace') });
    expect(lan('192.168.1.20', true, 'CHECK testns-no-route-lan fail\n')).toMatchObject({ result: 'fail' });
    // The sandbox said nothing about its attempt: unrunnable, never a pass.
    expect(tail('100.64.0.7', true, 'CHECK testns-no-route-lan pass\n')).toEqual({ name: 'testns-no-route-tailnet-listener', result: 'unrunnable', detail: 'not reported from inside the test namespace' });
    // Either one failing fails the whole report, by name.
    const allPass = REQUIRED_CHECKS_COMMON.map((n) => `CHECK ${n} pass`).join('\n');
    expect(parseContainmentOutput(allPass, REQUIRED_CHECKS_COMMON, [lan('192.168.1.20', true), tail('100.64.0.7', true)]).ok).toBe(true);
    const noTailnet = parseContainmentOutput(allPass, REQUIRED_CHECKS_COMMON, [lan('192.168.1.20', true), tail(null, false)]);
    expect([noTailnet.ok, noTailnet.reason]).toEqual([false, 'testns-no-route-tailnet-listener:unrunnable:no tailnet address on this host']);
    const noControl = parseContainmentOutput(allPass, REQUIRED_CHECKS_COMMON, [lan('192.168.1.20', false), tail('100.64.0.7', true)]);
    expect([noControl.ok, noControl.reason?.startsWith('testns-no-route-lan:fail:')]).toEqual([false, true]);
  });

  it('the host picks its local-network address and its tailnet address apart (100.64.0.0/10 is the tailnet)', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('192.168.1.20')).toBe(false);
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as os.NetworkInterfaceInfo;
    const ifaces = { lo0: [v4('127.0.0.1', true)], utun4: [v4('100.101.102.103')], en0: [v4('192.168.1.20')] };
    expect(tailnetAddress(ifaces)).toBe('100.101.102.103');
    expect(lanAddress(ifaces)).toBe('192.168.1.20');
    expect(tailnetAddress({ lo0: [v4('127.0.0.1', true)], en0: [v4('192.168.1.20')] })).toBeNull();
    expect(lanAddress({ lo0: [v4('127.0.0.1', true)], utun4: [v4('100.101.102.103')] })).toBeNull();
    // An address in 100.x outside the tailnet range is an ordinary local-network address.
    expect(lanAddress({ en0: [v4('100.10.0.5')] })).toBe('100.10.0.5');
  });
});

describe('lanes and progress in the runner (static and command lines)', () => {
  const runner = readHelperTemplate('instar-helper-runner.sh');
  const test = runner.slice(runner.indexOf('  test)'), runner.indexOf('  reap)'));
  const lima = (out: (cmd: string, args: string[]) => { code: number; stdout?: string }) => {
    const rec = recorder(out);
    return { rec, d: new LimaDriver({ runner: rec, limactl: '/agent/.instar/helper/lima/bin/limactl', helperHome: '/Users/x/.instar-helper' }) };
  };
  const TREE = '0123456789abcdef0123456789abcdef01234567';
  const frame = `${RESULT_BEGIN} exit=0 unhandled=0 start_ms=700\n{"testResults":[]}\n${RESULT_END}\n`;

  it('each lane runs with its own vitest configuration, the one a run machine uses for that lane', () => {
    // The same table the run machines' lanes are built from.
    expect(LANE_VITEST_CONFIG).toEqual(Object.fromEntries(LANES.map((l) => [l.name, l.config])));
    expect(test).toContain('unit) config="vitest.config.ts" ;;');
    expect(test).toContain('integration) config="vitest.integration.config.ts";');
    expect(test).toContain('e2e) config="vitest.e2e.config.ts";');
    expect(test).toContain('*) die "bad lane" ;;');
    // One process per slice; integration and end-to-end files one at a time.
    expect(test.match(/node node_modules\/vitest\/vitest\.mjs run/g)).toHaveLength(1);
    expect(test).toContain('[ "$workers" = 1 ] || die "integration files run one at a time"');
    expect(test).toContain('[ "$workers" = 1 ] || die "e2e files run one at a time"');
    // The run machines' environment: no CI, a UTF-8 locale, nothing inherited.
    expect(test).toContain('env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/.helper-home TMPDIR=/tmp TMUX_TMPDIR=/tmp LANG=C.UTF-8 INSTAR_TEST_WORKERS=$workers');
    expect(test).not.toMatch(/\bCI=1\b/);
    expect(test).toContain('--allowOnly=false');
  });

  it('the driver names the lane to the runner and refuses more than one worker outside unit', async () => {
    const { rec, d } = lima(() => ({ code: 0, stdout: frame }));
    const signal = new AbortController().signal;
    await d.execAsTester(TREE, { lane: 'integration', files: ['tests/integration/a.test.ts'], workers: 1, signal });
    await d.execAsTester(TREE, { lane: 'e2e', files: ['tests/e2e/a.test.ts'], workers: 1, signal });
    await d.execAsTester(TREE, { lane: 'unit', files: ['tests/unit/a.test.ts'], workers: 6, signal });
    expect(rec.calls.map((c) => c.args.slice(7))).toEqual([
      ['test', TREE, 'integration', '1', '--', 'tests/integration/a.test.ts'],
      ['test', TREE, 'e2e', '1', '--', 'tests/e2e/a.test.ts'],
      ['test', TREE, 'unit', '6', '--', 'tests/unit/a.test.ts'],
    ]);
    const n = rec.calls.length;
    await expect(d.execAsTester(TREE, { lane: 'integration', files: ['tests/integration/a.test.ts'], workers: 2, signal })).rejects.toThrow('one worker');
    await expect(d.execAsTester(TREE, { lane: 'e2e', files: ['tests/e2e/a.test.ts'], workers: 4, signal })).rejects.toThrow('one worker');
    await expect(d.execAsTester(TREE, { lane: 'contract' as never, files: [], workers: 1, signal })).rejects.toThrow('invalid lane');
    expect(rec.calls.length).toBe(n);
  });

  it('progress leaves through the root-owned runner on a pipe it opened: a root-owned reporter outside the tree, never a file in the tree', () => {
    expect(PROGRESS_REPORTER_PATH).toBe('/usr/local/lib/instar-helper/progress-reporter.mjs');
    expect(runner).toContain(`PROGRESS_REPORTER=${PROGRESS_REPORTER_PATH}`);
    expect(test).toContain('--reporter=json --reporter=$PROGRESS_REPORTER');
    // The reporter must be root's own file, or the slice does not start.
    expect(test).toContain('[ "$(stat -c %u "$PROGRESS_REPORTER")" = 0 ] || die "progress reporter missing or not root\'s"');
    // tester's stderr is a pipe the runner opened; only lines with the progress prefix pass, to the runner's own stdout.
    expect(test).toContain('exec 4>&1');
    expect(test).toContain(`2> >(LC_ALL=C grep -a --line-buffered '^${PROGRESS_PREFIX} ' >&4)`);
    // Nothing about progress or results is a file under the tree or its overlay.
    expect(test).not.toContain('--outputFile');
    expect(test).not.toContain('LOCAL_VERIFY_PROGRESS_FILE');
    expect(test).toContain('out="/srv/results/$n.json"');
    // The bundle installs the reporter where the runner expects it, root-owned.
    const bundle = buildProvisionBundle();
    expect(bundle).toContain(`cat > '${PROGRESS_REPORTER_PATH}' <<'`);
    expect(bundle).toContain(`chown root:root '${PROGRESS_REPORTER_PATH}'`);
    expect(bundle).toContain(`chmod 0644 '${PROGRESS_REPORTER_PATH}'`);
  });

  it('the driver reads progress lines while the slice runs and keeps them out of the framed result', async () => {
    const file = (name: string, status: string) => JSON.stringify({ unhandled: name.endsWith('b.test.ts') ? 1 : 0, file: { name: `/srv/slice/${TREE}/${name}`, status: 'passed', startTime: 1, endTime: 5, assertionResults: [{ title: 't', status, failureMessages: [] }] } });
    const stdout = `${PROGRESS_PREFIX} ${file('tests/unit/a.test.ts', 'passed')}\n${PROGRESS_PREFIX} not json\n${PROGRESS_PREFIX} ${file('tests/unit/b.test.ts', 'failed')}\n${frame}`;
    const { d } = lima(() => ({ code: 0, stdout }));
    const seen: TesterProgress[] = [];
    const t = await d.execAsTester(TREE, { lane: 'unit', files: ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'], workers: 2, signal: new AbortController().signal, onProgress: (p) => seen.push(p) });
    expect(seen.map((p) => [p.rootDir, p.unhandledErrors, (JSON.parse(p.reportText) as { testResults: Array<{ name: string }> }).testResults[0].name])).toEqual([
      [`/srv/slice/${TREE}`, 0, `/srv/slice/${TREE}/tests/unit/a.test.ts`],
      [`/srv/slice/${TREE}`, 1, `/srv/slice/${TREE}/tests/unit/b.test.ts`],
    ]);
    // The result is the framed report alone; a broken progress line was dropped, not passed on and not kept.
    expect(t).toMatchObject({ exitCode: 0, resultText: '{"testResults":[]}', unhandledErrors: 0, vitestStartMs: 700 });
    // A throwing reader never breaks the slice.
    const again = await d.execAsTester(TREE, { lane: 'unit', files: ['tests/unit/a.test.ts'], workers: 1, signal: new AbortController().signal, onProgress: () => { throw new Error('reader'); } });
    expect(again.exitCode).toBe(0);
  });

  it('a progress line is the prefix and one JSON object with a file entry and a count; anything else is not progress', () => {
    const good = `${PROGRESS_PREFIX} ${JSON.stringify({ unhandled: 2, file: { name: '/r/tests/unit/a.test.ts', assertionResults: [] } })}`;
    expect(parseProgressLine(good)).toEqual({ unhandledErrors: 2, reportText: JSON.stringify({ testResults: [{ name: '/r/tests/unit/a.test.ts', assertionResults: [] }] }) });
    expect(parseProgressLine(good.replace(PROGRESS_PREFIX, 'INSTAR-HELPER-RESULT-BEGIN'))).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}${good.slice(PROGRESS_PREFIX.length + 1)}`)).toBeNull(); // no space after the prefix
    expect(parseProgressLine(`${PROGRESS_PREFIX} {"unhandled":-1,"file":{"name":"x","assertionResults":[]}}`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX} {"unhandled":0,"file":{"name":"x"}}`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX} {"unhandled":0}`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX} [1]`)).toBeNull();
    // At the bound it is read; one byte over it is not.
    const pad = (n: number) => `${PROGRESS_PREFIX} ${JSON.stringify({ unhandled: 0, file: { name: 'x', assertionResults: [], pad: '' } }).replace('"pad":""', `"pad":"${'p'.repeat(n)}"`)}`;
    const base = Buffer.byteLength(pad(0));
    expect(parseProgressLine(pad(HELPER_LIMITS.progressLineMaxBytes - base))).not.toBeNull();
    expect(parseProgressLine(pad(HELPER_LIMITS.progressLineMaxBytes - base + 1))).toBeNull();
  });

  it('streamed lines: a consumed line is not kept and does not count toward the cap; past the cap the whole result is refused', async () => {
    const lines: string[] = [];
    const consume = (line: string): boolean => { lines.push(line); return line.startsWith('P '); };
    // Lines split across chunks are put together; the last line needs no line end.
    const text = await readLinesCapped(Readable.from([Buffer.from('P one\nkeep'), Buffer.from(' this\nP tw'), Buffer.from('o\nend')]), 1024, consume);
    expect(text).toEqual({ text: 'keep this\nend' });
    expect(lines).toEqual(['P one', 'keep this', 'P two', 'end']);
    // 3 KB of consumed lines beside 10 bytes of output stays under a 1 KB cap.
    const many = Array.from({ length: 30 }, () => `P ${'x'.repeat(100)}\n`).join('');
    expect(await readLinesCapped(Readable.from([Buffer.from(many), Buffer.from('0123456789')]), 1024, consume)).toEqual({ text: '0123456789' });
    // Kept output past the cap: refused whole, never cut.
    const over = await readLinesCapped(Readable.from([Buffer.from(`${'k'.repeat(600)}\n`), Buffer.from(`${'k'.repeat(600)}\n`)]), 1024, consume);
    expect(over).toEqual({ oversize: { bytesSeen: 1202 } });
    // A reader that throws leaves the line in the output.
    expect(await readLinesCapped(Readable.from([Buffer.from('a\nb\n')]), 1024, () => { throw new Error('reader'); })).toEqual({ text: 'a\nb\n' });
  });
});

describe('the package volume has its own named reason', () => {
  const runner = readHelperTemplate('instar-helper-runner.sh');
  it('the runner exits with its own code when the package volume is not there, and `pkg-volume` asks for it by itself', () => {
    expect(PKG_VOLUME_MISSING_EXIT).toBe(44);
    expect(runner).toContain('die_no_volume() { echo "instar-helper-runner: $*" >&2; exit 44; }');
    expect(runner).toContain('die_no_volume "package volume not configured"');
    expect(runner).toContain('die_no_volume "package volume not found"');
    const mode = runner.slice(runner.indexOf('  pkg-volume)'), runner.indexOf('  pkg-verify)'));
    expect(mode).toContain('pkg_mount');
    expect(mode).toContain('echo "volume=ok"');
  });

  it('the driver reads the volume as there only on `volume=ok`; the missing-volume exit, any other failure and silence all read as not there', async () => {
    const ready = async (out: { code: number; stdout?: string }) => {
      const rec = recorder(() => out);
      const d = new LimaDriver({ runner: rec, limactl: '/agent/.instar/helper/lima/bin/limactl', helperHome: '/Users/x/.instar-helper' });
      const r = await d.packageVolumeReady();
      expect(rec.calls[0].args.slice(7)).toEqual(['pkg-volume']);
      return r;
    };
    expect(await ready({ code: 0, stdout: 'volume=ok\n' })).toBe(true);
    expect(await ready({ code: PKG_VOLUME_MISSING_EXIT, stdout: '' })).toBe(false);
    expect(await ready({ code: PKG_VOLUME_MISSING_EXIT, stdout: 'volume=ok\n' })).toBe(false);
    expect(await ready({ code: 2, stdout: '' })).toBe(false);
    expect(await ready({ code: 0, stdout: '' })).toBe(false);
    // An install that hit the missing volume reports the runner's own code, for the service to name.
    const rec = recorder(() => ({ code: PKG_VOLUME_MISSING_EXIT }));
    const d = new LimaDriver({ runner: rec, limactl: '/agent/.instar/helper/lima/bin/limactl', helperHome: '/Users/x/.instar-helper' });
    expect(await d.installPackages('a'.repeat(64), '0123456789abcdef', new AbortController().signal)).toEqual({ exitCode: PKG_VOLUME_MISSING_EXIT, manifestDigest: null });
  });
});
