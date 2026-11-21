/**
 * `instar mobile add-phone` — "Add your phone" in a terminal on the agent's own computer
 * (identity A4; docs/specs/identity-security-piece3e-same-network-first-phone.md §4).
 *
 * The terminal is one of the local surfaces (beside the Windows, Linux and Mac apps, which show the
 * same link as a QR code). It asks for the dashboard PIN first (the fresh check), starts a setup on
 * the running agent, prints the pairing link for the Instar app on the phone, waits for the phone,
 * and asks for the six digits the phone shows. It talks only to the agent on this computer, over
 * loopback, with the agent's own token.
 */
import readline from 'node:readline';
import { loadConfig } from '../core/Config.js';

/** The agent no longer knows the setup (it restarted, which ends every setup in progress). */
const LOST_SETUP = 'The agent restarted, which ended this setup. Run this again to add your phone.';

interface AddPhoneOptions { dir?: string; anywhere?: boolean; json?: boolean; port?: number; /** Poll interval (tests only; 2 s otherwise). */ pollMs?: number }

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.startsWith(question)) process.stdout.write(question); };
    rl.question(question, (line) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(line.trim()); });
  });
}

/** Piped input, one line at a time as it arrives (so a number can be given once the phone shows it). */
let lineReader: AsyncIterator<string> | null = null;
async function firstLine(): Promise<string> {
  lineReader ??= readline.createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const r = await lineReader.next();
  return r.done ? '' : String(r.value).trim();
}

export async function addPhone(opts: AddPhoneOptions): Promise<void> {
  const config = loadConfig(opts.dir);
  const pollMs = opts.pollMs ?? 2_000;
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { Authorization: `Bearer ${config.authToken ?? ''}`, 'X-Instar-AgentId': String(config.projectName ?? ''), 'Content-Type': 'application/json' };
  const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    let r: Response;
    try { r = await fetch(`${base}${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) }); } catch { return { status: 0, json: { error: 'The agent is not answering on this computer (it may be restarting).' } }; } // @silent-fallback-ok — status 0 is reported by the caller; a poll simply asks again
    let json: Record<string, unknown> = {};
    try { json = await r.json() as Record<string, unknown>; } catch { /* @silent-fallback-ok — an empty answer is reported by its status below */ }
    return { status: r.status, json };
  };
  // The PIN is typed hidden, or piped on the first line of input; never a command-line argument
  // (which other programs on the computer could read from the process list).
  const pin = process.stdin.isTTY ? await ask('Your dashboard PIN: ', true) : await firstLine();
  if (!pin) { console.error('Run this in a terminal on the agent\'s computer: it asks for your dashboard PIN.'); process.exitCode = 1; return; }
  const start = await call('POST', '/mobile/phone-setup', { pin, address: opts.anywhere ? 'anywhere' : 'home', ...(opts.port !== undefined ? { port: opts.port } : {}) });
  if (start.status !== 200) {
    console.error(String(start.json.detail ?? start.json.error ?? `The agent answered ${start.status}.`));
    process.exitCode = 1;
    return;
  }
  const setupId = String(start.json.setupId);
  // Leaving early cancels the setup, so the home address does not stay open for nothing.
  let finished = false;
  const cancel = async (): Promise<void> => { if (!finished) { finished = true; await call('POST', `/mobile/phone-setup/${setupId}/cancel`, {}).catch(() => undefined); } };
  process.once('SIGINT', () => { void cancel().finally(() => process.exit(130)); });
  if (opts.json) console.log(JSON.stringify({ setupId, link: start.json.link, address: start.json.address }));
  else {
    console.log('\nOpen the Instar app on your phone, on the same Wi-Fi as this computer, and add this link:\n');
    console.log(`  ${String(start.json.link)}\n`);
    console.log('The Instar app on this computer shows the same link as a QR code to scan.');
  }
  if (start.json.approval !== 'computer') { console.log('Then confirm the code I send you in Telegram.'); return; }
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    if (Date.now() > deadline) { await cancel(); console.error('The setup timed out. Run this again to add your phone.'); process.exitCode = 1; return; }
    const s = await call('GET', `/mobile/phone-setup/${setupId}`);
    if (s.status === 404) { finished = true; console.error(LOST_SETUP); process.exitCode = 1; return; }
    if (s.json.state === 'ended') { console.error(`The setup ended (${String(s.json.endedReason ?? 'ended')}). Run this again to add your phone.`); process.exitCode = 1; return; }
    if (s.json.state === 'waiting-number') {
      const phone = (s.json.phone ?? {}) as Record<string, unknown>;
      console.log(`\nA phone is waiting: "${String(phone.name ?? 'unnamed')}" (the phone chose this name), key ${String(phone.key ?? 'unknown')}.`);
      console.log('If this is not the phone in your hand, press Ctrl+C.');
      const number = process.stdin.isTTY ? await ask('Type the six digits your phone shows: ', false) : await firstLine();
      if (!number) { console.error('No number was given. Run this again in a terminal.'); process.exitCode = 1; return; }
      const r = await call('POST', `/mobile/phone-setup/${setupId}/number`, { number });
      if (r.status === 200) { console.log('Right number. Your phone finishes by itself.'); break; }
      console.error(String(r.json.detail ?? r.json.error));
      if (r.status === 409) { process.exitCode = 1; return; }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // 450 polls of 2 s: the 15-minute signing window.
  for (let i = 0; i < 450; i++) {
    const s = await call('GET', `/mobile/phone-setup/${setupId}`);
    if (s.status === 404) { finished = true; console.error(LOST_SETUP); process.exitCode = 1; return; }
    if (s.json.state === 'done') { finished = true; console.log('Your phone is added. It works on this network; it cannot approve risky actions yet.'); return; }
    if (s.json.state === 'ended') { console.error(`The setup ended (${String(s.json.endedReason ?? 'ended')}).`); process.exitCode = 1; return; }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // The phone never finished within its signing window: not added (GPT review 5: this used to exit 0).
  await cancel();
  console.error('Your phone did not finish in time, so it was not added. Run this again to add your phone.');
  process.exitCode = 1;
}
