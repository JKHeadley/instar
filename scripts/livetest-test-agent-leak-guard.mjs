#!/usr/bin/env node
/**
 * Live reproduction for docs/specs/test-agent-leak-guard.md (macOS only, run by
 * hand, never in CI — it uses the REAL launchd of the user running it).
 *
 * Part 1 repeats the 2026-10-21 incident: `instar init` with HOME sandboxed to
 * a temp folder and no terminal, then a foreground server start and kill.
 * Asserts: no ai.instar.<name> job is loaded, no plist exists in the fake or
 * the real home, and the machine-wide fleet watchdog plist is untouched.
 *
 * Part 2 proves self-teardown: a throwaway force-installed into the real
 * launchd, given an expired record, and restarted by launchd must unload itself
 * and remove its plist, and launchd must not bring it back.
 *
 * Usage: node scripts/livetest-test-agent-leak-guard.mjs   (from a built checkout)
 * Every job it loads is unloaded and every file removed on exit, pass or fail.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';

if (process.platform !== 'darwin') {
  console.log('SKIP: macOS only');
  process.exit(0);
}

const cli = path.resolve('dist/cli.js');
const uid = process.getuid();
const realHome = os.userInfo().homedir;
const root = fs.mkdtempSync('/private/tmp/tlg-live-');
const fakeHome = path.join(root, 'home');
fs.mkdirSync(fakeHome);
const name = `tlg-live-${Math.random().toString(36).slice(2, 8)}`;
const label = `ai.instar.${name}`;
const agentDir = path.join(root, name);
fs.mkdirSync(agentDir);
const realPlist = path.join(realHome, 'Library', 'LaunchAgents', `${label}.plist`);
const fakePlist = path.join(fakeHome, 'Library', 'LaunchAgents', `${label}.plist`);
const watchdogPlist = path.join(realHome, 'Library', 'LaunchAgents', 'ai.instar.watchdog.plist');
const port = 4790 + Math.floor(Math.random() * 9);
const results = [];

function check(label_, ok, detail = '') {
  results.push({ label: label_, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label_}${detail ? ` — ${detail}` : ''}`);
}
function loaded() {
  try {
    return execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
function cleanup() {
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  for (const p of [realPlist, fakePlist]) { try { SafeFsExecutor.safeUnlinkSync(p, { operation: 'scripts/livetest-test-agent-leak-guard.mjs:cleanup' }); } catch { /* absent */ } }
  try { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'scripts/livetest-test-agent-leak-guard.mjs:cleanup' }); } catch { /* best effort */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const childEnv = { ...process.env, HOME: fakeHome, CODEX_HOME: path.join(fakeHome, '.codex') };
delete childEnv.VITEST;
delete childEnv.INSTAR_SKIP_LAUNCHCTL_LOAD;

try {
  const watchdogBefore = fs.existsSync(watchdogPlist) ? fs.statSync(watchdogPlist).mtimeMs : null;

  // ── Part 1: the incident shape ──
  execFileSync(process.execPath, [cli, 'init', '--dir', agentDir, '--port', String(port)], {
    env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, '.instar', 'config.json'), 'utf-8'));
  check('init recorded autostart.autoInstall=false', cfg.autostart?.autoInstall === false, JSON.stringify(cfg.autostart));
  check('init recorded a throwaway expiry', typeof cfg.throwawayAgent?.expiresAt === 'string', JSON.stringify(cfg.throwawayAgent));

  for (let i = 0; i < 2; i++) {
    const srv = spawn(process.execPath, [cli, 'server', 'start', '--foreground', '--dir', agentDir], {
      env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    srv.stdout.on('data', (d) => { out += d; });
    srv.stderr.on('data', (d) => { out += d; });
    await sleep(30_000);
    srv.kill('SIGTERM');
    await sleep(3_000);
    try { srv.kill('SIGKILL'); } catch { /* gone */ }
    const heal = out.split('\n').find((l) => /Auto-start/.test(l));
    console.log(`  (server start #${i + 1} ran ~30s; autostart line: ${heal ? heal.trim() : 'none printed (self-install skipped: autoInstall=false)'})`);
    check(`server start #${i + 1} got past config load`, /Throwaway|Scheduler|Auto-start|Port|instar/i.test(out));
  }
  check('no launchd job loaded for the throwaway', loaded() === null);
  check('no plist under the fake HOME', !fs.existsSync(fakePlist));
  check('no plist under the real HOME', !fs.existsSync(realPlist));
  const watchdogAfter = fs.existsSync(watchdogPlist) ? fs.statSync(watchdogPlist).mtimeMs : null;
  check('the machine-wide fleet watchdog plist is untouched', watchdogBefore === watchdogAfter);

  // ── Part 2: self-teardown of a force-installed throwaway ──
  // The launchd boot wrapper runs the agent's shadow install (and would npm
  // install the published instar if it is missing). Point it at THIS build so
  // launchd runs the code under test.
  const shadowNm = path.join(agentDir, '.instar', 'shadow-install', 'node_modules');
  fs.mkdirSync(shadowNm, { recursive: true });
  fs.symlinkSync(path.resolve('.'), path.join(shadowNm, 'instar'));
  const realEnv = { ...process.env };
  delete realEnv.VITEST;
  delete realEnv.INSTAR_SKIP_LAUNCHCTL_LOAD;
  execFileSync(process.execPath, [cli, 'autostart', 'install', '--force', '--dir', agentDir], {
    env: realEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  check('--force installed the plist in the real home', fs.existsSync(realPlist));
  const print1 = loaded();
  check('the job is loaded', print1 !== null);
  const wd = /^\tworking directory = (.+)$/m.exec(print1 ?? '')?.[1];
  check('launchd started it with this agent as its working directory', !!wd && fs.realpathSync(wd) === fs.realpathSync(agentDir), wd);

  // Expire it, then let launchd restart it.
  const cfgPath = path.join(agentDir, '.instar', 'config.json');
  const c2 = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  c2.throwawayAgent = { createdAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-02T00:00:00Z', reasons: ['livetest'] };
  fs.writeFileSync(cfgPath, JSON.stringify(c2, null, 2));
  try { execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch { /* already restarting */ }

  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) {
    await sleep(2_000);
    gone = loaded() === null && !fs.existsSync(realPlist);
  }
  check('the expired throwaway unloaded itself and removed its plist', gone);
  await sleep(25_000); // > 2x launchd ThrottleInterval
  check('launchd did not bring it back', loaded() === null);
  const marker = path.join(agentDir, '.instar', 'state', 'throwaway-expired.json');
  const m = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf-8')) : null;
  check('the expired marker records a complete teardown', m?.outcome === 'complete', m ? `outcome=${m.outcome}` : 'no marker');
} catch (err) {
  check('script ran to completion', false, err instanceof Error ? err.message : String(err));
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
