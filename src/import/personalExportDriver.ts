import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { ACCOUNT_PAGE_SAFETY_SCRIPT } from '../data/accountPageSafetyScript.js';

const runFile = promisify(execFile);

export interface PersonalExportTarget {
  provider: 'claude' | 'chatgpt';
  profileId: string;
  expectedEmail: string;
  workspace: 'personal';
}

export type PersonalExportResult =
  | { status: 'acknowledged' | 'already-reserved' | 'outcome-unknown' }
  | { status: 'needs-attention'; reason: 'invalid-target' | 'browser-unavailable' | 'page-unverified' | 'existing-request' | 'cancelled' };

/** The coordinator owns authorization, the acquisition lease and the durable reservation.
 * A reservation must survive process death. It must return false for a retry of an
 * uncertain submission. This driver never requests an export on the basis of a retry.
 */
export interface PersonalExportDriverOptions {
  browserDir: string;
  reserveSubmission: () => Promise<boolean>;
  signal?: AbortSignal;
  /** Reread the owner, conversation and operation grant before each external browser invocation. */
  authorized?: () => boolean;
  /** Test seams; production always uses the installed profile-bound macOS helpers. */
  invoke?: (executable: string, args: readonly string[]) => Promise<string>;
  wait?: () => Promise<void>;
}

const recipes = {
  claude: {
    origin: 'https://claude.ai', location: '/settings/privacy', heading: 'Privacy',
    open: ['Export data'], confirm: ['Confirm export', 'Export data'],
  },
  chatgpt: {
    origin: 'https://chatgpt.com', location: '/#settings/DataControls', heading: 'Data controls',
    open: ['Export data', 'Export'], confirm: ['Confirm export'],
  },
} as const;

const needs = (reason: Extract<PersonalExportResult, { status: 'needs-attention' }>['reason']): PersonalExportResult =>
  ({ status: 'needs-attention', reason });

function validTarget(target: PersonalExportTarget): boolean {
  return !!target && Object.hasOwn(recipes, target.provider) && target.workspace === 'personal'
    && typeof target.profileId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(target.profileId)
    && target.profileId !== 'default' && typeof target.expectedEmail === 'string'
    && target.expectedEmail.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(target.expectedEmail);
}

async function invoke(executable: string, args: readonly string[]): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('unsupported-platform');
  const { stdout } = await runFile(executable, [...args], { timeout: 35_000, maxBuffer: 128 * 1024 });
  return stdout.trim();
}

type Action = 'inspect' | 'open' | 'confirm' | 'reload';
type Page = 'settings' | 'confirm' | 'pending' | 'changed' | 'unverified' | 'acted';

/** Browser code is static apart from the fixed recipe and JSON-encoded scalar inputs.
 * It returns only a phase. Provider page text and account credentials stay on this machine.
 * Unsupported DOM variants fail closed until exercised with a dedicated pilot account.
 */
