/** Turns one machine's live status into the one next setup step. Pure: it holds
 * no state and gates nothing. Admission stays with DirectDesktopAccess. All the
 * wording lives here so the dashboard and the app show the same words. */

export type DesktopSetupActionId = 'turn-on' | 'turn-off' | 'show-prompt' | 'open-settings' | 'check';
export type DesktopSetupPane = 'screen' | 'input';

export interface DesktopSetupAction {
  id: DesktopSetupActionId;
  label: string;
  pane?: DesktopSetupPane;
}

/** What a target reports about itself. Every field but `reachable` may be
 * absent: a peer's reply is untrusted and an old peer reports less. */
export interface DesktopSetupStatus {
  reachable: boolean;
  /** The peer answered, but its Instar has no setup route yet. */
  needsUpdate?: boolean;
  platform?: string;
  wsl?: boolean;
  restartPending?: boolean;
  /** Whether this machine lets a peer turn it on. */
  peerClaim?: boolean;
  /** Config on disk now. */
  configured?: boolean;
  /** Config this process started with. */
  configuredAtBoot?: boolean;
  frontMachineId?: string;
  targetConstructed?: boolean;
  status?: string;
  code?: string;
  screenPermission?: boolean;
  inputPermission?: boolean;
  displayCount?: number;
  sessionActive?: boolean;
  consoleSessionPresent?: boolean;
  onConsole?: boolean;
  loginDone?: boolean;
  screenLocked?: boolean;
  screenGrant?: string;
  inputGrant?: string;
  helperPath?: string;
  bootstrapFailure?: { phase?: string; code?: string };
}

export interface DesktopSetupContext {
  label: string;
  /** The machine the operator is using as the front. */
  frontMachineId: string;
  frontLabel: string;
  /** Inside the window after a restart was asked for. */
  restarting?: boolean;
  /** This row is a machine other than the one serving the page. */
  isPeer?: boolean;
  /** This machine has no front id recorded yet: Set up makes it the front. */
  becomesFront?: boolean;
  /** The front itself is not on yet, so a peer cannot be started. */
  frontNotReady?: boolean;
}

export interface DesktopSetupStep {
  state: string;
  ready: boolean;
  title: string;
  detail: string;
  actions: DesktopSetupAction[];
  fallback?: string;
  note?: string;
}

const CHECK: DesktopSetupAction = { id: 'check', label: 'Check again' };
const TURN_OFF: DesktopSetupAction = { id: 'turn-off', label: 'Turn off' };
const TRUST_THE_CHECK = 'Go by this page, not by that list. The list can look empty or show several entries even when the permission works, so this page asks the Mac directly.';
const ONLY_THE_HELPER = 'Allow only a pop-up that names instar-desktop-host. If one names tmux or another program, choose Don’t Allow: that permission can change at the next restart.';

function permissionFallback(pane: DesktopSetupPane, helperPath: string | undefined): string {
  const page = pane === 'screen'
    ? 'Screen & System Audio Recording (on older macOS, Screen Recording)' : 'Accessibility';
  const add = helperPath
    ? ` If it is not listed, press +, then press Command-Shift-G, paste ${helperPath}, and press Open.`
    : ' If it is not listed, press + and add it.';
  return `On the Mac, open the Apple menu → System Settings → Privacy & Security → ${page}, then turn on instar-desktop-host.${add}`;
}

function permissionStep(pane: DesktopSetupPane, label: string, step: number, of: number, s: DesktopSetupStatus): DesktopSetupStep {
  const name = pane === 'screen' ? 'Screen Recording' : 'Accessibility';
  const lead = of > 1 ? `Step ${step} of ${of}. ` : '';
  return {
    state: pane === 'screen' ? 'needs-screen' : 'needs-input',
    ready: false,
    title: `Allow ${name} on ${label}`,
    detail: `${lead}This needs a person at ${label}. Press Show the pop-up, then choose Allow on that Mac. If nothing appears, press Open the settings page and turn on instar-desktop-host there. ${ONLY_THE_HELPER} This page updates by itself. ${TRUST_THE_CHECK}`,
    actions: [
      { id: 'show-prompt', label: 'Show the pop-up' },
      { id: 'open-settings', label: 'Open the settings page', pane },
      CHECK,
    ],
    fallback: permissionFallback(pane, s.helperPath),
  };
}

function atTheMac(state: string, title: string, detail: string): DesktopSetupStep {
  return { state, ready: false, title, detail, actions: [CHECK] };
}

