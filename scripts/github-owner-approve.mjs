#!/usr/bin/env node
/**
 * Record the owner's approving review on a GitHub pull request, in the owner's own signed-in
 * browser profile (docs/specs/github-approval-from-the-app.md). Run by the server
 * (src/core/GithubOwnerApproval.ts) only after the owner's Face ID tap; GitHub's reviews API,
 * read by the server afterwards, decides whether it worked. This script's report counts for nothing.
 *
 * Input: ONE JSON object on stdin
 *   {repo, pr, headSha, expectedLogin, userDataDir, playwrightCoreDir, password, totpSecret,
 *    notBeforeStep, ghPath, headless?}
 * Output: ONE JSON line on stdout {outcome, step?}. outcome is one word:
 *   submitted | signed-out | wrong-account | device-verification | reauth-required | profile-busy |
 *   playwright-missing | head-changed | pending-review | 2fa-method-unavailable | bad-input | error
 * `step` is the TOTP time-step NUMBER it used (never the code), so the server never sends a code twice.
 * Test-only input `holdBeforeSubmitMs` pauses after the final head check (the live race proof).
 *
 * Never prints, logs, writes to disk or passes on argv a password, a TOTP secret or a code.
 * Never writes page HTML anywhere. The browser is closed in `finally`.
 */
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

const say = (outcome, extra = {}) => { process.stdout.write(JSON.stringify({ outcome, ...extra }) + '\n'); };

/** RFC 4648 base32 → bytes (spaces and padding ignored). */
export function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for a given step. */
export function totpAt(secret, step) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

const currentStep = () => Math.floor(Date.now() / 30_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveHead(ghPath, repo, pr) {
  return new Promise((resolve) => {
    execFile(ghPath, ['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'], { timeout: 20_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  let input;
  try { input = await readStdin(); } catch { say('bad-input'); return; }
  const { repo, pr, headSha, expectedLogin, userDataDir, playwrightCoreDir, password, totpSecret, ghPath } = input ?? {};
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0
    || typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha) || typeof expectedLogin !== 'string' || !expectedLogin
    || typeof userDataDir !== 'string' || !userDataDir || typeof playwrightCoreDir !== 'string' || !playwrightCoreDir
    || typeof password !== 'string' || typeof totpSecret !== 'string') { say('bad-input'); return; }
  let notBefore = Number.isInteger(input.notBeforeStep) ? input.notBeforeStep : 0;

  let chromium;
  try { ({ chromium } = createRequire(path.join(playwrightCoreDir, 'package.json'))(playwrightCoreDir)); } catch { say('playwright-missing'); return; }

  let ctx;
  let usedStep;
  try {
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: input.headless !== false, viewport: { width: 1280, height: 900 } });
    } catch (err) {
      say(/lock|in use|already running|ProcessSingleton/i.test(String(err && err.message)) ? 'profile-busy' : 'error');
      return;
    }
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const filesUrl = `https://github.com/${repo}/pull/${pr}/files`;
    await page.goto(filesUrl, { waitUntil: 'load', timeout: 45_000 });

    // Sign in when GitHub asks.
    if (/\/login|\/session/.test(new URL(page.url()).pathname)) {
      const login = page.locator('input[name="login"]');
      if (await login.count() === 0) { say('signed-out'); return; }
      await login.fill(expectedLogin);
      await page.locator('input[name="password"]').fill(password);
      await Promise.all([page.waitForLoadState('load', { timeout: 45_000 }).catch(() => {}), page.locator('input[type="submit"][name="commit"], button[type="submit"]').first().click()]);
    }
    let p = new URL(page.url()).pathname;
    if (/\/sessions\/verified-device|\/sessions\/device/.test(p)) { say('device-verification'); return; }
    if (/\/sessions\/two-factor/.test(p)) {
      if (!/\/two-factor\/app/.test(p)) { await page.goto('https://github.com/sessions/two-factor/app', { waitUntil: 'load', timeout: 45_000 }); }
      // Never the same code twice: wait for a step after the last one used.
      while (currentStep() <= notBefore) await sleep(1_000);
      usedStep = currentStep();
      const otp = page.locator('input[name="app_otp"], input#app_totp, input[autocomplete="one-time-code"]').first();
      if (await otp.count() === 0) { say('2fa-method-unavailable', { step: usedStep }); return; }
      await otp.fill(totpAt(totpSecret, usedStep));
      await page.waitForLoadState('load', { timeout: 45_000 }).catch(() => {});
      await sleep(1_500);
      p = new URL(page.url()).pathname;
      if (/\/sessions\/verified-device|\/sessions\/device/.test(p)) { say('device-verification', { step: usedStep }); return; }
      if (/\/sessions\/two-factor|\/login|\/session$/.test(p)) { say('signed-out', { step: usedStep }); return; }
      if (!p.endsWith(`/pull/${pr}/files`)) await page.goto(filesUrl, { waitUntil: 'load', timeout: 45_000 });
    }
    const stepExtra = usedStep ? { step: usedStep } : {};
    if (/\/sessions\/sudo|sudo/.test(new URL(page.url()).pathname)) { say('reauth-required', stepExtra); return; }

    // Signed in as the owner, and nobody else.
    const who = await page.locator('meta[name="user-login"]').getAttribute('content').catch(() => null);
    if (!who) { say('signed-out', stepExtra); return; }
    if (who.toLowerCase() !== expectedLogin.toLowerCase()) { say('wrong-account', stepExtra); return; }

    // Open the review dialog.
    const toolbar = page.getByRole('button', { name: /review changes|submit review/i }).first();
    await toolbar.click({ timeout: 30_000 });
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('radio', { name: /approve/i }) }).first();
    await dialog.waitFor({ state: 'visible', timeout: 20_000 });
    await dialog.getByRole('radio', { name: /approve/i }).check({ timeout: 10_000 });
    // Never publish review comments the owner left unsubmitted along with the approval.
    const dialogText = await dialog.innerText().catch(() => '');
    if (/\b[1-9][0-9]*\s+pending\s+comment/i.test(dialogText)) { say('pending-review', stepExtra); return; }

    // The head, one last time, right before the click: from the form when it says, and from GitHub.
    const formHead = await page.locator('input[name="head_sha"], input[name="commit_oid"], input[name="expected_head_oid"]').first().getAttribute('value').catch(() => null);
    if (formHead && formHead !== headSha) { say('head-changed', stepExtra); return; }
    const head = await liveHead(typeof ghPath === 'string' && ghPath ? ghPath : 'gh', repo, pr);
    if (head !== headSha) { say('head-changed', stepExtra); return; }
    if (Number.isInteger(input.holdBeforeSubmitMs) && input.holdBeforeSubmitMs > 0) await sleep(Math.min(input.holdBeforeSubmitMs, 60_000));

    await dialog.getByRole('button', { name: /submit review/i }).click({ timeout: 10_000 });
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
    await sleep(2_000);
    say('submitted', stepExtra);
  } catch {
    say('error', usedStep ? { step: usedStep } : {});
  } finally {
    try { await ctx?.close(); } catch { /* already closed */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), () => { say('error'); process.exit(0); });
}
