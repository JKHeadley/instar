#!/usr/bin/env node
// The sandbox property probe of a borrowed-machine helper
// (docs/specs/local-verify-borrowed-slices-count.md, "Tests", sandbox property: a condition of the
// design's approval).
//
// THE PROPERTY: from inside the sandbox, as `tester` or as `builder`, no host path is readable and
// no host credential is reachable.
//
// Installed at /usr/local/lib/instar-helper/property-probe.cjs (root:root 0644), outside every
// tree. The check script (instar-helper-checks.sh) runs it at EVERY sandbox start, once as tester
// inside a test namespace's view and once as builder inside the build's view, and once more as
// root on its own environment (`--env-only`: what the host's control channel handed the sandbox).
// The unit suite runs this same file against made-up views (`--root <dir>`), so the assertions
// that guard a real sandbox are the ones the suite exercises.
//
// It prints one line per facet, `PROBE <facet> ok` or `PROBE <facet> found <what>`:
//   no-host-path-readable  the marker file the helper service just created in the owner's home is
//                          not found by name anywhere; no mounted file system is of a host-folder
//                          type; no host home folder exists (/Users, /Volumes, /mnt/c, /mnt/wsl,
//                          the owner's own /home/<name>)
//   no-github-token        no environment variable (this process's, or any process's it can read)
//                          has a credential-like name, a value shaped like a GitHub token, or a
//                          value or command-line argument whose sha256 is one of the given digests
//                          (the helper's GitHub token, of which only the digest is passed in)
//   no-secret-store        no agent state folder, secret store file or credential folder exists
//                          (.instar, config.secrets.enc, secrets-master.key, .ssh, .gnupg, .aws,
//                          .netrc, .git-credentials, gh's hosts.yml, a keychain)
//   no-agent-socket        no SSH-agent, GPG-agent, keychain or desktop-bus variable is set, and no
//                          unix socket at all is visible
// and one line for its POSITIVE CONTROL, `PROBE control ok` or `PROBE control failed <which>`: it
// plants one finding of each kind in its own scratch space (a `pc-…` folder under the view's
// private /tmp, discarded with the namespace) and its own copy of the environment, runs the very
// same searches, and must find all four. A search that finds nothing proves nothing
// unless the same search finds what is there. The check script passes a facet only beside
// `PROBE control ok`.
//
// Exit code 0 whenever it could run to the end (the lines carry the verdict); 2 on a bad argument.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const FACETS = ['no-host-path-readable', 'no-github-token', 'no-secret-store', 'no-agent-socket'];

// File system types that show a HOST folder inside a guest (Lima's virtiofs/9p/sshfs mounts, WSL's
// drvfs, shared folders of other virtual machines, network shares).
const HOST_FS_TYPE = /^(virtiofs|9p|drvfs|sshfs|fuse\.sshfs|vboxsf|vmhgfs|fuse\.vmhgfs-fuse|prl_fs|cifs|smb3|nfs|nfs4|apfs|hfs|hfsplus|ntfs|ntfs3|fuseblk)$/;
// Folders that exist only when a host's files are visible.
const HOST_DIRS = ['Users', 'Volumes', 'mnt/c', 'mnt/d', 'mnt/wsl', 'mnt/wslg', 'mnt/host', 'host', 'run/host-services'];
// Names that are an agent's state, its secret store, or a user's credentials, wherever they sit.
const SECRET_NAMES = new Set(['.instar', 'config.secrets.enc', 'secrets-master.key', '.ssh', '.gnupg', '.aws', '.netrc', '.git-credentials', '.docker', 'login.keychain-db', 'Keychains', '.claude', '.codex']);
// Variable names that hold a credential or point at an agent that would hand one out.
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTHORIZATION|BEARER)/i;
// (Windows interop has its own check in the check script, `no-windows-interop`.)
const AGENT_VARS = ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO', 'GNOME_KEYRING_CONTROL', 'DBUS_SESSION_BUS_ADDRESS', 'DOCKER_HOST'];
// The shapes of GitHub's tokens (classic, fine-grained, app, OAuth, refresh).
const GITHUB_TOKEN_SHAPE = /(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/;
// Pseudo file systems a walk never enters: they are not files of any machine.
const SKIP_TOP = new Set(['proc', 'sys', 'dev']);
const WALK_MAX_ENTRIES = 2_000_000;

function parseArgs(argv) {
  const o = { marker: 'none', ownerUser: 'none', digests: [], root: '/', mountsFile: null, envOnly: false, procDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) throw new Error(`missing value for ${a}`); return argv[i]; };
    if (a === '--marker') o.marker = next();
    else if (a === '--owner-user') o.ownerUser = next();
    else if (a === '--digests') { const v = next(); o.digests = v === 'none' ? [] : v.split(',').filter((d) => /^[0-9a-f]{64}$/.test(d)); }
    else if (a === '--root') o.root = next();
    else if (a === '--mounts-file') o.mountsFile = next();
    else if (a === '--proc-dir') o.procDir = next();
    else if (a === '--env-only') o.envOnly = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(o.marker)) throw new Error('bad marker');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.ownerUser)) throw new Error('bad owner user');
  return o;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Walk everything under `root` that this process can list, without following links; `visit(full, name, dirent)`. */
