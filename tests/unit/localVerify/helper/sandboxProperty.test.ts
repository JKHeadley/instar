// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: THE SANDBOX PROPERTY (docs/specs/local-verify-borrowed-slices-count.md, "Tests", sandbox
 * property; a condition of the design's approval):
 *
 *   from inside the sandbox, as `tester` or as `builder`, no host path is readable (a marker file
 *   in the owner's home; any mount of a host folder) and no host credential is reachable (the
 *   helper's GitHub token, the agent's secret store, SSH-agent or keychain sockets).
 *
 * The real sandbox is checked at every start by the property probe
 * (src/templates/helper/instar-helper-property-probe.cjs), run as tester and as builder by the
 * check script. This suite runs the SAME assertions three ways, without a sandbox:
 *
 *  1. the probe itself, for real, against made-up views: a clean view passes with its positive
 *     control, and each kind of leak fails the facet it belongs to;
 *  2. the drivers' configuration (Lima, WSL): no host folder is mounted, no agent is forwarded;
 *  3. the drivers' command construction, with a recording runner: no command a driver starts is
 *     given the server's environment, a credential variable, an agent socket or the token, and
 *     the commands that run test or build code start from an empty environment as tester / builder;
 * and that the start-up checks require every facet, so a failed or missing one stops the helper
 * (the service side of that is in helperSlices.test.ts, on the fake driver).
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import type { CommandRunner } from '../../../../src/localVerify/helper/commandRunner.js';
import { LimaDriver, limaConfigChecks, renderLimaTemplate } from '../../../../src/localVerify/helper/limaDriver.js';
import { WslDriver, wslConfChecks } from '../../../../src/localVerify/helper/wslDriver.js';
import { CONTROL_ENV_ALLOW, PROPERTY_PROBE_PATH, SANDBOX_LIB_DIR, buildProvisionBundle, controlChannelEnv, helperTemplatePath, readHelperTemplate } from '../../../../src/localVerify/helper/runnerDriverBase.js';
import { REQUIRED_CHECKS_COMMON, REQUIRED_CHECKS_WSL, SANDBOX_PROPERTY_CHECKS, SANDBOX_PROPERTY_FACETS, SANDBOX_PROPERTY_USERS, parseContainmentOutput } from '../../../../src/localVerify/helper/sandboxDriver.js';
import { credentialDigestsOf } from '../../../../src/localVerify/helper/helperWiring.js';

const execFileAsync = promisify(execFile);
const PROBE = helperTemplatePath('instar-helper-property-probe.cjs');
const MARKER = '.instar-helper-marker-0a1b2c3d4e5f';
const TOKEN = `ghp_${'Zx9'.repeat(12)}`;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const dirs: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((res) => s.close(() => res()));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'sandboxProperty.test.ts' });
});

/** A made-up sandbox view as the probe sees one: system folders, a writable /tmp, a mount table. A short path: unix sockets have a small limit. */
function view(): string {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pp-'));
  dirs.push(root);
  for (const d of ['usr/bin', 'etc', 'opt', 'work', 'tmp', 'proc', 'dev', 'run']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'proc', 'mounts'), 'overlay / overlay rw,relatime 0 0\ntmpfs /tmp tmpfs rw 0 0\nproc /proc proc rw 0 0\n/dev/vdb /srv/nm ext4 ro 0 0\n');
  fs.writeFileSync(path.join(root, 'usr/bin/node'), '');
  return root;
}

interface ProbeResult { facets: Record<string, string>; control: string; raw: string }

/** Run the real probe on a view, with exactly the environment given (as `env -i` does in the sandbox). */
async function probe(root: string, o: { env?: Record<string, string>; digests?: string[]; envOnly?: boolean; ownerUser?: string } = {}): Promise<ProbeResult> {
  const args = [PROBE, ...(o.envOnly ? ['--env-only'] : ['--root', root, '--marker', MARKER, '--owner-user', o.ownerUser ?? 'justin']), '--digests', o.digests?.length ? o.digests.join(',') : 'none'];
  const { stdout } = await execFileAsync(process.execPath, args, { env: { PATH: '/usr/bin:/bin', ...(o.env ?? {}) } });
  const facets: Record<string, string> = {};
  let control = 'missing';
  for (const line of stdout.split('\n')) {
    const m = /^PROBE (\S+) (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'control') control = m[2];
    else facets[m[1]] = m[2];
  }
  return { facets, control, raw: stdout };
}

const ALL_OK = { 'no-host-path-readable': 'ok', 'no-github-token': 'ok', 'no-secret-store': 'ok', 'no-agent-socket': 'ok' };