function pageScript(target: PersonalExportTarget, fingerprint: string, action: Action): string {
  const recipe = recipes[target.provider];
  const inputs = JSON.stringify({ recipe, email: target.expectedEmail.toLowerCase(), fingerprint, action });
  return String.raw`(() => {
    const { recipe, email, fingerprint, action } = ${inputs};
    if (location.origin !== recipe.origin || location.pathname + location.search + location.hash !== recipe.location) return 'unverified';
    const current = JSON.parse((${ACCOUNT_PAGE_SAFETY_SCRIPT})(true, 0));
    if (current.pageFingerprint !== fingerprint) return 'changed';

    const userContent = 'article,blockquote,pre,code,[data-message-id],[data-message-author-role],[data-testid^="conversation-turn"],[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
    const visible = el => el.getClientRects().length > 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(el).visibility === 'visible';
    const shown = (root, sel) => [...root.querySelectorAll(sel)].filter(el => visible(el) && !el.closest(userContent));
    const words = el => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const normal = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
    const headings = shown(document,'h1,h2,h3,[role="heading"],[role="tab"][aria-selected="true"]');
    const settings = headings.filter(el => normal(words(el)) === normal(recipe.heading)).map(el => el.closest('main,[role="main"],dialog,[role="dialog"],[role="tabpanel"]')).filter(Boolean);
    if (new Set(settings).size !== 1) return 'unverified';
    const panel = settings[0];
    // Read account chrome only. Text in the history sidebar, a conversation, or a user-editable field
    // is not evidence of the account or workspace the vendor is using.
    const chrome = el => panel.contains(el) || !!el.closest('nav,[role="navigation"],[data-testid="account-menu"],[data-testid="profile-menu"]');
    const accounts = shown(document, '[data-testid="account-email"],[aria-label="Account email"]:not(input):not(textarea),input[readonly][type="email"][aria-label="Account email"]')
      .filter(el => chrome(el) && !el.matches('input:not([readonly]),textarea,select'))
      .map(el => normal(el.matches('input') ? el.value : words(el)));
    const scopes = shown(document, '[aria-current="true"][data-workspace-type],button[data-workspace-type][aria-label="Current workspace"],[data-testid="workspace-switcher-trigger"][data-workspace-type]')
      .filter(chrome).map(el => normal(el.getAttribute('data-workspace-type')));
    if (!accounts.length || !accounts.every(value => value === email)
        || !scopes.length || !scopes.every(type => type === 'personal')) return 'unverified';
    if (shown(document, 'input[type="password"],iframe[src*="captcha"],[aria-label="CAPTCHA"]').length) return 'unverified';

    if (shown(panel,'[role="status"],[role="alert"],[data-testid="export-status"]').some(el =>
        /^(?:your (?:data )?export (?:is (?:already )?(?:being processed|in progress)|has (?:already )?been requested)|(?:a |an )?(?:data )?export has already been requested)[.!]?$/i.test(words(el)))) {
      if (action === 'reload') { location.reload(); return 'acted'; }
      return 'pending';
    }
    const dialogs = shown(document,'[role="alertdialog"],[role="dialog"],dialog[open]').filter(el => el !== panel);
    if (dialogs.length > 1) return 'unverified';
    const dialog = dialogs[0];
    if (dialog && !shown(dialog,'h1,h2,h3,[role="heading"]').some(el => /^(?:confirm (?:data )?export|export (?:your )?data)\??$/i.test(words(el)))) return 'unverified';
    const root = dialog || panel;
    const labels = dialog ? recipe.confirm : recipe.open;
    const buttons = shown(root,'button,[role="button"]').filter(el =>
      !el.disabled && el.getAttribute('aria-disabled') !== 'true' && labels.some(label => normal(words(el)) === normal(label)));
    if (buttons.length !== 1) return 'unverified';
    const phase = dialog ? 'confirm' : 'settings';
    if (action === 'inspect') return phase;
    if ((action === 'open' && phase === 'settings') || (action === 'confirm' && phase === 'confirm')) {
      buttons[0].click(); return 'acted';
    }
    return 'unverified';
  })()`;
}