export function desktopSetupStep(s: DesktopSetupStatus, ctx: DesktopSetupContext): DesktopSetupStep {
  const { label } = ctx;
  const place = s.platform === 'darwin' ? 'the Mac' : s.platform === 'linux' ? 'the PC' : 'the machine';
  const restartingStep: DesktopSetupStep = { state: 'restarting', ready: false, title: `Restarting ${label}`,
    detail: 'This usually takes about a minute, and a machine that is busy may finish its work first. This page updates by itself.',
    actions: [CHECK] };
  if (!s.reachable) {
    if (ctx.restarting) return restartingStep;
    return { state: 'unreachable', ready: false, title: `Can’t reach ${label}`,
      detail: `${label} did not answer. It may be asleep, off, or off the network. Wake it, then press Check again.`,
      actions: [CHECK] };
  }
  if (s.needsUpdate) {
    return { state: 'needs-update', ready: false, title: `${label} needs an update first`,
      detail: `${label} runs an older Instar that cannot be set up from here. It updates on its own; try again after that.`,
      actions: [CHECK] };
  }
  if (s.frontMachineId && s.frontMachineId !== ctx.frontMachineId) {
    return { state: 'other-front', ready: false, title: `${label} is tied to another machine`,
      detail: `${label} takes Remote Desktop from a different front machine, not ${ctx.frontLabel}. Ask your agent to change that, or open this page on that front.`,
      actions: [CHECK] };
  }
  if (s.bootstrapFailure) {
    return { state: 'windows-companion', ready: false, title: `${label} needs its Windows companion`,
      detail: `Remote Desktop on a Windows PC runs through a companion app, and its install stopped${s.bootstrapFailure.phase ? ` at: ${s.bootstrapFailure.phase}` : ''}. Sign in at the PC, then ask your agent to try the install again.`,
      actions: [CHECK] };
  }
  if (s.platform === 'linux' && s.wsl !== true) {
    return { state: 'not-supported', ready: false, title: `${label} can’t run Remote Desktop yet`,
      detail: 'A Linux machine with no Windows underneath is not supported yet.', actions: [] };
  }
  if (s.restartPending) return restartingStep;
  if (!s.configured) {
    if (ctx.frontNotReady) {
      return { state: 'front-first', ready: false, title: `Set up ${ctx.frontLabel} first`,
        detail: `${ctx.frontLabel} is the machine this page runs on, and ${label} is reached through it. Once ${ctx.frontLabel} is on, ${label} can be set up here.`,
        actions: [CHECK] };
    }
    if (ctx.isPeer && s.peerClaim === false) {
      return { state: 'setup-off', ready: false, title: `${label} can’t be set up from here yet`,
        detail: `Remote Desktop is off on ${label}, and it does not take setup from another machine yet. Open this page on ${label} itself, or ask your agent to switch on guided setup there.`,
        actions: [CHECK] };
    }
    return { state: 'off', ready: false, title: `Remote Desktop is off on ${label}`,
      detail: `Set up turns it on for ${label} and restarts its Instar server. Conversations continue after a short pause.${ctx.becomesFront ? ` ${label} becomes the front: the machine you open Remote Desktop from.` : ''}`,
      actions: [{ id: 'turn-on', label: 'Set up' }] };
  }
  if (!s.configuredAtBoot) {
    if (ctx.restarting) return restartingStep;
    return { state: 'restart-needed', ready: false, title: `${label} needs a restart`,
      detail: 'Remote Desktop is switched on, but it starts only after its Instar server restarts.',
      actions: [{ id: 'turn-on', label: 'Restart now' }] };
  }
  if (!s.targetConstructed || s.status === 'target-unavailable') {
    if (s.platform === 'linux') {
      return { state: 'windows-companion', ready: false, title: `${label} needs its Windows companion`,
        detail: 'On a Windows PC, Remote Desktop runs through a companion app in the signed-in Windows session. Sign in at the PC, then press Check again.',
        actions: [CHECK] };
    }
    return { state: 'target-unavailable', ready: false, title: `${label} could not start Remote Desktop`,
      detail: 'The setting is on and it has restarted, but its identity or its name in the machine pool could not be confirmed, so another restart will not help. Ask your agent to look at it.',
      actions: [CHECK, TURN_OFF] };
  }
  if (s.status === 'probe-error') {
    return { state: 'probe-error', ready: false, title: `${label} did not finish its check`,
      detail: 'The desktop helper on that machine did not answer. Press Check again. If this repeats, ask your agent to look at it.',
      actions: [CHECK] };
  }
  if (s.sessionActive !== true || s.screenLocked === true) {
    if (s.consoleSessionPresent === false) {
      return atTheMac('no-user', `Sign in at ${label}`, `Nobody is signed in at its screen. Sign in at ${label}. This page updates by itself.`);
    }
    if (s.onConsole === false) {
      return atTheMac('other-user', `Switch user at ${label}`, `Another user is on its screen. Switch back to the agent’s user at ${label}. This page updates by itself.`);
    }
    if (s.loginDone === false) {
      return atTheMac('sign-in-window', `Sign in at ${label}`, `It is at its sign-in window. Sign in at ${label}. This page updates by itself.`);
    }
    if (s.screenLocked === true) {
      return atTheMac('locked', `Wake and unlock ${label}`, `${label} is locked. Pop-ups do nothing until it is unlocked, so wake it and sign in at ${place}. This page updates by itself.`);
    }
    return atTheMac('session-unknown', `Check ${label} in person`, `${label} is not reporting an active desktop. Its screen may be asleep or locked. Wake it and sign in at ${place}. This page updates by itself.`);
  }
  if (s.displayCount === 0) {
    return atTheMac('no-display', `Wake the screen on ${label}`, `No active display is available. Wake its screen or connect a display. This page updates by itself.`);
  }
  if (s.status !== 'ready') {
    if (s.platform === 'darwin' && s.screenLocked !== false) {
      return atTheMac('session-unknown', `Check ${label} in person`, `${label} is not saying whether it is locked. Wake it and sign in at ${place}. This page updates by itself.`);
    }
    if (s.platform === 'darwin') {
      const missing = (s.screenPermission === false ? 1 : 0) + (s.inputPermission === false ? 1 : 0);
      if (s.screenPermission === false) return permissionStep('screen', label, 1, missing, s);
      if (s.inputPermission === false) return permissionStep('input', label, missing === 2 ? 2 : 1, missing, s);
    }
    return { state: 'not-ready', ready: false, title: `${label} is not ready yet`,
      detail: 'Its desktop reports that it cannot be used right now. Press Check again. If this repeats, ask your agent to look at it.',
      actions: [CHECK] };
  }
  const borrowed = s.platform === 'darwin'
    && (s.screenGrant === 'inherited' || s.inputGrant === 'inherited');
  return { state: 'ready', ready: true, title: `${label} is ready`,
    detail: 'The live check passed, so you can open it now.',
    actions: borrowed ? [{ id: 'show-prompt', label: 'Ask for the helper’s own permission' }, CHECK, TURN_OFF] : [CHECK, TURN_OFF],
    ...(borrowed ? { note: `It works now through a permission another program holds, which a restart can change. To give the helper its own, press the button and choose Allow on that Mac; this note goes away once the live check confirms it. ${ONLY_THE_HELPER} ${TRUST_THE_CHECK}` } : {}) };
}