function walk(root, visit) {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; } // a folder this user may not list holds nothing this user can read
    for (const e of entries) {
      if (++seen > WALK_MAX_ENTRIES) return false;
      const full = path.join(dir, e.name);
      if (dir === root && SKIP_TOP.has(e.name)) continue;
      visit(full, e.name, e);
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(full);
    }
  }
  return true;
}

/** Each readable process's environment and command line under a proc folder: [{ where, env, args }]. */
function processFacts(procDir) {
  const out = [];
  let pids;
  try { pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids.slice(0, 5000)) {
    const one = { where: `pid ${pid}`, env: {}, args: [] };
    try {
      for (const kv of fs.readFileSync(path.join(procDir, pid, 'environ'), 'utf8').split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0) one.env[kv.slice(0, i)] = kv.slice(i + 1);
      }
    } catch { /* another user's process: its environment is not readable, which is the point */ }
    try { one.args = fs.readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { /* gone */ }
    out.push(one);
  }
  return out;
}

/** The four searches over one view. Returns { facet: [findings] }. */
function scan(view) {
  const found = { 'no-host-path-readable': [], 'no-github-token': [], 'no-secret-store': [], 'no-agent-socket': [] };
  const add = (facet, what) => { if (found[facet].length < 5) found[facet].push(what); };
  const rel = (p) => `/${path.relative(view.root, p)}`;

  // Credentials in an environment or on a command line.
  const procs = [{ where: 'own environment', env: view.env, args: view.args }, ...view.procs];
  for (const p of procs) {
    for (const [k, v] of Object.entries(p.env)) {
      if (CREDENTIAL_NAME.test(k)) add('no-github-token', `variable ${k} (${p.where})`);
      else if (typeof v === 'string' && GITHUB_TOKEN_SHAPE.test(v)) add('no-github-token', `token-shaped value in ${k} (${p.where})`);
      else if (typeof v === 'string' && v.length > 0 && view.digests.includes(sha256(v))) add('no-github-token', `the helper's token in ${k} (${p.where})`);
      if (AGENT_VARS.includes(k)) add('no-agent-socket', `variable ${k} (${p.where})`);
    }
    for (const a of p.args) {
      if (GITHUB_TOKEN_SHAPE.test(a)) add('no-github-token', `token-shaped argument (${p.where})`);
      else if (view.digests.includes(sha256(a))) add('no-github-token', `the helper's token on a command line (${p.where})`);
    }
  }
  if (view.envOnly) return found;

  // Mounted file systems of a host-folder type.
  let mounts = null;
  try { mounts = fs.readFileSync(view.mountsFile, 'utf8'); } catch { add('no-host-path-readable', 'the mount table is not readable'); }
  for (const line of (mounts || '').split('\n')) {
    const f = line.split(' ');
    if (f.length >= 3 && HOST_FS_TYPE.test(f[2])) add('no-host-path-readable', `${f[2]} mounted at ${f[1]}`);
  }
  // Host home folders.
  const dirs = [...HOST_DIRS];
  if (view.ownerUser !== 'none') dirs.push(`home/${view.ownerUser}`, `Users/${view.ownerUser}`);
  for (const d of dirs) {
    try { fs.lstatSync(path.join(view.root, d)); add('no-host-path-readable', `/${d} exists`); } catch { /* absent, as it must be */ }
  }
  // One walk for the marker file, the secret-store names and every socket.
  const complete = walk(view.root, (full, name, e) => {
    if (view.marker !== 'none' && name === view.marker) add('no-host-path-readable', `the owner's marker file at ${rel(full)}`);
    if (SECRET_NAMES.has(name)) add('no-secret-store', rel(full));
    if (name === 'hosts.yml' && path.basename(path.dirname(full)) === 'gh') add('no-secret-store', rel(full));
    if (e.isSocket()) add('no-agent-socket', `socket ${rel(full)}`);
  });
  if (!complete) for (const f of ['no-host-path-readable', 'no-secret-store', 'no-agent-socket']) add(f, 'the view is too large to search completely');
  return found;
}