describe('the property probe, run for real against made-up views', () => {
  it('a clean view passes every facet, with its positive control', async () => {
    const r = await probe(view(), { digests: [sha256(TOKEN)] });
    expect(r.facets).toEqual(ALL_OK);
    expect(r.control).toBe('ok');
    // The probe names exactly the facets the start-up checks require.
    expect(Object.keys(r.facets).sort()).toEqual([...SANDBOX_PROPERTY_FACETS].sort());
  });

  it('HOST PATH: the owner\'s marker file anywhere in the view is found, as tester and builder would find it', async () => {
    for (const where of ['work/sub/deep', 'tmp', 'usr/bin', 'run']) {
      const root = view();
      fs.mkdirSync(path.join(root, where), { recursive: true });
      fs.writeFileSync(path.join(root, where, MARKER), 'instar-helper containment marker\n');
      const r = await probe(root);
      expect(r.facets['no-host-path-readable'], where).toContain(`the owner's marker file at /${where}/${MARKER}`);
      expect(r.control).toBe('ok');
      expect({ ...r.facets, 'no-host-path-readable': 'ok' }).toEqual(ALL_OK);
    }
    // Another file with a different name is not the marker.
    const other = view();
    fs.writeFileSync(path.join(other, 'tmp', '.instar-helper-marker-ffffffffffff'), 'x');
    expect((await probe(other)).facets).toEqual(ALL_OK);
  });

  it('HOST PATH: any mount of a host folder is found (Lima virtiofs / 9p / sshfs, WSL drvfs, shared folders, network shares)', async () => {
    for (const line of ['mount0 /Users/justin virtiofs ro 0 0', 'lima-9p /tmp/lima 9p rw 0 0', 'C:\\134 /mnt/c drvfs rw 0 0', 'justin@host: /home/x fuse.sshfs rw 0 0', 'vbox /media/sf vboxsf rw 0 0', '//nas/share /mnt/nas cifs rw 0 0']) {
      const root = view();
      fs.appendFileSync(path.join(root, 'proc', 'mounts'), `${line}\n`);
      const r = await probe(root);
      expect(r.facets['no-host-path-readable'], line).toContain(`${line.split(' ')[2]} mounted at ${line.split(' ')[1]}`);
    }
    // The sandbox's own file systems (overlay, ext4, tmpfs, proc) are not host folders: the clean view above passes.
    // A mount table that cannot be read is not a pass.
    const blind = view();
    SafeFsExecutor.safeRmSync(path.join(blind, 'proc', 'mounts'), { force: true, operation: 'sandboxProperty.test.ts' });
    expect((await probe(blind)).facets['no-host-path-readable']).toContain('the mount table is not readable');
  });

  it('HOST PATH: a host home folder that exists is found (/Users, /Volumes, /mnt/c, /mnt/wsl, the owner\'s own home)', async () => {
    for (const d of ['Users', 'Volumes', 'mnt/c', 'mnt/wsl', 'home/justin', 'Users/justin']) {
      const root = view();
      fs.mkdirSync(path.join(root, d), { recursive: true });
      expect((await probe(root)).facets['no-host-path-readable'], d).toContain(`/${d} exists`);
    }
    // Another user's home folder inside the guest is not the owner's.
    const other = view();
    fs.mkdirSync(path.join(other, 'home/builder'), { recursive: true });
    expect((await probe(other)).facets).toEqual(ALL_OK);
  });

  it('CREDENTIAL: the helper\'s GitHub token is found by name, by shape, and by its digest under any name; only the digest is ever given to the probe', async () => {
    const digests = [sha256(TOKEN)];
    const byName = await probe(view(), { env: { GITHUB_TOKEN: 'anything' }, digests });
    expect(byName.facets['no-github-token']).toContain('variable GITHUB_TOKEN (own environment)');
    const byShape = await probe(view(), { env: { SOME_SETTING: `prefix ${TOKEN}` } });
    expect(byShape.facets['no-github-token']).toContain('token-shaped value in SOME_SETTING');
    // A token that has no telling shape and sits under an innocent name is still found, by digest.
    const plain = 'a-rotated-secret-with-no-shape';
    const byDigest = await probe(view(), { env: { COLOR_SCHEME: plain }, digests: [sha256(plain)] });
    expect(byDigest.facets['no-github-token']).toContain("the helper's token in COLOR_SCHEME");
    // The other side: the same value without its digest given, and an ordinary environment, pass.
    expect((await probe(view(), { env: { COLOR_SCHEME: plain }, digests })).facets).toEqual(ALL_OK);
    expect((await probe(view(), { env: { HOME: '/work/.helper-home', TMPDIR: '/tmp', LANG: 'C.UTF-8', INSTAR_TEST_WORKERS: '4' }, digests })).facets).toEqual(ALL_OK);
    for (const r of [byName, byShape, byDigest]) expect({ ...r.facets, 'no-github-token': 'ok' }).toEqual(ALL_OK);
    // Nothing the probe was given or printed is the token itself.
    expect(byDigest.raw).not.toContain(plain);
  });

  it('CREDENTIAL: a token in another readable process\'s environment or on its command line is found', async () => {
    const root = view();
    fs.mkdirSync(path.join(root, 'proc', '4242'));
    fs.writeFileSync(path.join(root, 'proc', '4242', 'environ'), `PATH=/usr/bin\0GH_TOKEN=${TOKEN}\0`);
    fs.writeFileSync(path.join(root, 'proc', '4242', 'cmdline'), 'node\0server.js\0');
    expect((await probe(root)).facets['no-github-token']).toContain('variable GH_TOKEN (pid 4242)');
    const onArgs = view();
    fs.mkdirSync(path.join(onArgs, 'proc', '77'));
    fs.writeFileSync(path.join(onArgs, 'proc', '77', 'environ'), 'PATH=/usr/bin\0');
    fs.writeFileSync(path.join(onArgs, 'proc', '77', 'cmdline'), `curl\0-H\0${TOKEN}\0`);
    expect((await probe(onArgs)).facets['no-github-token']).toContain('token-shaped argument (pid 77)');
    const byDigest = view();
    fs.mkdirSync(path.join(byDigest, 'proc', '78'));
    fs.writeFileSync(path.join(byDigest, 'proc', '78', 'environ'), '');
    fs.writeFileSync(path.join(byDigest, 'proc', '78', 'cmdline'), 'tool\0plain-secret\0');
    expect((await probe(byDigest, { digests: [sha256('plain-secret')] })).facets['no-github-token']).toContain("the helper's token on a command line (pid 78)");
    // The other side: an ordinary process is nothing.
    const clean = view();
    fs.mkdirSync(path.join(clean, 'proc', '9'));
    fs.writeFileSync(path.join(clean, 'proc', '9', 'environ'), 'PATH=/usr/bin\0HOME=/work\0');
    fs.writeFileSync(path.join(clean, 'proc', '9', 'cmdline'), 'node\0vitest.mjs\0run\0');
    expect((await probe(clean)).facets).toEqual(ALL_OK);
  });

  it('CREDENTIAL: the agent\'s secret store and a user\'s credential folders are found by name, wherever they sit', async () => {
    const plant: Array<[string, boolean]> = [
      ['work/.instar', true], ['tmp/x/secrets/config.secrets.enc', false], ['opt/machine/secrets-master.key', false],
      ['tmp/home/.ssh', true], ['run/.gnupg', true], ['work/.aws', true], ['tmp/.netrc', false], ['tmp/.git-credentials', false],
      ['tmp/.config/gh/hosts.yml', false], ['tmp/Library/Keychains', true],
    ];
    for (const [p, isDir] of plant) {
      const root = view();
      if (isDir) fs.mkdirSync(path.join(root, p), { recursive: true });
      else { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), 'x'); }
      const r = await probe(root);
      expect(r.facets['no-secret-store'], p).toContain(`/${p}`);
      expect({ ...r.facets, 'no-secret-store': 'ok' }, p).toEqual(ALL_OK);
    }
    // The other side: the system's own ssh configuration folder, and gh's folder without a login, are not credentials.
    const clean = view();
    fs.mkdirSync(path.join(clean, 'etc/ssh'), { recursive: true });
    fs.mkdirSync(path.join(clean, 'tmp/.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(clean, 'tmp/.config/gh/config.yml'), 'x');
    expect((await probe(clean)).facets).toEqual(ALL_OK);
  });

  it('CREDENTIAL: an SSH-agent, GPG-agent, keyring or desktop-bus variable, and any unix socket in the view, are found', async () => {
    for (const v of ['SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'GNOME_KEYRING_CONTROL', 'DBUS_SESSION_BUS_ADDRESS']) {
      const r = await probe(view(), { env: { [v]: '/run/user/501/agent.sock' } });
      expect(r.facets['no-agent-socket'], v).toContain(`variable ${v} (own environment)`);
      expect({ ...r.facets, 'no-agent-socket': 'ok' }).toEqual(ALL_OK);
    }
    // A socket of any name: an SSH agent's, a keychain's, a docker daemon's.
    for (const name of ['run/agent.4711', 'tmp/S.gpg-agent', 'run/docker.sock']) {
      const root = view();
      const s = net.createServer();
      servers.push(s);
      await new Promise<void>((res, rej) => { s.once('error', rej); s.listen(path.join(root, name), () => res()); });
      const r = await probe(root);
      expect(r.facets['no-agent-socket'], name).toContain(`socket /${name}`);
      expect(r.control).toBe('ok');
    }
  });

  it('the positive control: a probe that cannot plant and find its own findings does not pass, even though it found nothing', async () => {
    const root = view();
    // Nowhere to plant: no writable /tmp and no /work.
    SafeFsExecutor.safeRmSync(path.join(root, 'tmp'), { recursive: true, force: true, operation: 'sandboxProperty.test.ts' });
    SafeFsExecutor.safeRmSync(path.join(root, 'work'), { recursive: true, force: true, operation: 'sandboxProperty.test.ts' });
    const r = await probe(root);
    expect(r.facets).toEqual(ALL_OK);
    expect(r.control).toBe('failed no-writable-scratch');
    // What the control planted stays inside its own scratch folder (in the sandbox: a private /tmp
    // that is thrown away with the namespace); nothing is planted anywhere else in the view.
    const clean = view();
    const before = fs.readdirSync(clean).sort();
    expect((await probe(clean)).control).toBe('ok');
    expect(fs.readdirSync(clean).sort()).toEqual(before);
    const left = fs.readdirSync(path.join(clean, 'tmp'));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^pc-/);
    expect(fs.readdirSync(path.join(clean, 'work'))).toEqual([]);
    // The socket it bound is closed again: no listener is left behind.
    expect(fs.existsSync(path.join(clean, 'tmp', left[0], 'a.sock'))).toBe(false);
  });

  it('--env-only: the same credential test on what the control channel handed the sandbox', async () => {
    const clean = await probe('', { envOnly: true, env: { HOME: '/root', LANG: 'C.UTF-8', SUDO_USER: 'lima', SUDO_COMMAND: '/usr/local/sbin/instar-helper-runner checks' } });
    expect(clean.facets).toEqual({ 'no-github-token': 'ok', 'no-agent-socket': 'ok' });
    expect(clean.control).toBe('ok');
    const leaked = await probe('', { envOnly: true, env: { HELPER_GITHUB_TOKEN: 'x' } });
    expect(leaked.facets['no-github-token']).toContain('variable HELPER_GITHUB_TOKEN');
    const agent = await probe('', { envOnly: true, env: { SSH_AUTH_SOCK: '/tmp/ssh-XXXX/agent.1' } });
    expect(agent.facets['no-agent-socket']).toContain('variable SSH_AUTH_SOCK');
    const digest = await probe('', { envOnly: true, env: { LC_NOTHING: 'plain-secret' }, digests: [sha256('plain-secret')] });
    expect(digest.facets['no-github-token']).toContain("the helper's token in LC_NOTHING");
  });

  it('refuses a malformed argument rather than guess', async () => {
    await expect(execFileAsync(process.execPath, [PROBE, '--marker', '../../etc/passwd'], { env: { PATH: '/usr/bin:/bin' } })).rejects.toMatchObject({ code: 2 });
    await expect(execFileAsync(process.execPath, [PROBE, '--nonsense'], { env: { PATH: '/usr/bin:/bin' } })).rejects.toMatchObject({ code: 2 });
  });
});

