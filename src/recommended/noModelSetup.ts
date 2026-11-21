/**
 * Setup with no AI model (docs/specs/recommended-services.md, Real-problem events, "With every door down"): when
 * every AI door this agent uses is unusable, no setup session can run, so a yes to a second AI subscription is
 * carried out by fixed steps here instead. Every message is a fixed template; nothing reads or stores a token.
 *
 * Also the `provider-exhausted` predicate: whether every enabled door is unusable right now, and the episode
 * counter that turns "down for 30 minutes, twice in 7 days" into one problem.
 */
import type { InstallDoor } from '../commands/setup-wizard/state-machine.js';
import type { SignedInVerdict } from '../install/doors.js';
import { AI_DOORS, DOOR_NAMES, secondDoorCandidates } from './aiDoors.js';

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

/** A door counts as down only after this long. */
export const DOORS_DOWN_EPISODE_MS = 30 * MIN_MS;
/** Two episodes inside this window are one problem. */
export const DOORS_DOWN_WINDOW_MS = 7 * DAY_MS;
export const DOORS_DOWN_EPISODES = 2;

export interface PoolAccountView {
  framework: string;
  status: string;
}

/**
 * True only when the pool knows every door this agent uses, and every account of every such door is unusable
 * (not `active` or `warming`). A door with no pool account is unknown, and unknown is never "down", so an agent
 * without a subscription pool never trips this.
 */
export function everyDoorDown(enabled: readonly string[], accounts: readonly PoolAccountView[]): boolean {
  const doors = (enabled.length ? enabled.filter((d) => (AI_DOORS as readonly string[]).includes(d)) : [...AI_DOORS].filter((d) => accounts.some((a) => a.framework === d)));
  if (!doors.length) return false;
  return doors.every((door) => {
    const mine = accounts.filter((a) => a.framework === door);
    return mine.length > 0 && mine.every((a) => a.status !== 'active' && a.status !== 'warming');
  });
}

export interface DoorsDownState {
  /** When the current run of "every door down" began, or null while a door is usable. */
  downSince: number | null;
  /** Whether the current run has already been counted as an episode. */
  counted: boolean;
  /** When each counted episode reached 30 minutes, newest last, inside the window. */
  episodes: number[];
}

export const EMPTY_DOORS_DOWN: DoorsDownState = { downSince: null, counted: false, episodes: [] };

/** One sample of the predicate. Pure: the per-machine file stores whatever this returns. */
export function noteDoorsSample(state: DoorsDownState, down: boolean, nowMs: number): { state: DoorsDownState; problem: boolean } {
  const episodes = state.episodes.filter((t) => Number.isFinite(t) && nowMs - t < DOORS_DOWN_WINDOW_MS && t <= nowMs);
  if (!down) return { state: { downSince: null, counted: false, episodes }, problem: false };
  const continuing = state.downSince !== null && Number.isFinite(state.downSince) && state.downSince <= nowMs;
  const downSince = continuing ? state.downSince! : nowMs;
  const alreadyCounted = continuing && state.counted;
  if (alreadyCounted || nowMs - downSince < DOORS_DOWN_EPISODE_MS) {
    return { state: { downSince, counted: alreadyCounted, episodes }, problem: false };
  }
  const next = [...episodes, nowMs].slice(-DOORS_DOWN_EPISODES);
  const problem = next.length >= DOORS_DOWN_EPISODES;
  return { state: { downSince, counted: true, episodes: problem ? [] : next }, problem };
}