/** Plant one finding of each kind and require the same searches to find all four. Returns the kinds missed. */
function control(view) {
  const scratchParent = [path.join(view.root, 'tmp'), path.join(view.root, 'work')].find((d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } });
  const missed = [];
  const planted = sha256(`control:${process.pid}:${Date.now()}`);
  const env = { ...view.env, INSTAR_PROBE_CONTROL_TOKEN: 'x', INSTAR_PROBE_CONTROL: planted, SSH_AUTH_SOCK: '/nonexistent/agent.control' };
  if (view.envOnly) {
    const f = scan({ ...view, env, digests: [...view.digests, sha256(planted)] });
    if (!f['no-github-token'].some((w) => w.includes('INSTAR_PROBE_CONTROL_TOKEN'))) missed.push('credential-name');
    if (!f['no-github-token'].some((w) => w.includes('INSTAR_PROBE_CONTROL (own environment)'))) missed.push('credential-digest');
    if (f['no-agent-socket'].length === 0) missed.push('agent-variable');
    return missed;
  }
  if (!scratchParent) return ['no-writable-scratch'];
  let dir = null;
  let server = null;
  try {
    // Short names: a unix socket's path has a small fixed limit.
    dir = fs.mkdtempSync(path.join(scratchParent, 'pc-'));
    const marker = view.marker !== 'none' ? view.marker : `.instar-helper-marker-control-${process.pid}`;
    fs.writeFileSync(path.join(dir, marker), 'control\n');
    fs.mkdirSync(path.join(dir, '.instar', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.instar', 'secrets', 'config.secrets.enc'), 'control\n');
    let socketPlanted = false;
    try {
      // A bound unix socket, created synchronously through a listening server's handle.
      server = net.createServer();
      server.on('error', () => undefined);
      server.listen(path.join(dir, 'a.sock'));
      socketPlanted = fs.existsSync(path.join(dir, 'a.sock'));
    } catch { socketPlanted = false; }
    const f = scan({ ...view, marker, env, digests: [...view.digests, sha256(planted)] });
    if (!f['no-host-path-readable'].some((w) => w.includes('marker file'))) missed.push('marker-file');
    if (!f['no-secret-store'].some((w) => w.includes('.instar'))) missed.push('secret-store');
    if (!f['no-github-token'].some((w) => w.includes('INSTAR_PROBE_CONTROL_TOKEN'))) missed.push('credential-name');
    if (!f['no-github-token'].some((w) => w.includes('INSTAR_PROBE_CONTROL (own environment)'))) missed.push('credential-digest');
    if (!f['no-agent-socket'].some((w) => w.includes('SSH_AUTH_SOCK'))) missed.push('agent-variable');
    if (!socketPlanted || !f['no-agent-socket'].some((w) => w.includes('a.sock'))) missed.push('socket');
  } catch (e) {
    missed.push(`control-error:${String(e && e.message ? e.message : e).slice(0, 80)}`);
  } finally {
    try { if (server) server.close(); } catch { /* closing */ }
    // What was planted stays in the probe's own scratch folder (`pc-…`): in the sandbox that folder
    // is a private /tmp that is thrown away with the namespace the moment this probe exits, and
    // the probe deletes nothing itself.
  }
  return missed;
}

function main(argv, env) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`property-probe: ${e.message}\n`); return 2; }
  const procDir = o.procDir || path.join(o.root, 'proc');
  const view = {
    root: path.resolve(o.root), marker: o.marker, ownerUser: o.ownerUser, digests: o.digests, envOnly: o.envOnly,
    mountsFile: o.mountsFile || path.join(procDir, 'mounts'),
    env: { ...env }, args: [], procs: o.envOnly ? [] : processFacts(procDir),
  };
  // The real search first, on the view as it is; then the control, which plants and removes its own findings.
  const found = scan(view);
  const missed = control(view);
  for (const f of FACETS) {
    if (o.envOnly && (f === 'no-host-path-readable' || f === 'no-secret-store')) continue;
    process.stdout.write(found[f].length === 0 ? `PROBE ${f} ok\n` : `PROBE ${f} found ${found[f].join('; ').slice(0, 300)}\n`);
  }
  process.stdout.write(missed.length === 0 ? 'PROBE control ok\n' : `PROBE control failed ${missed.join(',')}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env);
module.exports = { main, scan, control, parseArgs, FACETS };