function helpers(target: PersonalExportTarget, options: Omit<PersonalExportDriverOptions,'reserveSubmission'>) {
  const recipe = recipes[target.provider];
  const call = (executable: string, args: readonly string[]) => {
    if (options.signal?.aborted || (options.authorized && !options.authorized())) throw new Error('cancelled');
    return (options.invoke ?? invoke)(executable, args);
  };
  const js = (code: string, ...rest: string[]) =>
    call(path.join(options.browserDir, 'chrome-js.sh'), [target.profileId, code, recipe.origin, ...rest]);

  async function read(): Promise<string> {
    // Follow every page chunk, keeping only the fingerprint. A changed/oversize page never permits a click.
    let at = 0;
    let first: string | undefined;
    for (let chunk = 0; chunk < 20; chunk++) {
      if (options.signal?.aborted) throw new Error('cancelled');
      const p = JSON.parse(await js('--read-page', String(at)));
      if (options.signal?.aborted) throw new Error('cancelled');
      if (typeof p.pageFingerprint !== 'string' || p.pageFingerprint.length > 500 || p.offset !== at
        || !Number.isSafeInteger(p.totalChars) || p.totalChars < at || typeof p.text !== 'string'
        || (first !== undefined && p.pageFingerprint !== first)) throw new Error('page-changed');
      first = p.pageFingerprint;
      at += p.text.length;
      if (p.complete === true && p.nextOffset === null && at === p.totalChars) return p.pageFingerprint;
      if (!p.text.length || p.nextOffset !== at || at >= p.totalChars) throw new Error('incomplete-read');
    }
    throw new Error('page-too-long');
  }
  async function act(action: Action, fingerprint?: string): Promise<Page> {
    if (options.signal?.aborted) throw new Error('cancelled');
    const current = fingerprint ?? await read();
    if (options.signal?.aborted) throw new Error('cancelled');
    const value = await js(pageScript(target, current, action));
    return ['settings','confirm','pending','changed','acted'].includes(value) ? value as Page : 'unverified';
  }
  const wait = options.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 600)));
  async function durableAcknowledgment(fingerprint: string): Promise<PersonalExportResult> {
    const previousLoad = await js('String(performance.timeOrigin)');
    if (!Number.isFinite(Number(previousLoad)) || Number(previousLoad) <= 0 || await act('reload', fingerprint) !== 'acted') return { status: 'outcome-unknown' };
    for (let poll = 0; poll < 5; poll++) {
      await wait();
      const currentLoad = await js('String(performance.timeOrigin)');
      if (Number.isFinite(Number(currentLoad)) && Number(currentLoad) > Number(previousLoad)
          && await act('inspect') === 'pending') return { status: 'acknowledged' };
    }
    return { status: 'outcome-unknown' };
  }
  async function launch(): Promise<void> {
    const response = await call(path.join(options.browserDir, 'chrome-launch.sh'),
      ['--purpose', 'personal history export', target.profileId, recipe.origin + recipe.location]);
    if (!response.startsWith('already running')) return;
    // A pre-existing dedicated window may have an open chat. Never navigate over it.
    await read();
    const opened = await js(String.raw`(() => {
      const settings = ${JSON.stringify(recipe.location)};
      if (location.pathname + location.search + location.hash === settings) return 'ready';
      if (location.pathname !== '/' || location.hash || location.search
        || [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(el => (el.value || el.textContent || '').trim()))
        return 'busy';
      location.assign(settings);
      return 'opened';
    })()`);
    if (opened !== 'opened' && opened !== 'ready') throw new Error('occupied-profile');
  }
  return { read, act, wait, durableAcknowledgment, launch };
}

/** Only a provider state still visible on a fresh read can resolve an uncertain intent.
 * This observation may refresh personal settings. It never requests another export.
 */
export async function observePersonalExport(target: PersonalExportTarget,
  options: Omit<PersonalExportDriverOptions,'reserveSubmission'>): Promise<PersonalExportResult> {
  if (!validTarget(target)) return needs('invalid-target');
  try {
    const browser = helpers(target, options);
    const fingerprint = await browser.read();
    return await browser.act('inspect', fingerprint) === 'pending'
      ? await browser.durableAcknowledgment(fingerprint) : { status: 'outcome-unknown' };
  } catch {
    return { status: 'outcome-unknown' };
  }
}

export async function requestPersonalExport(target: PersonalExportTarget, options: PersonalExportDriverOptions): Promise<PersonalExportResult> {
  if (!validTarget(target)) return needs('invalid-target');
  if (options.signal?.aborted) return needs('cancelled');
  const browser = helpers(target, options);
  let reserved = false;
  try {
    await browser.launch();
    let page: Page = 'unverified';
    let fingerprint = '';
    for (let poll = 0; poll < 5; poll++) {
      fingerprint = await browser.read();
      page = await browser.act('inspect', fingerprint);
      if (page === 'pending') return needs('existing-request');
      if (page === 'settings') break;
      await browser.wait();
    }
    if (page !== 'settings') return needs('page-unverified');
    if (options.signal?.aborted) return needs('cancelled');
    reserved = await options.reserveSubmission();
    if (!reserved) return { status: 'already-reserved' };
    if (await browser.act('open', fingerprint) !== 'acted') return { status: 'outcome-unknown' };
    let confirmed = false;
    for (let poll = 0; poll < 8; poll++) {
      await browser.wait();
      fingerprint = await browser.read();
      page = await browser.act('inspect', fingerprint);
      if (page === 'pending') return await browser.durableAcknowledgment(fingerprint);
      if (page === 'confirm' && !confirmed) {
        confirmed = true;
        if (await browser.act('confirm', fingerprint) !== 'acted') break;
      }
    }
    return { status: 'outcome-unknown' };
  } catch {
    // Raw subprocess errors may contain account page contents or a one-time URL. Never surface them.
    return reserved ? { status: 'outcome-unknown' } : needs(options.signal?.aborted ? 'cancelled' : 'browser-unavailable');
  }
}