describe('the start-up checks require the property, at every start', () => {
  const checks = readHelperTemplate('instar-helper-checks.sh');

  it('every facet for tester and for builder, and the control-channel check, are required on both sandboxes', () => {
    expect(SANDBOX_PROPERTY_USERS).toEqual(['tester', 'builder']);
    expect(SANDBOX_PROPERTY_FACETS).toEqual(['no-host-path-readable', 'no-github-token', 'no-secret-store', 'no-agent-socket']);
    for (const n of SANDBOX_PROPERTY_CHECKS) {
      expect(REQUIRED_CHECKS_COMMON, n).toContain(n);
      expect(REQUIRED_CHECKS_WSL, n).toContain(n);
    }
    const allPass = REQUIRED_CHECKS_COMMON.map((n) => `CHECK ${n} pass`).join('\n');
    expect(parseContainmentOutput(allPass, REQUIRED_CHECKS_COMMON).ok).toBe(true);
    for (const n of SANDBOX_PROPERTY_CHECKS) {
      // A facet that failed: the helper does not run, and the reason names it.
      const failed = parseContainmentOutput(allPass.replace(`CHECK ${n} pass`, `CHECK ${n} fail PROBE found something`), REQUIRED_CHECKS_COMMON);
      expect([failed.ok, failed.reason], n).toEqual([false, `${n}:fail:PROBE found something`]);
      // A facet that was never reported (the probe could not run): unrunnable, which refuses too.
      const missing = parseContainmentOutput(allPass.replace(`CHECK ${n} pass`, ''), REQUIRED_CHECKS_COMMON);
      expect([missing.ok, missing.reason], n).toEqual([false, `${n}:unrunnable:not reported`]);
    }
  });

  it('the check script runs the probe as tester in a test namespace and as builder in the build\'s view, and passes a facet only beside the positive control', () => {
    expect(PROPERTY_PROBE_PATH).toBe(`${SANDBOX_LIB_DIR}/property-probe.cjs`);
    expect(checks).toContain(`PROBE=${PROPERTY_PROBE_PATH}`);
    expect(checks).toContain('probe_as tester testns "$TESTER_UID"');
    expect(checks).toContain('probe_as builder builderview "$BUILDER_UID"');
    // Inside the user's own view, through the same runner path the tests and the build use.
    expect(checks).toContain('"$RUNNER" ns-exec "$2" "$3" -- node "$PROBE" --marker "${MARKER:-none}" --owner-user "$OWNER_USER" --digests "$DIGESTS"');
    const fn = checks.slice(checks.indexOf('probe_as() {'), checks.indexOf('probe_as tester'));
    expect(fn).toContain("grep -q '^PROBE control ok$'");
    expect(fn.indexOf("grep -q '^PROBE control ok$'")).toBeLessThan(fn.indexOf('"PROBE $f ok"'));
    // Without the control every facet of that user fails.
    expect(fn).toContain('check "$1-$f" 1 "no positive control');
    for (const f of SANDBOX_PROPERTY_FACETS) expect(fn, f).toContain(f);
    // Root's own environment, as the control channel handed it over.
    expect(checks).toContain('node "$PROBE" --env-only --digests "$DIGESTS"');
    expect(checks).toContain('check control-channel-env-clean 0');
    // The script is given digests, never a credential's value.
    expect(checks).toContain('--credential-digests) DIGESTS="$2"');
    expect(checks).not.toMatch(/--(token|credential)(-value)?\)/);
  });

  it('the probe is root\'s own file outside every tree, installed with the sandbox', () => {
    const bundle = buildProvisionBundle();
    expect(bundle).toContain(`install -d -m 0755 -o root -g root /etc/instar-helper /usr/local/sbin ${SANDBOX_LIB_DIR}`);
    expect(bundle).toContain(`cat > '${PROPERTY_PROBE_PATH}' <<'`);
    expect(bundle).toContain(`chown root:root '${PROPERTY_PROBE_PATH}'`);
    expect(bundle).toContain(`chmod 0644 '${PROPERTY_PROBE_PATH}'`);
    // The probe loads nothing from a tree or from installed packages: only node's own modules.
    const src = fs.readFileSync(PROBE, 'utf-8');
    const required = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((r) => r.startsWith('node:'))).toBe(true);
  });
});