export interface NoModelDoorDeps {
  enabled(): string[];
  installed(door: InstallDoor): boolean;
  /** Whether the door's sign-in finishes with one tap on a link (a device code), so no reply has to be read back. */
  oneTapSignIn(door: InstallDoor): boolean;
  /** Installs the door's program for this user (no administrator rights). True when it is installed after. */
  install(door: InstallDoor): Promise<boolean>;
  /** Starts the door's own sign-in and returns its public link (and code), or null when none appeared. */
  startSignIn(door: InstallDoor): Promise<{ verificationUrl: string; userCode?: string } | null>;
  signedIn(door: InstallDoor): Promise<SignedInVerdict>;
  /** Lists the door in this agent's settings (the recipe's server step). */
  enable(door: InstallDoor): boolean;
  tell(text: string): void;
  /** False once the person said no (or the yes was withdrawn): the run stops without switching anything on. */
  stillWanted(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type NoModelResult = { result: 'pass' | 'fail'; detail: string };

/** How long the person has to tap the sign-in link before this attempt ends. */
export const SIGN_IN_WAIT_MS = 15 * MIN_MS;
export const SIGN_IN_POLL_MS = 15_000;

/**
 * The second-door recipe as fixed steps: pick the first candidate door, install it if needed, send the person
 * its sign-in link in fixed words, wait for the sign-in, then list it in this agent's settings. A step that
 * can't happen ends this attempt with `fail`; the regular check's bounded restart tries again later.
 */
export async function runSecondDoorWithoutModel(deps: NoModelDoorDeps): Promise<NoModelResult> {
  const door = secondDoorCandidates(deps.enabled())[0];
  if (!door) return { result: 'fail', detail: 'There is no other AI provider I know how to add.' };
  const name = DOOR_NAMES[door];
  if (!deps.stillWanted()) return { result: 'fail', detail: 'Setup was stopped.' };
  if ((await deps.signedIn(door)) === 'signed-in' && deps.installed(door)) {
    deps.enable(door);
    deps.tell(`${name} was already signed in on this machine, so I've switched it on for me. You now have a second AI provider I can work on.`);
    return { result: 'pass', detail: `${name} was already signed in.` };
  }
  if (!deps.oneTapSignIn(door)) {
    deps.tell(`${name}'s sign-in needs a code pasted back to me, and I can't read replies while every AI provider I use is out. I'll set ${name} up as soon as one of them is back.`);
    return { result: 'fail', detail: `${name} has no one-tap sign-in.` };
  }
  if (!deps.installed(door) && !(await deps.install(door))) {
    deps.tell(`I couldn't install ${name} on this machine, so the second AI subscription isn't set up yet. I'll try again later.`);
    return { result: 'fail', detail: `${name} could not be installed.` };
  }
  const artifact = await deps.startSignIn(door);
  if (!artifact) {
    deps.tell(`${name} didn't give me a sign-in link, so the second AI subscription isn't set up yet. I'll try again later.`);
    return { result: 'fail', detail: `${name} printed no sign-in link.` };
  }
  deps.tell([
    `To finish adding ${name}, open this link and sign in with your own ${name} account:`,
    artifact.verificationUrl,
    ...(artifact.userCode ? [`When it asks for a code, enter: ${artifact.userCode}`] : []),
    `If you don't have a ${name} subscription yet, it's a paid plan you'd choose on their site; nothing is bought for you.`,
    'I can\'t think right now because every AI provider I use is out, so I\'m doing this step by fixed steps. You don\'t need to reply.',
  ].join('\n'));
  const deadline = deps.now() + SIGN_IN_WAIT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(SIGN_IN_POLL_MS);
    if (!deps.stillWanted()) return { result: 'fail', detail: 'Setup was stopped.' };
    if ((await deps.signedIn(door)) === 'signed-in') {
      deps.enable(door);
      deps.tell(`${name} is signed in and switched on for me. When my main provider is out, you can ask me to move a conversation onto ${name}.`);
      return { result: 'pass', detail: `${name} signed in.` };
    }
  }
  deps.tell(`The ${name} sign-in link wasn't used in time, so it has expired. I'll send a fresh one later.`);
  return { result: 'fail', detail: `${name} sign-in was not completed in time.` };
}

/** What the fixed Tailscale steps can read: signed in and running, installed but not, not installed, or no answer. */
export type TailscaleState = 'running' | 'not-running' | 'missing' | 'unknown';

export interface NoModelTailscaleDeps {
  status(): Promise<TailscaleState>;
  /** Installs Tailscale with no administrator rights (Homebrew on a Mac). True when it is installed after. */
  install(): Promise<boolean>;
  /** Starts Tailscale's background service if it isn't running. True when the program answers after. */
  startService(): Promise<boolean>;
  /** Starts the sign-in and returns its public link (https://login.tailscale.com/...), or null when none appeared. */
  startSignIn(): Promise<string | null>;
  tell(text: string): void;
  stillWanted(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * The Tailscale recipe as fixed steps, for when there is no address and every AI door is down, so the yes page
 * can't be reached and no setup session can run. Never signs in with a key or a login already held: the
 * person's own tap on Tailscale's link is the sign-in.
 */
export async function runTailscaleWithoutModel(deps: NoModelTailscaleDeps): Promise<NoModelResult> {
  if (!deps.stillWanted()) return { result: 'fail', detail: 'Setup was stopped.' };
  let state = await deps.status();
  if (state === 'running') {
    deps.tell("Tailscale was already running on this machine, so I have an address. I'll use it for the yes page from now on.");
    return { result: 'pass', detail: 'Tailscale was already running.' };
  }
  if (state === 'missing') {
    if (!(await deps.install())) {
      deps.tell("I couldn't install Tailscale on this machine without administrator rights, so I don't have an address yet. When one of my AI providers is back I'll work out another way and tell you what I need.");
      return { result: 'fail', detail: 'Tailscale could not be installed without administrator rights.' };
    }
    state = await deps.status();
  }
  if (state !== 'running' && !(await deps.startService())) {
    deps.tell("Tailscale is installed but its background service won't start without administrator rights, so I don't have an address yet. When one of my AI providers is back I'll work out another way.");
    return { result: 'fail', detail: "Tailscale's service did not start." };
  }
  const link = await deps.startSignIn();
  if (!link) {
    deps.tell("Tailscale didn't give me a sign-in link, so I don't have an address yet. I'll try again later.");
    return { result: 'fail', detail: 'Tailscale printed no sign-in link.' };
  }
  deps.tell([
    'To give me a private address you can reach from your phone, open this link and sign in to Tailscale with your own Google, GitHub or other login. If you have no Tailscale account yet, that same tap makes one, free:',
    link,
    "I can't think right now because every AI provider I use is out, so I'm doing this by fixed steps. You don't need to reply.",
  ].join('\n'));
  const deadline = deps.now() + SIGN_IN_WAIT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(SIGN_IN_POLL_MS);
    if (!deps.stillWanted()) return { result: 'fail', detail: 'Setup was stopped.' };
    if ((await deps.status()) === 'running') {
      deps.tell("Tailscale is signed in on this machine. As soon as my yes page can be reached, I'll send you the link to add a second AI subscription.");
      return { result: 'pass', detail: 'Tailscale signed in.' };
    }
  }
  deps.tell("The Tailscale sign-in link wasn't used in time, so it has expired. I'll send a fresh one later.");
  return { result: 'fail', detail: 'Tailscale sign-in was not completed in time.' };
}
