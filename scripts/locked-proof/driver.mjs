#!/usr/bin/env node
// safe-git-allow: no git at all; process signals and file reads go through sudo against the throwaway proof user only.
/**
 * Locked-Mac proof driver (docs/specs/desktop-locked-screen.md, P12 + P15).
 *
 *   node scripts/locked-proof/driver.mjs expected                      # print the expected-results table (commit it before any run)
 *   node scripts/locked-proof/driver.mjs calibrate --execute [opts]    # one normal unlock: measures the typing pace
 *   node scripts/locked-proof/driver.mjs run --execute [--cases 12.1,P15] [opts]
 *
 * Before any run: stage-proof-agents.sh --tgz, then --start, then --finalize (all three, in
 * that order). The driver refuses to start while a proof agent lacks its dashboard PIN or is
 * not yet its own desktop front, and names the --finalize step.
 *
 * Options:
 *   --agent-home DIR     the operator-side agent home holding the vault (secret-get.mjs)  [required for calibrate/run]
 *   --proof-dir DIR      proof agent A's project directory (default /Users/instarproof/.instar/agents/locked-proof)
 *   --proof-dir-b DIR    proof agent B's directory (default .../locked-proof-b)
 *   --port N / --port-b N  proof agents' ports (default 4098 / 4097)
 *   --playwright DIR     a playwright-core install to drive the real viewer page with system Chrome
 *   --out DIR            results + calibration folder (default ./locked-proof-results)
 *   --notify-topic N     also send person steps to this Telegram topic through the agent's relay script
 *   --headed             show the viewer browser
 *
 * Without --execute nothing touches the Mac: `calibrate` and `run` print what they would do.
 * Who types: this driver, through the real viewer page, with the throwaway user's password
 * read once from the vault (key locked_proof_user_password) into memory. It is never printed,
 * logged, written to a results file, or passed on a command line.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BLOCKING, PROOF_USER, TERMINAL, VAULT_KEY, assertProofTarget, launchdServePlist, renderExpected, runCase, selectCases } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The viewer is ready when it offers a request or has already opened the stream. */
// Playwright waits on the FIRST element a selector list resolves to. An auto-opened page keeps an
// enabled but hidden #requestButton ahead of #control, so every alternative must be :visible.
export const VIEWER_READY = '#requestButton:not([disabled]):visible, #control:visible';
const LOCK_PY = 'import ctypes; ctypes.CDLL("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login").SACLockScreenImmediate()';

function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

