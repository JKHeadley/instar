/**
 * Setup recipes for recommended services (docs/specs/recommended-services.md, The agent owns setup).
 *
 * A recipe is a proven head start, not the limit: its brief hands a session the whole job, and the
 * session researches and adapts when a provider's flow has changed. Its `verify` is the end-to-end
 * check that decides whether the service works. A service is only available once its recipe is
 * proven, and until then only an agent that lists it under `recommendedServices.provingRecipes` can
 * reach it.
 */
import { execFile } from 'node:child_process';
import type { CatalogRow } from './catalog.js';
import { RECOMMENDED_SERVICE_CATALOG } from './catalog.js';

export interface VerifyResult {
  result: 'pass' | 'fail' | 'unknown';
  detail: string;
  /** On a fail: nothing of the service is here at all (no key, not signed in, not installed), as opposed to one that is here but not working. */
  absent?: boolean;
}

/** What reading `tailscale status --json` gave: no program at all, a program that answered with an error, a reading, or no answer in time. */
export type TailscaleStatusRead =
  | { kind: 'missing' }
  | { kind: 'failed' }
  | { kind: 'timeout' }
  | { kind: 'ok'; stdout: string };

export interface RecipeDeps {
  readSecret: (name: string) => string | null;
  fetch?: typeof fetch;
  /** Tests pass their own reading; the default asks the tailscale program on this machine. */
  tailscaleStatus?: () => Promise<TailscaleStatusRead>;
}

/** What a confirmed no with "switch it off" has to work with. */
export interface StopDeps extends RecipeDeps {
  deleteSecret: (name: string) => void;
  /** True only on positive evidence that this machine's own setup made the service work here (its key, or its sign-in). Never assumed. */
  setUpHere: boolean;
  /** Tests pass their own; the default runs `tailscale logout` on this machine. */
  tailscaleLogout?: () => Promise<boolean>;
}

/** `stopped` false means the service is still on; `changed` says whether anything on this machine was undone; `detail` is for the person, in plain words. */
export interface StopResult {
  stopped: boolean;
  changed: boolean;
  detail: string;
}

export interface SetupRecipe {
  id: string;
  service: string;
  /** The one secret this recipe may store, through POST /recommended-services/:id/key. Null when it stores none. */
  secretName: string | null;
  brief: (context: { port: number }) => string;
  verify: (deps: RecipeDeps) => Promise<VerifyResult>;
  /**
   * Switches the service off on this machine after the person confirmed a no with "switch it off"
   * (the spec's `shutdown: authorized`). Undoes only what setup did here, never the person's own.
   */
  stop: (deps: StopDeps) => Promise<StopResult>;
}

/** Exported so tests can check every recipe carries the shared rules. */
export const RULES = (service: string, port: number): string => `
Rules that apply whatever you find:
- This job is entirely yours until the check below passes. The person only approves decisions, such as a payment, or supplies a credential. They never open a browser, fetch a key, visit a provider's site, run a command, edit a file or follow steps.
- If a provider's flow has changed from what this says, research it and adapt. Routine failures are yours to diagnose, retry and repair, quietly.
- Credentials only ever come through a one-time Secret Drop link, never chat or a file. Ask for one thing at a time, in plain words.
- If you have to hold a key or sign-in code for a moment, or a picture of one, keep it in your session's private temporary folder, never a shared one, and delete it as soon as it's used.
- Whose account is the person's choice: you can fully manage their own accounts, use accounts of your own, or both. Follow what they have said. If they haven't said, ask once and present both as good options.
- Never open an account on a disposable or temporary email address, because the account is lost when that inbox goes. If you have no lasting address to use, say so and ask for the smallest thing you need.
- Close any browser window you opened as soon as you're done with it. A no can end this session without warning, and whatever is still open stays open.
- Talk to the person in this conversation's topic, $INSTAR_TELEGRAM_TOPIC. It is yours for this job, and replies there reach you.
- No spending and no permission grants without their yes. Nothing checks your browser clicks, so this is on you: stop and ask before any page that charges or grants.
- Their yes to this service is not a yes to the provider's terms. Before you tick, click or sign anything that accepts terms of service, an agreement or a contract, stop and ask them in this topic. Say in plain words what it is and what stands out in it, such as binding arbitration, giving up class actions, auto-renewal, a minimum term or charges after a trial, and ask for a yes or no. Only their yes in this conversation lets you accept. If they say not now, hold as below. A banner that only sets cookie preferences is not an agreement.
- Your calls to this server need the header "Authorization: Bearer $INSTAR_AUTH_TOKEN".
- Just before you activate or store anything, read GET http://localhost:${port}/recommended-services and find this service. If grantedHere is false, the person has said no or this machine isn't authorized: stop, change nothing more, and end.
- When you think it works, call POST http://localhost:${port}/recommended-services/${service}/verify with the header "X-Instar-Request: 1". Only result "pass" means done. Then tell the person, in one plain message, that it works and what it means for them.
- If the person says not now to something this job needs, tell them plainly where that leaves things, then call POST http://localhost:${port}/recommended-services/${service}/hold with the header "X-Instar-Request: 1" and stop. Nothing restarts you after that, and their next message reaches you here.
- If you run out of options, tell them what you tried in plain words, and name the smallest thing you need. Never hand it back as steps.
`;