describe('the drivers\' configuration: no host folder, no forwarded agent', () => {
  it('Lima: the rendered template mounts nothing, forwards no agent and no port, and has only the package disk beside the image', () => {
    const cfg = yaml.load(renderLimaTemplate({ cpus: 4, memoryGb: 8, diskGb: 30 })) as Record<string, unknown>;
    expect(cfg.mounts).toEqual([]);
    expect(cfg.ssh).toMatchObject({ forwardAgent: false, forwardX11: false, forwardX11Trusted: false, loadDotSSHPubKeys: false });
    expect(cfg.portForwards).toEqual([{ guestPortRange: [1, 65535], ignore: true }]);
    expect(cfg.propagateProxyEnv).toBe(false);
    expect(cfg.plain).toBe(true);
    expect(cfg.additionalDisks).toEqual([{ name: 'instar-helper-pkg', format: false }]);
    expect(cfg).not.toHaveProperty('env');
    expect(cfg).not.toHaveProperty('copyToHost');
    // The start-up check on the instance's own config fails any of them.
    const withMount = { ...cfg, mounts: [{ location: '~', writable: false }] };
    expect(limaConfigChecks(yaml.dump(withMount)).find((c) => c.name === 'config-no-mounts')?.result).toBe('fail');
    const withAgent = { ...cfg, ssh: { ...(cfg.ssh as object), forwardAgent: true } };
    expect(limaConfigChecks(yaml.dump(withAgent)).find((c) => c.name === 'config-no-forwards')?.result).toBe('fail');
    expect(limaConfigChecks(yaml.dump(cfg)).every((c) => c.result === 'pass')).toBe(true);
  });

  it('WSL: the distro\'s own wsl.conf turns automount and Windows interop off, and the check fails either one on', () => {
    const conf = readHelperTemplate('wsl.conf');
    expect(wslConfChecks(conf).find((c) => c.name === 'config-no-mounts')?.result).toBe('pass');
    expect(wslConfChecks(conf.replace('[automount]\nenabled=false', '[automount]\nenabled=true')).find((c) => c.name === 'config-no-mounts')?.result).toBe('fail');
    expect(wslConfChecks(conf.replace('[interop]\nenabled=false', '[interop]\nenabled=true')).find((c) => c.name === 'config-no-mounts')?.result).toBe('fail');
    expect(wslConfChecks(conf.replace('mountFsTab=false', 'mountFsTab=true')).find((c) => c.name === 'config-no-mounts')?.result).toBe('fail');
    expect(wslConfChecks(null).every((c) => c.result === 'unrunnable')).toBe(true);
  });
});