function sh(cmd, args, { allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout: 30_000 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  return r.stdout ?? '';
}
const sudo = (args, o) => sh('sudo', ['-n', ...args], o);
/**
 * What setup still owes before a run, one line each. A proof agent needs a
 * dashboard PIN (configure-proof-agent.mjs --pin-stdin, from the vault) and to
 * be its own desktop front, which only `stage-proof-agents.sh --finalize
 * --execute` records (it needs the machine id from the first server start).
 */
export function setupGaps(agents) {
  const gaps = [];
  for (const [dir, config] of agents) {
    if (typeof config.dashboardPin !== 'string' || !config.dashboardPin) {
      gaps.push(`${dir}: no dashboard PIN. Run stage-proof-agents.sh --finalize --agent-home DIR --execute (the PIN comes from the vault).`);
    }
    if (!config.remoteDesktop?.frontMachineId) {
      gaps.push(`${dir}: not its own desktop front yet. Run stage-proof-agents.sh --finalize --agent-home DIR --execute after --start.`);
    }
  }
  return gaps;
}

/** The login name owning a pid, or '' when it is gone. */
export function ownerOf(pid) { return sh('ps', ['-o', 'user=', '-p', String(pid)], { allowFail: true }).trim(); }

/**
 * Sends one person step and writes down whether it went. A refused send used to
 * vanish, so a person was never told and the case simply timed out; now the
 * refusal is in person-steps.jsonl and on stderr for whoever is watching the run.
 */
export function recordPersonStep(o, text, send) {
  const result = o.notifyTopic ? send() : null;
  const sent = result ? result.status === 0 : false;
  const row = { at: new Date().toISOString(), text, topic: o.notifyTopic ?? null, sent };
  fs.appendFileSync(path.join(o.out, 'person-steps.jsonl'), `${JSON.stringify(row)}\n`);
  if (o.notifyTopic && !sent) process.stderr.write(`[locked-proof] person step NOT delivered to topic ${o.notifyTopic}: ${text}\n`);
  return row;
}

/** The proof Mac, the proof user, its two agents and the real viewer page. */
export class RealTarget {
  constructor(o) {
    this.o = o;
    this.uid = sh('id', ['-u', PROOF_USER]).trim();
    this.store = `/Users/${PROOF_USER}/.instar/desktop-helper/locked`;
    this.events = new Set();
    this.pids = {};
    this.viewers = [];
    this.stopper = null;
    /** Every pid this run SIGSTOPped and has not resumed or killed. */
    this.stopped = new Set();
  }

  now() { return Date.now(); }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  agentConfig(dir) { return JSON.parse(sudo(['cat', path.join(dir, '.instar', 'config.json')])); }

  async init() {
    const configA = this.agentConfig(this.o.proofDir);
    const configB = this.agentConfig(this.o.proofDirB);
    const missing = setupGaps([[this.o.proofDir, configA], [this.o.proofDirB, configB]]);
    if (missing.length) throw new Error(missing.join('\n'));
    this.a = { port: this.o.port, dir: this.o.proofDir, ...this.pick(configA) };
    this.b = { port: this.o.portB, dir: this.o.proofDirB, ...this.pick(configB) };
    for (const agent of [this.a, this.b]) {
      const health = await this.api(agent, 'GET', '/health');
      // The real owner of the process answering on this port, not a constant.
      const pid = Number(sudo(['lsof', '-nP', '-t', `-iTCP:${agent.port}`, '-sTCP:LISTEN'], { allowFail: true }).trim().split('\n')[0]) || null;
      assertProofTarget({ user: pid ? ownerOf(pid) : '', version: health.version });
      assertProofTarget({ user: sh('stat', ['-f', '%Su', agent.dir]).trim(), version: health.version });
    }
    // Read once, kept in memory only. stdout is captured, stderr discarded (it names lengths).
    const value = execFileSync(process.execPath, [path.join(this.o.agentHome, '.instar/scripts/secret-get.mjs'), VAULT_KEY],
      { cwd: this.o.agentHome, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
    if (!value) throw new Error(`vault key ${VAULT_KEY} is empty`);
    Object.defineProperty(this, 'password', { value, enumerable: false });
    const calFile = path.join(this.o.out, 'calibration.json');
    this.cal = fs.existsSync(calFile) ? JSON.parse(fs.readFileSync(calFile, 'utf8')) : null;
    const { chromium } = createRequire(path.join(this.o.playwright, 'package.json'))('playwright-core');
    this.browser = await chromium.launch({ channel: 'chrome', headless: !this.o.headed });
  }

  pick(config) { return { token: config.authToken, pin: config.dashboardPin }; }

  async api(agent, method, route, body, headers = {}) {
    const r = await fetch(`http://127.0.0.1:${agent.port}${route}`, { method,
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1', ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5_000) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, ...(json ?? {}) };
  }

  async operatorSession(agent) {
    if (agent.session) return agent.session;
    const r = await fetch(`http://127.0.0.1:${agent.port}/dashboard/unlock`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: agent.pin }) });
    agent.session = (await r.json()).operatorSessionToken;
    return agent.session;
  }

  readStore() {
    const raw = sudo(['cat', path.join(this.store, 'locked-state.json')], { allowFail: true });
    try { return JSON.parse(raw); } catch { return {}; }
  }

  /**
   * This case's markers. Finished ones stay in the store for days with their lease and
   * heartbeat files, and would fire injections, settle the case and count as its evidence.
   */
  caseMarkers(state = this.readStore()) {
    const prior = this.priorMarkers ?? {};
    return Object.fromEntries(Object.entries(state.markers ?? {}).filter(([key, m]) => !(key in prior && prior[key] === m.requestId)));
  }

  consoleOwner() { return sh('stat', ['-f', '%Su', '/dev/console']).trim(); }

  processes() {
    return sudo(['ps', '-U', PROOF_USER, '-o', 'pid=,lstart=,command='], { allowFail: true }).split('\n')
      .map(line => line.match(/^\s*(\d+)\s+(\w{3} \w{3} +\d+ [\d:]+ \d{4})\s+(.*)$/)).filter(Boolean)
      .map(m => ({ pid: Number(m[1]), start: m[2], command: m[3] }));
  }

  async snapshot() {
    const state = this.readStore();
    const markers = this.caseMarkers(state);
    const procs = this.processes();
    const helper = procs.filter(p => p.command.includes('instar-desktop-host'));
    const guard = helper.find(p => p.command.includes('relock-guard'));
    const typist = helper.find(p => p.command.includes('input-stream'));
    const lockState = await this.readLockState();
    const serverLockState = await this.serverLockState();
    const now = this.now();
    for (const [key, m] of Object.entries(markers)) {
      if (spawnSync('sudo', ['-n', 'test', '-e', path.join(this.store, `lease-${key}`)]).status === 0) this.events.add('lease-written');
      if (spawnSync('sudo', ['-n', 'test', '-e', path.join(this.store, `hb-${key}`)]).status === 0) this.events.add('guard-acked');
      if (typeof m.deadlineMs === 'number' && m.deadlineMs < now) this.events.add('deadline-passed');
      if (this.pids.firstGuard && m.guardPid && m.guardPid !== this.pids.firstGuard) this.events.add('takeover');
    }
    if (guard) { this.events.add('guard-spawned'); this.pids.firstGuard ??= guard.pid; this.pids.guard = guard.pid; }
    if (typist) this.pids.typist = typist.pid;
    if (this.consoleOwner() === PROOF_USER) this.events.add('proof-user-console');
    return { now, markers, dirty: state.dirty !== undefined && state.dirty !== null, lockState, serverLockState, typistRunning: !!typist, guardPid: guard?.pid, events: [...this.events],
      // Judged only once a duty exists and has closed. With no duty at all, the input helper of a
      // live grant is not a leftover typist.
      processesGone: !Object.keys(markers).length || !Object.values(markers).every(m => TERMINAL.includes(m.state)) ? undefined : !guard && !typist, procs };
  }

  /** Agent A's lock reading; while A is down or suspended, agent B's (same user, same Mac). */
  /**
   * The Mac's own lock flag for the proof user's console session, read from IORegistry. It does
   * not pass through the servers under test, whose reading is a cache that only refreshes while
   * a viewer is connected. 'none' when the proof user holds no console session.
   */
  consoleLock() {
    const py = "import plistlib,sys,subprocess\nd=plistlib.loads(subprocess.run(['ioreg','-n','Root','-d1','-a'],capture_output=True).stdout)\n"
      + "u=[x for x in d.get('IOConsoleUsers',[]) if x.get('kCGSSessionUserNameKey')==sys.argv[1] and x.get('kCGSSessionOnConsoleKey')]\n"
      + "print(('locked' if u[0].get('CGSSessionScreenIsLocked') else 'open') if u else 'none')";
    return sh('python3', ['-c', py, PROOF_USER], { allowFail: true }).trim() || 'none';
  }

  /** What the servers report, for the record only: it can be stale, so no verdict rests on it. */
  async serverLockState() {
    for (const agent of [this.a, this.b]) {
      try {
        const st = await this.api(agent, 'GET', '/desktop/locked/status');
        // A server reads 'unknown' until something samples the lock; one that does not know
        // yet is skipped like one that is down.
        if (typeof st.lockState === 'string' && st.lockState !== 'unknown') return st.lockState;
      } catch { /* this agent is down or stopped; try the other */ }
    }
    return 'unknown';
  }

  async readLockState() {
    const own = this.consoleLock();
    if (own === 'locked') return 'locked-in-session';
    if (own === 'open') return 'unlocked';
    // No console session for the proof user (logged out, or switched away): only a server can say which.
    return this.serverLockState();
  }

  settled(snap, c) {
    const markers = Object.values(snap.markers);
    const closed = markers.length > 0 && markers.every(m => TERMINAL.includes(m.state));
    if (!closed) return false;
    if (snap.typistRunning || snap.guardPid) return false;
    return c.final === 'not-judged' || snap.lockState !== 'unknown';
  }

  calibration() { return this.cal; }

  async prepare(c) {
    await this.closeViewers();
    this.events.clear();
    this.pids = {};
    const until = this.now() + 180_000;
    while (Object.values(this.readStore().markers ?? {}).some(m => BLOCKING.includes(m.state))) {
      if (this.now() > until) throw new Error('a duty from the previous case is still open');
      await this.sleep(1_000);
    }
    this.priorMarkers = Object.fromEntries(Object.entries(this.readStore().markers ?? {}).map(([key, m]) => [key, m.requestId]));
    // Attempt counter reset under the helper's own lock (plan 4.4), audited.
    sudo(['-u', PROOF_USER, 'python3', path.join(HERE, 'reset-attempts.py'), '--execute', this.store]);
    fs.appendFileSync(path.join(this.o.out, 'attempt-resets.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), before: c.id })}\n`);
    if (await this.readLockState() !== 'locked-in-session') await this.act('lock-now', { case: c });
    await this.sleep(2_000);
  }

  async viewer(agent) {
    const context = await this.browser.newContext();
    const page = await context.newPage();
    const v = { agent, context, page, session: null };
    // The operator session this page is given. A request can only be revoked by the session that
    // opened it, so an out-of-band revoke has to use the page's session, not one of the driver's own.
    page.on('response', async r => {
      const url = r.url();
      if (url.includes('/dashboard/unlock')) {
        try { v.session = (await r.json()).operatorSessionToken ?? v.session; } catch { /* not this page's unlock answer */ }
      } else if (url.includes('/desktop/')) {
        // The server states when this grant ends. The deadline cases aim from that, because the
        // moment the driver sees the grant open trails the server's start by about half a second.
        try { const j = await r.json(); if (Number.isSafeInteger(j?.expiresAt)) v.expiresAt = j.expiresAt; } catch { /* not JSON */ }
      }
    });
    await page.goto(`http://127.0.0.1:${agent.port}/dashboard/desktop.html`);
    await page.fill('#pin', agent.pin);
    await page.click('#unlockButton');
    // desktop.js opens the stream by itself when exactly one machine is ready,
    // keeping #request hidden; either outcome means the page is ready.
    await page.waitForSelector(VIEWER_READY, { timeout: 20_000 });
    this.viewers.push(v);
    return v;
  }

  /** Asks for a grant only when the page has not already opened one itself. */
  async requestGrant(v) {
    if (await v.page.isVisible('#control').catch(() => false)) return { clicked: false };
    await v.page.click('#requestButton');
    return { clicked: true };
  }

  async openGrant(c) {
    const v = await this.viewer(this.a);
    await this.requestGrant(v);
    await v.page.waitForSelector('#control:not([hidden])', { timeout: 30_000 });
    this.main = v;
    this.mainOpenedAt = this.now();
    return v;
  }

  /** Types the password through the real viewer box, as an owner would. */
  async typePassword(c) {
    const page = this.main.page;
    await page.waitForSelector('#lockedPassword:not([hidden])', { timeout: 30_000 });
    if (c.timing === 'deadline' && this.cal) {
      // Land Enter just after (before-enter case) or just before (after-enter case) the 10-minute ceiling.
      const opened = this.mainOpenedAt ?? this.now();
      // The ceiling is the server's own expiry for this grant when the page was told it; the
      // driver's view of "opened + 10 minutes" runs about 0.6 s late (measured over 33 duties).
      // "Deadline before Enter": start 0.6 s ahead, so the duty exists before the ceiling and the
      // 0.7 s of typing straddles it. "Deadline after Enter": finish typing 1.5 s ahead.
      const typingMs = this.cal.reserveMs + this.cal.perCharMs * this.password.length;
      const ceiling = this.main?.expiresAt ?? (opened + 600_000);
      const startAt = ceiling - (c.inject[0].at === 'before-enter' ? 600 : 1_500 + typingMs);
      await this.sleep(Math.max(0, startAt - this.now()));
    }
    // Delayed-completion cases need an open duty with the Mac still locked: a refused password
    // gives that without a test build holding the submission back, and the person unlocks later.
    await page.fill('#lockedPasswordInput', c.wrongPassword ? `${this.password}x` : this.password);
    await page.press('#lockedPasswordInput', 'Enter');
    const until = this.now() + 60_000;
    // What the page said while we waited, in order. When nothing is recognised as an answer,
    // this is the only record of what the person would have seen.
    const said = [];
    while (this.now() < until) {
      if (await page.isVisible('#leaveUnlockedButton')) return { sent: true };
      const text = ((await page.textContent('#status').catch(() => '')) ?? '').trim();
      if (text && said[said.length - 1] !== text) said.push(text);
      const refused = refusalFromStatus(text);
      if (refused) return { refused };
      await this.sleep(200);
    }
    return { sent: false, refused: 'no-result-within-60s', pageSaid: said.slice(-6) };
  }

  /** The proof user's listening process on the port, and only that user's (lsof -a ANDs the filters). */
  serverPid(agent) {
    const pid = Number(sudo(['lsof', '-a', '-u', PROOF_USER, '-nP', '-t', `-iTCP:${agent.port}`, '-sTCP:LISTEN'], { allowFail: true }).trim().split('\n')[0]) || null;
    return pid && ownerOf(pid) === PROOF_USER ? pid : null;
  }

  /** Signals only a process the proof user owns, checked immediately before each signal. */
  kill(pid, sig) {
    if (!pid) return { pid: null, sig, skipped: 'no-pid' };
    const owner = ownerOf(pid);
    // Resuming a process that has already exited is not an error; stopping or killing nothing is.
    if (!owner && sig === 'CONT') { this.stopped.delete(pid); return { pid, sig, skipped: 'gone' }; }
    if (owner !== PROOF_USER) throw new Error(`refusing to signal pid ${pid}: owned by "${owner || 'nobody'}", not ${PROOF_USER}`);
    sudo(['kill', `-${sig}`, String(pid)], { allowFail: true });
    if (sig === 'STOP') this.stopped.add(pid);
    if (sig === 'CONT' || sig === 'KILL') this.stopped.delete(pid);
    return { pid, sig };
  }

  /**
   * After every case, thrown or not: resume everything this run stopped, stop the
   * guard-stopper, then lock the proof session. Errors here are collected, never thrown.
   */
  async recover() {
    const problems = [];
    if (this.stopper) { clearInterval(this.stopper); this.stopper = null; }
    if (this.launchdJob) {
      try { this.endLaunchdServe(); await this.act('start-server', {}); }
      catch (err) { problems.push(`launchd job: ${err instanceof Error ? err.message : String(err)}`); }
    }
    for (const pid of [...this.stopped]) {
      try { this.kill(pid, 'CONT'); } catch (err) { problems.push(String(err instanceof Error ? err.message : err)); this.stopped.delete(pid); }
    }
    try { if (await this.readLockState() !== 'locked-in-session') await this.act('lock-now', {}); }
    catch (err) { problems.push(`lock-now: ${err instanceof Error ? err.message : String(err)}`); }
    return problems;
  }

  /** Moves agent A's server from tmux to its own launchd job, so launchd-kill has a real target. */
  async serveUnderLaunchd() {
    const dir = this.a.dir;
    const home = `/Users/${PROOF_USER}/.instar`;
    const label = `ai.instar.lockedproof.${path.basename(dir)}`;
    const plist = path.join(home, `${label}.plist`);
    const staged = path.join(this.o.out, `${label}.plist`);
    // Set first, so recover() restores the server if anything below throws. A job left by a
    // driver that died mid-case would hold the port, so it goes before the stop.
    this.launchdJob = { label, plist };
    this.endLaunchdServe();
    this.launchdJob = { label, plist };
    this.asProof([path.join(this.o.proofInstall, 'node_modules/.bin/instar'), 'server', 'stop', '--dir', dir]);
    await this.waitForServer(false, 60_000);
    fs.writeFileSync(staged, launchdServePlist({
      label, dir, node: process.execPath, cli: path.join(this.o.proofInstall, 'node_modules/instar/dist/cli.js'),
      pathEnv: process.env.PATH ?? '/usr/bin:/bin', log: path.join(home, `${label}.log`),
    }));
    sudo(['install', '-o', PROOF_USER, '-m', '644', staged, plist]);
    sudo(['launchctl', 'bootstrap', `gui/${this.uid}`, plist]);
    const pid = await this.waitForServer(true, 90_000);
    return { label, pid, lockStateKnown: await this.waitLockStateKnown() };
  }

  /**
   * Throws unless the server under the job really died and the relock guard outlived it:
   * launchd reaps a job's process group, and the guard has to stand outside that group.
   */
  async launchdKill() {
    if (!this.launchdJob) throw new Error('launchd-kill: no launchd job is serving this agent');
    const pid = this.serverPid(this.a);
    if (!pid) throw new Error('launchd-kill: no server is running under the job');
    const guards = () => this.processes().filter(p => p.command.includes('instar-desktop-host') && p.command.includes('relock-guard')).map(p => p.pid);
    const guardPid = guards()[0];
    if (!guardPid) throw new Error('launchd-kill: no relock guard running before the kill');
    this.signalJob(this.launchdJob.label);
    await this.waitForServer(false, 15_000);
    await this.sleep(2_000); // launchd reaps the group after the main process exits.
    if (!guards().includes(guardPid)) throw new Error(`launchd-kill: relock guard ${guardPid} did not survive the kill`);
    return { label: this.launchdJob.label, killedPid: pid, guardPid, guardSurvived: true };
  }

  signalJob(label) { sudo(['launchctl', 'kill', 'SIGKILL', `gui/${this.uid}/${label}`], { allowFail: true }); }

  /** Removes the job, so start-server can put the agent back in tmux. */
  endLaunchdServe() {
    if (!this.launchdJob) return { removed: null };
    const { label, plist } = this.launchdJob;
    sudo(['launchctl', 'bootout', `gui/${this.uid}/${label}`], { allowFail: true });
    sudo(['rm', '-f', plist], { allowFail: true });
    this.launchdJob = null;
    return { removed: label };
  }

  /** `ps` state letters for one pid: a stopped process starts with T. Empty when it is gone. */
  procStat(pid) { return sh('ps', ['-o', 'stat=', '-p', String(pid)], { allowFail: true }).trim(); }

  /**
   * Listening is not ready: a freshly started server reads 'unknown' for about a minute, and the
   * viewer page has no machine to offer until it knows. False after the wait is evidence, not an error.
   */
  async waitLockStateKnown(ms = 120_000) {
    const until = this.now() + ms;
    while (this.now() < until) {
      const st = await this.api(this.a, 'GET', '/desktop/locked/status').catch(() => null);
      if (typeof st?.lockState === 'string' && st.lockState !== 'unknown') return true;
      await this.sleep(1_000);
    }
    return false;
  }

  async waitForServer(up, ms) {
    const until = this.now() + ms;
    while (this.now() < until) {
      const pid = this.serverPid(this.a);
      if (!!pid === up) return pid;
      await this.sleep(500);
    }
    throw new Error(`server on port ${this.a.port} did not ${up ? 'start' : 'stop'} within ${ms} ms`);
  }

  asProof(args) { return sudo(['launchctl', 'asuser', this.uid, 'sudo', '-u', PROOF_USER, '-H', ...args], { allowFail: true }); }

  async act(action, { step } = {}) {
    const helper = () => this.processes().filter(p => p.command.includes('instar-desktop-host'));
    switch (action) {
      case 'stop-server': {
        const r = this.kill(this.pids.server = this.serverPid(this.a), 'STOP');
        // tmux resumes a stopped pane process at once, so a case that believes it froze the
        // server would be judging a server that never stopped. Prove the stop held.
        await this.sleep(500);
        const stat = r.pid ? this.procStat(r.pid) : '';
        if (!stat.startsWith('T')) throw new Error(`stop-server: pid ${r.pid} did not stay stopped (state "${stat}"); serve it under launchd first`);
        return { ...r, stat };
      }
      case 'cont-server': return this.kill(this.pids.server, 'CONT');
      case 'kill-server': return this.kill(this.serverPid(this.a), 'KILL');
      case 'start-server': {
        // Both agents share the proof user's tmux server, so kill-tmux takes agent B down too,
        // and with B down nothing answers while A is down. Every start leaves both listening.
        const started = [];
        for (const agent of [this.a, this.b]) {
          // Agent A is always started: this step follows a kill or a launchd bootout, and a server
          // that is still shutting down can hold the port for a moment and look alive.
          if (agent !== this.a && this.serverPid(agent)) continue;
          this.asProof([path.join(this.o.proofInstall, 'node_modules/.bin/instar'), 'server', 'start', '--dir', agent.dir]);
          const until = this.now() + 60_000;
          while (this.now() < until && !this.serverPid(agent)) await this.sleep(1_000);
          if (!this.serverPid(agent)) throw new Error(`start-server: nothing listening on port ${agent.port} after 60 s`);
          started.push(agent.port);
        }
        return { started: true, ports: started, lockStateKnown: await this.waitLockStateKnown() };
      }
      case 'kill-tmux': return { out: this.asProof(['tmux', 'kill-server']) };
      case 'serve-under-launchd': return this.serveUnderLaunchd();
      case 'launchd-kill': return this.launchdKill();
      case 'end-launchd-serve': return this.endLaunchdServe();
      case 'kill-guard': return this.kill(this.pids.killedGuard = helper().find(p => p.command.includes('relock-guard'))?.pid, 'KILL');
      case 'stop-guard': return this.kill(this.pids.stoppedGuard = helper().find(p => p.command.includes('relock-guard'))?.pid, 'STOP');
      case 'cont-old-guard': return this.kill(this.pids.stoppedGuard, 'CONT');
      case 'kill-helper': return this.kill(helper().find(p => !p.command.includes('relock-guard') && !p.command.includes('input-stream'))?.pid, 'KILL');
      case 'stop-typist': return this.kill(this.pids.stoppedTypist = helper().find(p => p.command.includes('input-stream'))?.pid, 'STOP');
      case 'cont-typist': return this.kill(this.pids.stoppedTypist, 'CONT');
      case 'stop-new-guards':
        this.stopper = setInterval(() => {
          for (const p of helper().filter(x => x.command.includes('relock-guard'))) this.kill(p.pid, 'STOP');
        }, 50);
        return { watching: true };
      case 'cont-guards':
        if (this.stopper) clearInterval(this.stopper);
        this.stopper = null;
        for (const p of helper().filter(x => x.command.includes('relock-guard'))) this.kill(p.pid, 'CONT');
        return { released: true };
      case 'revoke': {
        const requestId = Object.values(this.caseMarkers()).find(m => m.requestId)?.requestId;
        if (!requestId) throw new Error('revoke: this case has no open request to revoke');
        const session = this.main?.session ?? await this.operatorSession(this.a);
        const r = await this.api(this.a, 'POST', `/desktop/requests/${encodeURIComponent(requestId)}/revoke`, {}, { 'X-Instar-Operator-Session': session });
        // A refused revoke ended nothing, so the case would judge a grant that is still open.
        if (r.status >= 400) throw new Error(`revoke: refused with ${r.status} ${r.error ?? ''}`.trim());
        return r;
      }
      case 'stop-viewer': await this.main.page.click('#stopButton'); return { clicked: 'stop' };
      case 'leave-unlocked': await this.main.page.click('#leaveUnlockedButton'); return { clicked: 'leave-unlocked' };
      case 'drop-transport': await this.main.context.setOffline(true); return { offline: true };
      case 'wait-deadline': return { timedByTyping: true };
      case 'type-letter': await this.main.page.focus('#surface'); await this.main.page.keyboard.press('a'); return { pressed: 'a' };
      case 'grant-other-agent': {
        const v = await this.viewer(this.b);
        await this.requestGrant(v);
        await this.sleep(5_000);
        const text = (await v.page.textContent('#status').catch(() => '')) ?? '';
        const opened = await v.page.isVisible('#control');
        this.events.add('other-grant-tried');
        return { opened, refused: /relock/i.test(text) ? 'relock-pending' : refusalFromStatus(text) ?? null, status: text.slice(0, 200) };
      }
      case 'next-helper-clears-field': {
        // The half-typed-field marker outlives its request by design: the NEXT input helper clears
        // the field before any password can be typed. So open a next grant and watch the marker go.
        const before = this.readStore().dirty !== undefined && this.readStore().dirty !== null;
        const v = await this.viewer(this.a);
        await this.requestGrant(v);
        await v.page.waitForSelector('#control:not([hidden])', { timeout: 30_000 }).catch(() => {});
        const t0 = this.now();
        let dirty = true;
        while (dirty && this.now() - t0 < 15_000) {
          const d = this.readStore().dirty;
          dirty = d !== undefined && d !== null;
          if (dirty) await this.sleep(250);
        }
        const ms = this.now() - t0;
        // End the extra grant and wait for its helper to go, so the case's own leftover checks see a quiet Mac.
        // First the way a person would stop it, with a short wait, and say whether that worked: in
        // the first live run of this step an ordinary click on Stop did not go through within 30 s
        // while the locked-screen password box was showing. Then stop it for certain.
        const stopClick = await v.page.click('#stopButton', { timeout: 3_000 }).then(() => 'clicked', err => String(err?.message ?? err).split('\n').slice(0, 6).join(' | ').slice(0, 400));
        if (stopClick !== 'clicked') await v.page.evaluate(() => document.getElementById('stopButton')?.click()).catch(() => {});
        const until = this.now() + 15_000;
        while (this.now() < until && this.processes().some(p => p.command.includes('input-stream'))) await this.sleep(250);
        const helperGone = !this.processes().some(p => p.command.includes('input-stream'));
        return { dirtyBefore: before, cleared: !dirty, ms, stopClick, helperGone };
      }
      case 'open-next-grant': {
        await this.main.page.click('#stopButton').catch(() => {});
        const v = await this.viewer(this.a);
        await this.requestGrant(v);
        await v.page.waitForSelector('#control:not([hidden])', { timeout: 30_000 }).catch(() => {});
        this.events.add('next-grant-open');
        return { opened: await v.page.isVisible('#control') };
      }
      case 'logout-proof-user': {
        const out = sudo(['launchctl', 'bootout', `gui/${this.uid}`], { allowFail: true });
        // The event is sticky, and this case waits for the user's return: it must first see them gone.
        const until = this.now() + 30_000;
        while (this.now() < until && this.consoleOwner() === PROOF_USER) await this.sleep(500);
        this.events.delete('proof-user-console');
        return { out };
      }
      case 'lock-now': return { out: this.asProof(['python3', '-c', LOCK_PY]) };
      default: throw new Error(`unknown action ${action}${step ? ` (case step ${step.at})` : ''}`);
    }
  }

  async askPerson(text) {
    process.stdout.write(`\n>>> PERSON STEP: ${text}\n\n`);
    recordPersonStep(this.o, text, () => spawnSync('bash',
      [path.join(this.o.agentHome, '.instar/scripts/telegram-reply.sh'), String(this.o.notifyTopic)],
      { encoding: 'utf8', input: `Locked-Mac proof: ${text}`, timeout: 30_000 }));
  }

  async extraEvidence(c, ev) {
    const enters = new Map();
    let closedAt = null;
    for (const s of ev.samples) {
      for (const [key, m] of Object.entries(s.markers ?? {})) {
        if (typeof m.enterPendingAt === 'number') enters.set(`${key}:${m.enterPendingAt}`, m.enterPendingAt);
        if (closedAt === null && TERMINAL.includes(m.state)) closedAt = s.t;
      }
    }
    const watchStarts = new Set(ev.samples.flatMap(s => Object.values(s.markers ?? {}).map(m => m.watchStart).filter(Boolean)));
    const finalMarkers = Object.values(ev.final.markers ?? {});
    const procs = this.processes();
    const out = {
      submissions: enters.size,
      submissionsAfterClose: closedAt === null ? 0 : [...enters.values()].filter(t => t > closedAt).length,
      guardReplaced: finalMarkers.some(m => (m.guardReplacements ?? 0) > 0),
      watchStartChanged: watchStarts.size > 1,
      producerGone: finalMarkers.some(m => m.producerGone === true),
      oldGuardGone: !this.pids.stoppedGuard || !procs.some(p => p.pid === this.pids.stoppedGuard),
      typistGone: !procs.some(p => p.command.includes('input-stream')),
      grantAlive: this.main ? await this.main.page.isVisible('#control').catch(() => false) : false,
      loginwindowLines: sh('log', ['show', '--style', 'compact', '--start', localStamp(ev.startedAt),
        '--predicate', 'process == "loginwindow"'], { allowFail: true }).split('\n').filter(l => /authenticat/i.test(l)).length,
    };
    try {
      const failedAt = ev.samples.find(s => Object.values(s.markers ?? {}).some(m => m.state === 'relock-failed'))?.t;
      const find = async () => ((await this.api(this.a, 'GET', '/attention')).items ?? [])
        .find(i => String(i.id).startsWith('agent:desktop-relock') && Date.parse(i.createdAt) >= ev.startedAt);
      let item = await find();
      // The owner is told by a 10 s sweep, so a single look right after a failed relock is too early.
      for (const until = this.now() + 15_000; !item && failedAt && this.now() < until;) { await this.sleep(1_000); item = await find(); }
      out.securityItemRaised = !!item;
      if (item && failedAt) out.securityItemMs = Date.parse(item.createdAt) - failedAt;
    } catch { out.securityItemRaised = false; }
    return out;
  }

  async closeViewers() {
    for (const v of this.viewers.splice(0)) await v.context.close().catch(() => {});
    this.main = null;
  }

  async close() {
    const problems = await this.recover();
    if (problems.length) process.stderr.write(`[locked-proof] recovery problems: ${problems.join('; ')}\n`);
    await this.closeViewers();
    await this.browser?.close();
  }
}

/** `log show --start` reads local time as YYYY-MM-DD HH:MM:SS. */
function localStamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STATUS_REASONS = [
  ['finishing a relock', 'relock-pending'], ['Too many tries in this session', 'attempts-per-request'],
  ['Too many tries today', 'attempts-per-day'], ['connection changed', 'seal-stale'],
  ['Stopped before the password finished', 'aborted'], ['Clearing the password field', 'field-dirty'],
  ['secure tunnel is up', 'tunnel-not-active'], ['kept desktop helper', 'retained-helper-required'],
  ['Password entry from a browser is off', 'browser-box-off'], ['backup connection', 'tunnel-not-first-tier'],
  ['lock screen is not ready for a password', 'shield-not-confirmed'],
  ['did not accept that', 'refused-other'],
];
export function refusalFromStatus(text) {
  const hit = STATUS_REASONS.find(([needle]) => text.includes(needle));
  return hit ? hit[1] : null;
}

async function main() {
  const command = process.argv[2];
  if (command === 'expected') { process.stdout.write(renderExpected()); return; }
  if (command !== 'run' && command !== 'calibrate') {
    process.stderr.write('usage: driver.mjs expected | calibrate --execute ... | run --execute [--cases ...] ...\n');
    process.exit(2);
  }
  const o = {
    agentHome: opt('agent-home'), proofDir: opt('proof-dir', `/Users/${PROOF_USER}/.instar/agents/locked-proof`),
    proofDirB: opt('proof-dir-b', `/Users/${PROOF_USER}/.instar/agents/locked-proof-b`),
    proofInstall: opt('proof-install', `/Users/${PROOF_USER}/.instar/proof-install`),
    port: Number(opt('port', '4098')), portB: Number(opt('port-b', '4097')), playwright: opt('playwright'),
    out: path.resolve(opt('out', 'locked-proof-results')), notifyTopic: opt('notify-topic'), headed: flag('headed'),
  };
  const cases = command === 'calibrate' ? [] : selectCases(opt('cases')?.split(',').map(s => s.trim()).filter(Boolean));
  if (!flag('execute')) {
    process.stdout.write(`dry run (no --execute): would ${command} ${command === 'run' ? `${cases.length} case(s): ${cases.map(c => c.id).join(', ')}` : ''}\n`);
    process.stdout.write(`against ${o.proofDir} (:${o.port}) and ${o.proofDirB} (:${o.portB}) as ${PROOF_USER}; results in ${o.out}\n`);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('the proof runs on a Mac');
  if (!o.agentHome || !o.playwright) throw new Error('--agent-home and --playwright are required with --execute');
  fs.mkdirSync(o.out, { recursive: true });
  const target = new RealTarget(o);
  await target.init();
  try {
    if (command === 'calibrate') {
      await target.prepare({ id: 'calibrate' });
      await target.openGrant({});
      const t0 = target.now();
      const typed = target.typePassword({ inject: [] });
      let typistAt = null; let enterAt = null;
      while (target.now() - t0 < 60_000 && enterAt === null) {
        const snap = await target.snapshot();
        if (snap.typistRunning && typistAt === null) typistAt = snap.now;
        const m = Object.values(snap.markers).find(x => typeof x.enterPendingAt === 'number');
        if (m) enterAt = m.enterPendingAt;
        await target.sleep(50);
      }
      const result = await typed;
      if (typistAt === null || enterAt === null) throw new Error(`calibration incomplete: ${JSON.stringify(result)}`);
      const cal = { reserveMs: typistAt - t0, perCharMs: (enterAt - typistAt) / target.password.length, length: target.password.length, at: new Date().toISOString() };
      fs.writeFileSync(path.join(o.out, 'calibration.json'), `${JSON.stringify(cal, null, 2)}\n`);
      process.stdout.write(`calibration: ${JSON.stringify(cal)}\n`);
      return;
    }
    const results = path.join(o.out, 'results.jsonl');
    for (const c of cases) {
      const ev = await runCase(c, target, { log: line => process.stdout.write(`${line}\n`) });
      fs.appendFileSync(results, `${JSON.stringify(ev)}\n`);
      process.stdout.write(`${c.id} ${ev.verdict.pass ? 'PASS' : `FAIL: ${ev.verdict.reasons.join('; ')}`}\n`);
    }
  } finally { await target.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { process.stderr.write(`[locked-proof] ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
}