export const SETUP_RECIPES: readonly SetupRecipe[] = Object.freeze([
  {
    id: 'jev-v1',
    service: 'jev',
    secretName: 'typesafe_api_key',
    brief: ({ port }) => `The person said yes to Jev from TypeSafe. Set it up.

What's known, as of 2026-11-04: the console at console.typesafe.ai offers "Sign in or create an account through Google or your email". API keys have been reported under API Keys in that console. Reaching it needs a normal browser, because plain fetches were refused. Use the agent's browser profiles (GET http://localhost:${port}/playwright-profiles) and the normal-chrome browser when automation is refused.

Store the key as a plain text body, and don't print it:
curl -s -X POST http://localhost:${port}/recommended-services/jev/key -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1" -H "Content-Type: text/plain" --data-binary @-
It refuses to replace a key that was here before setup started. Your own key can be corrected until it passes.

As of 2026-11-05 a new account opens at no cost, but TypeSafe refuses to create a key until the account has credits, so say that early. Ask for a yes to the smallest top-up and a cap. A TypeSafe credit code avoids a card. Before anything costs money, confirm the current price with the person. Features that use Jev turn on separately as each is proven, so don't promise the efficiency gains yet.
${RULES('jev', port)}`,
    verify: async ({ readSecret, fetch: doFetch = fetch }) => {
      const key = readSecret('typesafe_api_key');
      if (!key) return { result: 'fail', absent: true, detail: 'No key is stored yet.' };
      try {
        const res = await doFetch('https://api.typesafe.ai/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        if (res.ok) return { result: 'pass', detail: 'TypeSafe accepted the key.' };
        if (res.status === 401 || res.status === 403) return { result: 'fail', detail: `TypeSafe refused the key (${res.status}).` };
        return { result: 'unknown', detail: `TypeSafe answered ${res.status}.` };
      } catch {
        return { result: 'unknown', detail: 'TypeSafe could not be reached.' };
      }
    },
    // The key is what makes Jev work here, so removing it switches Jev off for every feature at once. Like
    // Tailscale, setup undoes only its own work: a key that was here before setup is the person's, and stays.
    // The TypeSafe account and its credits are the person's too.
    stop: async ({ readSecret, deleteSecret, setUpHere }) => {
      if (!readSecret('typesafe_api_key')) return { stopped: true, changed: false, detail: 'Jev was not switched on here, so there was nothing to switch off.' };
      if (!setUpHere) return { stopped: true, changed: false, detail: "The TypeSafe key on this machine was yours before I set anything up, so I've left it in place and will just stop relying on Jev. Say the word and I'll remove it for you." };
      deleteSecret('typesafe_api_key');
      return { stopped: true, changed: true, detail: 'Jev is switched off on this machine: its key is removed, so nothing here uses it any more. The TypeSafe account and any credits on it stay yours; say the word and I\'ll close them.' };
    },
  },
  {
    id: 'tailscale-v1',
    service: 'tailscale',
    // Tailscale's sign-in is the person's own tap on a link. There is no key for this recipe to keep,
    // and it must never use one: see the brief.
    secretName: null,
    brief: ({ port }) => `The person said yes to Tailscale. Set it up on this machine.

What it gives them: a private address for reaching this agent from their own devices, and the strongest link between this agent's machines. If it can't be finished, nothing breaks: the agent stays reachable through its backup, which is Cloudflare, the local network, or messaging, which needs no address. Say that plainly if you stop.

What's known, as of 2026-11-06:
- Check first. Run "tailscale status --json" (on a Mac the program may also be at /Applications/Tailscale.app/Contents/MacOS/Tailscale). If BackendState is "Running", this machine is already on a tailnet: call the check below and change nothing.
- Never sign this machine out, switch it to another tailnet, or change an existing device or the tailnet's access rules. If it is signed in to a tailnet the person doesn't want, stop and ask.
- If Tailscale isn't installed, install it yourself. On a Mac, Homebrew ("brew install tailscale", then run its tailscaled) needs no administrator rights; the Tailscale app needs an administrator. On Linux the official installer (https://tailscale.com/install.sh) needs sudo. Try what works without rights before asking for any.
- On Linux, a non-root user also needs operator rights before it can sign in. The command is "sudo tailscale set --operator=<user>" (the same one the installer gives). If you can't get rights yourself, work through the alternatives first, such as running tailscaled in userspace mode under this user with its own state folder and socket. Only if none works, name the one thing you need from the person.
- Sign-in: start "tailscale up" (or "tailscale login") in the background with a time limit, and read the sign-in link it prints (https://login.tailscale.com/...). Send the person that link in one plain message: one tap signs this machine in to their Tailscale with their own Google, GitHub or other login, and if they have no account yet, that tap makes one. That tap is how they supply their own credential, which the rules below allow, and it is the one thing only they can do. Say it as one tap, never as steps.
- Never sign in with an auth key, a stored credential, or a browser login you already hold, even if one is offered or you find one. The person's own tap is what makes this their network.
- If the link expires before they tap, start a fresh one and send it, saying the old one no longer works. If Tailscale reports the device needs approval by the tailnet's administrator, tell the person that in one plain sentence; that approval is theirs to give.
- When "tailscale status --json" shows BackendState "Running", call the check below. Don't show addresses, device names or account names in your messages beyond what the person needs.
${RULES('tailscale', port)}`,
    verify: async ({ tailscaleStatus = readTailscaleStatus }) => {
      const read = await tailscaleStatus();
      if (read.kind === 'missing') return { result: 'fail', absent: true, detail: "Tailscale isn't installed on this machine." };
      if (read.kind === 'failed') return { result: 'fail', detail: "Tailscale isn't running on this machine." };
      if (read.kind === 'timeout') return { result: 'unknown', detail: 'Tailscale did not answer in time.' };
      return judgeTailscaleStatus(read.stdout);
    },
    // Setup never signs a machine out that it didn't sign in (see the brief). So a switch-off signs
    // out only when this machine's setup did the sign-in; a Tailscale the person already had stays.
    stop: async ({ setUpHere, tailscaleStatus = readTailscaleStatus, tailscaleLogout = runTailscaleLogout }) => {
      if (!setUpHere) return { stopped: true, changed: false, detail: "Tailscale was already yours before I set anything up, so I've left it exactly as it was. I just won't rely on it." };
      const before = await tailscaleStatus();
      if (before.kind === 'missing') return { stopped: true, changed: false, detail: "Tailscale isn't installed on this machine, so there was nothing to switch off." };
      if (before.kind !== 'ok' || judgeTailscaleStatus(before.stdout).result !== 'pass') return { stopped: true, changed: false, detail: 'This machine was not signed in to Tailscale, so there was nothing to switch off.' };
      if (!(await tailscaleLogout())) return { stopped: false, changed: false, detail: 'I tried to sign this machine out of Tailscale and it refused. It is still signed in.' };
      const after = await tailscaleStatus();
      const stillIn = after.kind === 'ok' && judgeTailscaleStatus(after.stdout).result === 'pass';
      return stillIn
        ? { stopped: false, changed: false, detail: 'I asked Tailscale to sign this machine out, but it still shows as signed in.' }
        : { stopped: true, changed: true, detail: 'This machine is signed out of Tailscale. Your Tailscale account and your other devices are untouched.' };
    },
  },
]);

const TAILSCALE_PROGRAMS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];