describe('the drivers\' command construction: nothing of the host rides the control channel', () => {
  const LEAKY = { GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, HELPER_GITHUB_TOKEN: TOKEN, SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners', GPG_AGENT_INFO: '/x', ANTHROPIC_API_KEY: 'sk-ant-x', INSTAR_AUTH_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'k', WSLENV: 'GH_TOKEN/u' };

  function recorder(out: (cmd: string, args: string[]) => { code: number; stdout?: string } = () => ({ code: 0 })): CommandRunner & { calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> } {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    return { calls, async run(cmd, args, opts) { calls.push({ cmd, args, env: opts?.env }); const r = out(cmd, args); return { code: r.code, stdout: r.stdout ?? '', stderr: '' }; } };
  }

  /** Run `fn` with the server's environment holding credentials, as an agent server's can. */
  async function withLeakyEnv(fn: () => Promise<void>): Promise<void> {
    const before = { ...process.env };
    Object.assign(process.env, LEAKY);
    try { await fn(); } finally {
      for (const k of Object.keys(LEAKY)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
    }
  }

  /** Every operation a driver has that starts a host command. */
  async function everyOperation(d: LimaDriver | WslDriver): Promise<void> {
    const signal = new AbortController().signal;
    const TREE = '0123456789abcdef0123456789abcdef01234567';
    const H = 'a'.repeat(64);
    const M = 'b'.repeat(64);
    await d.start().catch(() => undefined);
    await d.status();
    await d.copyIn(TREE, Readable.from([Buffer.from('x')]), { placed: true }).catch(() => undefined);
    await d.packageVolumeReady();
    await d.verifyPackages(H, M);
    await d.installPackages(H, TREE, signal);
    await d.placePackages(TREE, H, M).catch(() => undefined);
    await d.build(TREE, signal);
    await d.sealTree(TREE).catch(() => undefined);
    await d.execAsTester(TREE, { lane: 'integration', files: ['tests/integration/a.test.ts'], workers: 1, signal });
    await d.reap();
    await d.removeTree(TREE);
    await d.discardPackages(H);
    await d.sandboxFreeBytes();
    await d.sandboxBusyCores();
    await d.stop();
    await d.destroy();
  }

  function assertEnvClean(calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }>): void {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.env).toBeDefined();
      for (const k of Object.keys(LEAKY)) expect(c.env![k], k).toBeUndefined();
      expect(JSON.stringify(c.env)).not.toContain(TOKEN);
    }
  }

  function assertNothingRides(calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined }>, allowed: readonly string[]): void {
    expect(calls.length).toBeGreaterThan(15);
    for (const c of calls) {
      const line = `${c.cmd} ${c.args.join(' ')}`;
      // An explicit environment on every command: never the server's own by default.
      expect(c.env, line).toBeDefined();
      const env = c.env!;
      expect(Object.keys(env).filter((k) => !allowed.includes(k)), line).toEqual([]);
      for (const k of Object.keys(LEAKY)) if (k !== 'WSLENV') expect(env[k], `${k} in ${line}`).toBeUndefined();
      expect(JSON.stringify(env), line).not.toContain(TOKEN);
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(LEAKY.SSH_AUTH_SOCK);
    }
  }

  it('Lima: every command gets the allow-listed environment plus LIMA_HOME: no token, no agent socket, no server secret', async () => {
    await withLeakyEnv(async () => {
      const rec = recorder((_c, a) => (a.includes('disk') ? { code: 0, stdout: '{"name":"instar-helper-pkg"}\n' } : { code: 0 }));
      const home = fs.mkdtempSync('/tmp/pp-lima-');
      dirs.push(home);
      const d = new LimaDriver({ runner: rec, limactl: '/agent/.instar/helper/lima/bin/limactl', helperHome: home });
      await everyOperation(d);
      await d.uninstall();
      assertNothingRides(rec.calls, [...CONTROL_ENV_ALLOW, 'LIMA_HOME']);
      expect(rec.calls.every((c) => c.env!.LIMA_HOME === path.join(home, 'lima'))).toBe(true);
    });
  });

  it('WSL: every command gets the allow-listed environment plus what Windows interop needs, with WSLENV empty so nothing is carried into the distro', async () => {
    await withLeakyEnv(async () => {
      const rec = recorder();
      const home = fs.mkdtempSync('/tmp/pp-wsl-');
      dirs.push(home);
      const d = new WslDriver({ runner: rec, installDir: 'C:\\h', rootfsTar: 'C:\\r.tar', rootfsTarLocal: '/mnt/c/r.tar', pkgVhd: 'C:\\h\\pkg.vhdx', signalFile: path.join(home, 'signal.json') });
      await everyOperation(d);
      await d.uninstall();
      assertNothingRides(rec.calls, [...CONTROL_ENV_ALLOW, 'WSL_INTEROP', 'WSL_DISTRO_NAME', 'WSLENV']);
      expect(rec.calls.every((c) => c.env!.WSLENV === '')).toBe(true);
    });
  });

  it('the start-up check itself: the driver plants its marker in the owner\'s home and removes it, passes listener addresses and the token\'s DIGEST, and never a credential', async () => {
    await withLeakyEnv(async () => {
      const home = fs.realpathSync(fs.mkdtempSync('/tmp/pp-home-'));
      dirs.push(home);
      const savedHome = process.env.HOME;
      process.env.HOME = home;
      try {
        // The instance's own config, as Lima writes it: the host-side configuration checks read it.
        fs.mkdirSync(path.join(home, 'lima', 'instar-helper'), { recursive: true });
        fs.writeFileSync(path.join(home, 'lima', 'instar-helper', 'lima.yaml'), renderLimaTemplate({ cpus: 2, memoryGb: 2, diskGb: 10 }));
        let markerSeenInHome = false;
        let checkArgs: string[] = [];
        const rec = recorder((_c, a) => {
          if (!a.includes('checks')) return { code: 0 };
          checkArgs = a.slice(a.indexOf('checks') + 1);
          markerSeenInHome = fs.existsSync(path.join(home, checkArgs[checkArgs.indexOf('--owner-marker') + 1]));
          return { code: 0, stdout: REQUIRED_CHECKS_COMMON.map((n) => `CHECK ${n} pass`).join('\n') };
        });
        const d = new LimaDriver({ runner: rec, limactl: '/agent/.instar/helper/lima/bin/limactl', helperHome: home });
        const report = await d.checks({ credentialDigests: [sha256(TOKEN), 'not-a-digest', TOKEN] });
        const arg = (name: string): string => checkArgs[checkArgs.indexOf(name) + 1];
        // The marker was a real file in the owner's home while the sandbox was asked to look for it, and is gone afterwards.
        expect(arg('--owner-marker')).toMatch(/^\.instar-helper-marker-[0-9a-f]{12}$/);
        expect(markerSeenInHome).toBe(true);
        expect(fs.readdirSync(home).filter((n) => n.startsWith('.instar-helper-marker'))).toEqual([]);
        // Only the digest of the token crosses; a value that is not a digest (the token itself, here) is dropped.
        expect(arg('--credential-digests')).toBe(sha256(TOKEN));
        expect(checkArgs.join(' ')).not.toContain(TOKEN);
        expect(arg('--owner-user')).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
        // The paired network test's listeners: an address of each kind, or `none` when this host has none.
        expect(arg('--host-iface-addr')).toMatch(/^(none|\d+\.\d+\.\d+\.\d+)$/);
        expect(arg('--host-tailnet-addr')).toMatch(/^(none|100\.\d+\.\d+\.\d+)$/);
        const byName = new Map(report.checks.map((c) => [c.name, c]));
        // With no tailnet address on this host the check cannot run, whatever the sandbox printed: never a pass by default.
        if (arg('--host-tailnet-addr') === 'none') expect(byName.get('testns-no-route-tailnet-listener')).toMatchObject({ result: 'unrunnable', detail: 'no tailnet address on this host' });
        else expect(['pass', 'fail']).toContain(byName.get('testns-no-route-tailnet-listener')?.result);
        if (arg('--host-iface-addr') === 'none') expect(byName.get('testns-no-route-lan')).toMatchObject({ result: 'unrunnable' });
        // Every facet of the property is in the report this start produced.
        for (const n of SANDBOX_PROPERTY_CHECKS) expect(byName.get(n)?.result, n).toBe('pass');
        expect(byName.get('config-no-mounts')?.result).toBe('pass');
        assertEnvClean(rec.calls.filter((c) => c.args.includes('checks')));
      } finally {
        if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      }
    });
  });

  it('the allow-list is short and holds no credential variable; a variable not on it is never carried', () => {
    expect(CONTROL_ENV_ALLOW).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL']);
    const env = controlChannelEnv({ PATH: '/usr/bin', HOME: '/Users/justin', ...LEAKY, SSH_AGENT_PID: '9' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/justin' });
    expect(controlChannelEnv({ PATH: '/p', WSL_INTEROP: '/run/WSL/1_interop', GH_TOKEN: TOKEN }, ['WSL_INTEROP'], { WSLENV: '' })).toEqual({ PATH: '/p', WSL_INTEROP: '/run/WSL/1_interop', WSLENV: '' });
  });

  it('the start-up check carries only the DIGEST of the helper\'s token into the sandbox', () => {
    const digests = credentialDigestsOf(() => TOKEN)();
    expect(digests).toEqual([sha256(TOKEN)]);
    expect(digests.join(',')).not.toContain(TOKEN);
    expect(credentialDigestsOf(() => null)()).toEqual([]);
    // The driver passes what it was given as digests, and refuses anything that is not one.
    const base = fs.readFileSync(path.join(path.dirname(helperTemplatePath('x')), '..', '..', 'localVerify', 'helper', 'runnerDriverBase.ts'), 'utf-8');
    expect(base).toContain("'--credential-digests', digests.length > 0 ? digests.join(',') : 'none'");
    expect(base).toContain('.filter((d) => SHA256_HEX_RE.test(d))');
  });

  it('code that runs as tester or builder starts from an empty environment, without privileges, and never from the runner\'s own', () => {
    const runner = readHelperTemplate('instar-helper-runner.sh');
    const execs = runner.split('\n').map((l, i, all) => (l.includes('exec chroot') ? `${l}\n${all[i + 1] ?? ''}` : null)).filter((x): x is string => x !== null);
    // install, build, test, and the check script's ns-exec.
    expect(execs).toHaveLength(4);
    for (const e of execs) {
      expect(e).toContain('setpriv --reuid=');
      expect(e).toContain('--clear-groups --no-new-privs');
      expect(e).toContain('env -i PATH=/usr/local/bin:/usr/bin:/bin');
      expect(e).not.toMatch(/TOKEN|SECRET|SSH_AUTH_SOCK|PASSWORD/);
    }
    // The tree is the only way code enters, and it is a tar on stdin: no command takes a host path.
    expect(runner).not.toMatch(/mount -t (virtiofs|9p|drvfs)/);
  });

  it('the helper\'s GitHub token is read in one place on the host, and no sandbox driver can reach it', () => {
    const dir = path.join(path.dirname(helperTemplatePath('x')), '..', '..', 'localVerify', 'helper');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    const naming = files.filter((f) => fs.readFileSync(path.join(dir, f), 'utf-8').includes('HELPER_GITHUB_TOKEN_KEY'));
    expect(naming).toEqual(['hostTree.ts']);
    // The token reader is used by the wiring only: for the GitHub checks, and for the digest.
    const users = files.filter((f) => /\bsecretStoreToken\b/.test(fs.readFileSync(path.join(dir, f), 'utf-8'))).sort();
    expect(users).toEqual(['helperWiring.ts', 'hostTree.ts']);
    // The drivers and the command runner import neither the token reader nor the secret store.
    for (const f of ['runnerDriverBase.ts', 'limaDriver.ts', 'wslDriver.ts', 'sandboxDriver.ts', 'commandRunner.ts', 'testBypassDriver.ts']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf-8');
      expect(src, f).not.toMatch(/from '\.\/hostTree\.js'/);
      expect(src, f).not.toContain('SecretStore');
      expect(src, f).not.toContain('secretStoreToken');
    }
  });
});