const BOOLEANS = ['configured', 'configuredAtBoot', 'targetConstructed', 'wsl', 'restartPending', 'peerClaim', 'screenPermission',
  'inputPermission', 'sessionActive', 'consoleSessionPresent', 'onConsole', 'loginDone',
  'screenLocked'] as const;
const clip = (value: unknown, max: number, shape: RegExp): string | undefined =>
  typeof value === 'string' && value.length <= max && shape.test(value) ? value : undefined;

/** A peer's reply is untrusted: unknown fields drop and every value is checked. */
export function parseDesktopSetupStatus(raw: unknown): DesktopSetupStatus {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const status: DesktopSetupStatus = { reachable: true };
  for (const key of BOOLEANS) if (typeof input[key] === 'boolean') status[key] = input[key] as boolean;
  const platform = clip(input.platform, 16, /^[a-z0-9]+$/);
  if (platform) status.platform = platform;
  const front = clip(input.frontMachineId, 40, /^m_[a-f0-9]{32}$/);
  if (front) status.frontMachineId = front;
  const state = clip(input.status, 24, /^[a-z-]+$/);
  if (state) status.status = state;
  const code = clip(input.code, 64, /^[a-z-]+$/);
  if (code) status.code = code;
  for (const key of ['screenGrant', 'inputGrant'] as const) {
    if (input[key] === 'own' || input[key] === 'inherited' || input[key] === 'none') status[key] = input[key] as string;
  }
  // Shown verbatim to the owner as a path to paste. Printable, no separators.
  const helper = clip(input.helperPath, 300, /^\/[A-Za-z0-9._\/ -]+$/);
  if (helper) status.helperPath = helper;
  if (Number.isSafeInteger(input.displayCount) && (input.displayCount as number) >= 0
    && (input.displayCount as number) <= 16) status.displayCount = input.displayCount as number;
  const failure = input.bootstrapFailure as { phase?: unknown } | undefined;
  const phase = clip(failure?.phase, 48, /^[a-z0-9 -]+$/i);
  if (phase) status.bootstrapFailure = { phase };
  return status;
}