/**
 * Reads this machine's Tailscale state. The program on PATH comes first, so the person's own choice of
 * install wins; the Mac app and the usual install folders follow, since on a Mac it is often not on PATH.
 */
export async function readTailscaleStatus(programs: readonly string[] = TAILSCALE_PROGRAMS): Promise<TailscaleStatusRead> {
  let sawFailure = false;
  for (const program of programs) {
    const outcome = await new Promise<TailscaleStatusRead>((resolve) => {
      execFile(program, ['status', '--json'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (!err) return resolve({ kind: 'ok', stdout: String(stdout) });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT' || e.code === 'EACCES') return resolve({ kind: 'missing' });
        if (e.killed) return resolve({ kind: 'timeout' });
        // `tailscale status --json` still prints the state when it exits non-zero for a stopped or signed-out node.
        if (String(stdout ?? '').trim().startsWith('{')) return resolve({ kind: 'ok', stdout: String(stdout) });
        resolve({ kind: 'failed' });
      });
    });
    if (outcome.kind === 'ok' || outcome.kind === 'timeout') return outcome;
    if (outcome.kind === 'failed') sawFailure = true;
  }
  return sawFailure ? { kind: 'failed' } : { kind: 'missing' };
}

/** Signs this machine out with the first tailscale program that answers. True when the command succeeded. */
export async function runTailscaleLogout(programs: readonly string[] = TAILSCALE_PROGRAMS): Promise<boolean> {
  for (const program of programs) {
    const outcome = await new Promise<'ok' | 'missing' | 'failed'>((resolve) => {
      execFile(program, ['logout'], { timeout: 20_000 }, (err) => {
        if (!err) return resolve('ok');
        const e = err as NodeJS.ErrnoException;
        resolve(e.code === 'ENOENT' || e.code === 'EACCES' ? 'missing' : 'failed');
      });
    });
    if (outcome === 'ok') return true;
    if (outcome === 'failed') return false;
  }
  return false;
}

/** Pass only when this machine is signed in and online. The detail names no address, device or account. */
export function judgeTailscaleStatus(raw: string): VerifyResult {
  let body: { BackendState?: unknown; Self?: { Online?: unknown; TailscaleIPs?: unknown } };
  try {
    body = JSON.parse(raw);
  } catch {
    // @silent-fallback-ok: an unreadable answer is reported as unknown, never as a pass
    return { result: 'unknown', detail: "Tailscale's answer could not be read." };
  }
  const state = typeof body?.BackendState === 'string' ? body.BackendState : null;
  if (state === null) return { result: 'unknown', detail: "Tailscale's answer could not be read." };
  if (state === 'Running') {
    const ips = Array.isArray(body.Self?.TailscaleIPs) ? body.Self.TailscaleIPs : [];
    if (ips.length === 0) return { result: 'fail', detail: 'Tailscale is running but this machine has no private address yet.' };
    if (body.Self?.Online === false) return { result: 'fail', detail: "This machine is signed in to Tailscale but isn't online." };
    return { result: 'pass', detail: 'This machine is signed in to Tailscale and online.' };
  }
  if (state === 'NeedsLogin') return { result: 'fail', absent: true, detail: 'This machine is not signed in to Tailscale yet.' };
  if (state === 'NeedsMachineAuth') return { result: 'fail', detail: "This machine is waiting for the tailnet's administrator to approve it." };
  if (state === 'Stopped') return { result: 'fail', detail: 'Tailscale is installed but switched off on this machine.' };
  return { result: 'fail', detail: `Tailscale is not ready on this machine (${state}).` };
}

export function recipeFor(row: CatalogRow): SetupRecipe | null {
  return SETUP_RECIPES.find((r) => r.id === row.setupRecipe) ?? null;
}

/**
 * The catalog this agent sees: recipes it has chosen to prove become available here, and nowhere else.
 * `allowed` answers true only on a throwaway agent or the development agent, so one stray config value on
 * a fleet agent can't offer an unproven recipe to a real person.
 */
export function catalogWithProving(proving: readonly string[] | undefined, allowed: () => boolean): readonly CatalogRow[] {
  if (!proving?.length || !allowed()) return RECOMMENDED_SERVICE_CATALOG;
  return RECOMMENDED_SERVICE_CATALOG.map((row) => {
    const recipe = SETUP_RECIPES.find((r) => r.service === row.id && proving.includes(r.id));
    return recipe ? { ...row, setupRecipe: recipe.id } : row;
  });
}
