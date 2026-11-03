/**
 * Wizard state machine — backbone of the conversational setup flow.
 *
 * This is the deterministic spine. Each state has a `prompt` (what the
 * user is asked), a list of `choices` (when multi-choice) or `kind:
 * 'text'` (free-text), and `nextState` derived from the user's answer.
 * Side-effects (init, user add, server start, etc.) are emitted as
 * `actions` the driver runs at appropriate transitions.
 *
 * Framework-specific drivers (codex-driver.ts) consume this state
 * machine. The framework's LLM is invoked ONLY to generate narrative
 * intro text for each state — not to drive transitions. Transitions
 * are owned by instar.
 *
 * This is the "Structure > Willpower" answer to the v1.2.11 failure
 * mode where Codex ignored the wizard SKILL.md's conversational
 * contract and executed the entire setup non-interactively. With the
 * state machine owning the flow, the framework cannot get out of hand
 * — each per-turn LLM call has a single bounded text job.
 */

export type Autonomy = 'guided' | 'proactive' | 'autonomous';
export type Messaging = 'telegram' | 'whatsapp' | 'slack' | 'skip';

export interface WizardAnswers {
  agentName?: string;
  agentRole?: string;
  userName?: string;
  autonomy?: Autonomy;
  messaging?: Messaging;
  telegramConfigured?: boolean;
  whatsappConfigured?: boolean;
  slackConfigured?: boolean;
  githubBackupRepo?: string;
  serverStarted?: boolean;
  /** Install flow only: the AI door the person chose. */
  door?: InstallDoor;
  /** Install flow only: the person agreed to what the installer listed. */
  installConsent?: boolean;
  /** Install flow only: the person agreed to start on reboot. Defaults to the install consent. */
  autostartConsent?: boolean;
}

/** The doors the installer can carry today. Other doors arrive with their proofs (spec section 5). */
export type InstallDoor = 'claude-code' | 'codex-cli';

export type WizardActionKind =
  | 'init'                  // run `instar init` with collected name + framework
  | 'add-user'              // `instar user add`
  | 'setup-telegram-agentic' // hand off to framework session w/ Playwright
  | 'setup-whatsapp-agentic'
  | 'setup-slack-agentic'
  | 'github-backup'         // create instar-<name> repo + push
  | 'start-server'          // `instar server start`
  | 'install-autostart'     // `instar autostart install`
  | 'send-greeting'         // greet via lifeline topic
  | 'install-preflight'     // disk, platform and tool checks; read-only
  | 'install-tools'         // tools the agent needs, such as tmux
  | 'install-tailscale-operator' // Linux: Tailscale operator rights; optional, never fails
  | 'door-install'          // install the chosen AI door
  | 'door-sign-in'          // prove the door is signed in, or send the person to sign in
  | 'agent-init'            // create the agent in its default home
  | 'owner-slot';           // today the viewing PIN; owner enrollment when that spec ships

export interface WizardAction {
  kind: WizardActionKind;
  description: string;
}

export type StateKind = 'narrative-then-prompt' | 'action' | 'terminal';

export interface NarrativeState {
  id: string;
  kind: 'narrative-then-prompt';
  /**
   * The question text the user sees. Framework drivers should NOT
   * regenerate this — it is the structural prompt, displayed verbatim.
   * Narrative intro text is rendered separately by the driver via a
   * per-turn LLM call.
   */
  prompt: string;
  /** Install flow: text always shown before this question, even when the answer was given up front. */
  renderPreamble?: (answers: WizardAnswers) => string;
  /** Optional preamble keys for the driver to look up narrative-prompt builders. */
  narrativeContext: string;
  input:
    | { kind: 'text'; placeholder?: string; required?: boolean }
    | { kind: 'choice'; choices: Array<{ value: string; label: string }> };
  /**
   * Validate the user's raw answer BEFORE the driver routes it through
   * `next`. Return `null` to accept; return a friendly message to
   * surface to the user and re-render the same state. This is how
   * the wizard catches buffered-Enter empty submissions on required
   * fields and unmatched choice inputs — surfaces an "I think
   * something slipped through, try again" reprompt instead of
   * silently defaulting.
   */
  validate?: (answer: string) => string | null;
  /** Where to go next based on the user's answer. Driver invokes this. */
  next: (answer: string, answers: WizardAnswers) => { state: string; updates: Partial<WizardAnswers> };
}

export interface ActionState {
  id: string;
  kind: 'action';
  action: WizardAction;
  /**
   * Where to go after the action completes. Drivers are responsible
   * for running the action and applying any answer updates.
   */
  next: (answers: WizardAnswers) => string;
}

export interface TerminalState {
  id: string;
  kind: 'terminal';
  /** Final farewell text. */
  farewell: string;
}

export type WizardState = NarrativeState | ActionState | TerminalState;

/**
 * Normalize a user-typed answer for choice matching: accepts the
 * 1-based numeric index OR the choice's `value` (case-insensitive
 * prefix-match against the label).
 */
export function resolveChoice(
  answer: string,
  choices: Array<{ value: string; label: string }>,
): string | null {
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return null;
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1].value;
  }
  for (const choice of choices) {
    if (choice.value.toLowerCase() === trimmed) return choice.value;
    if (choice.label.toLowerCase().startsWith(trimmed)) return choice.value;
  }
  return null;
}

/**
 * Standard validator: require non-empty trimmed text. Surfaces a
 * friendly reprompt when the user submits whitespace-only (the
 * classic buffered-Enter problem).
 */
export function requireNonEmpty(fieldLabel: string): (answer: string) => string | null {
  return (answer: string): string | null => {
    if (answer.trim().length === 0) {
      return `That looked blank — did an extra Enter slip through? Try typing a ${fieldLabel}.`;
    }
    return null;
  };
}

/**
 * Standard validator for a choice prompt: surfaces a friendly retry
 * when the user's input matches none of the offered choices (by
 * number, value, or label prefix).
 */
export function requireChoice(
  choices: Array<{ value: string; label: string }>,
): (answer: string) => string | null {
  return (answer: string): string | null => {
    if (resolveChoice(answer, choices) === null) {
      return `I didn't recognize that — try typing one of the numbers (1-${choices.length}) or the option name.`;
    }
    return null;
  };
}

/**
 * Build the wizard state machine for a fresh project-bound install
 * (the most common entry point — and the one observed broken in the
 * v1.2.11 instar-codey log). Restore / multi-user / multi-machine
 * scenarios are out of scope for the first hybrid-wizard PR; they
 * stay on the existing SKILL.md path until ported.
 */
export function buildFreshProjectInstall(): Record<string, WizardState> {
  const states: Record<string, WizardState> = {
    welcome: {
      id: 'welcome',
      kind: 'narrative-then-prompt',
      narrativeContext: 'welcome',
      prompt:
        'Before we begin: Instar stores your name, agent preferences, and ' +
        'messaging connection locally on this machine. If you enable GitHub ' +
        'backup, your config syncs to a private repo you control. No telemetry.\n' +
        '\n' +
        'Ready to get started?\n' +
        '\n' +
        '  1. Yes, let\'s go\n' +
        '  2. Not right now',
      input: {
        kind: 'choice',
        choices: [
          { value: 'yes', label: 'Yes, let\'s go' },
          { value: 'no', label: 'Not right now' },
        ],
      },
      validate: requireChoice([
        { value: 'yes', label: 'Yes, let\'s go' },
        { value: 'no', label: 'Not right now' },
      ]),
      next: (answer) => {
        const choice = resolveChoice(answer, [
          { value: 'yes', label: 'Yes, let\'s go' },
          { value: 'no', label: 'Not right now' },
        ])!; // validator guarantees non-null here
        return choice === 'no'
          ? { state: 'declined', updates: {} }
          : { state: 'agent-name', updates: {} };
      },
    },

    'agent-name': {
      id: 'agent-name',
      kind: 'narrative-then-prompt',
      narrativeContext: 'agent-name',
      prompt: 'What would you like to call your agent? (a single word works best)',
      input: { kind: 'text', placeholder: 'e.g. echo, scout, codey', required: true },
      validate: requireNonEmpty('name'),
      next: (answer) => ({
        state: 'agent-role',
        updates: { agentName: answer.trim() },
      }),
    },

    'agent-role': {
      id: 'agent-role',
      kind: 'narrative-then-prompt',
      narrativeContext: 'agent-role',
      prompt:
        'In one sentence, what should this agent focus on? (you can change this anytime)',
      input: { kind: 'text', placeholder: 'e.g. coding assistant for this project', required: true },
      validate: requireNonEmpty('focus or purpose'),
      next: (answer) => ({
        state: 'user-name',
        updates: { agentRole: answer.trim() },
      }),
    },

    'user-name': {
      id: 'user-name',
      kind: 'narrative-then-prompt',
      narrativeContext: 'user-name',
      prompt: 'And what should the agent call you?',
      input: { kind: 'text', placeholder: 'your first name is fine', required: true },
      validate: requireNonEmpty('name'),
      next: (answer) => ({
        state: 'autonomy',
        updates: { userName: answer.trim() },
      }),
    },

    autonomy: {
      id: 'autonomy',
      kind: 'narrative-then-prompt',
      narrativeContext: 'autonomy',
      prompt:
        'How much initiative should the agent take?\n' +
        '\n' +
        '  1. Guided — follows your lead, confirms before acting\n' +
        '  2. Proactive — takes initiative, asks when uncertain\n' +
        '  3. Autonomous — owns outcomes end-to-end',
      input: {
        kind: 'choice',
        choices: [
          { value: 'guided', label: 'Guided' },
          { value: 'proactive', label: 'Proactive' },
          { value: 'autonomous', label: 'Autonomous' },
        ],
      },
      validate: requireChoice([
        { value: 'guided', label: 'Guided' },
        { value: 'proactive', label: 'Proactive' },
        { value: 'autonomous', label: 'Autonomous' },
      ]),
      next: (answer) => {
        const a = resolveChoice(answer, [
          { value: 'guided', label: 'Guided' },
          { value: 'proactive', label: 'Proactive' },
          { value: 'autonomous', label: 'Autonomous' },
        ])! as Autonomy;
        return { state: 'do-init', updates: { autonomy: a } };
      },
    },

    'do-init': {
      id: 'do-init',
      kind: 'action',
      action: { kind: 'init', description: 'Create the agent\'s files and identity' },
      next: () => 'do-add-user',
    },

    'do-add-user': {
      id: 'do-add-user',
      kind: 'action',
      action: { kind: 'add-user', description: 'Register your user profile' },
      next: () => 'messaging',
    },

    messaging: {
      id: 'messaging',
      kind: 'narrative-then-prompt',
      narrativeContext: 'messaging',
      prompt:
        'How would you like to talk to your agent day-to-day?\n' +
        '\n' +
        '  1. Telegram (recommended — quickest to set up)\n' +
        '  2. WhatsApp\n' +
        '  3. Slack\n' +
        '  4. Skip for now',
      input: {
        kind: 'choice',
        choices: [
          { value: 'telegram', label: 'Telegram' },
          { value: 'whatsapp', label: 'WhatsApp' },
          { value: 'slack', label: 'Slack' },
          { value: 'skip', label: 'Skip' },
        ],
      },
      validate: requireChoice([
        { value: 'telegram', label: 'Telegram' },
        { value: 'whatsapp', label: 'WhatsApp' },
        { value: 'slack', label: 'Slack' },
        { value: 'skip', label: 'Skip' },
      ]),
      next: (answer) => {
        const messaging = resolveChoice(answer, [
          { value: 'telegram', label: 'Telegram' },
          { value: 'whatsapp', label: 'WhatsApp' },
          { value: 'slack', label: 'Slack' },
          { value: 'skip', label: 'Skip' },
        ])! as Messaging;
        if (messaging === 'telegram') return { state: 'do-telegram', updates: { messaging } };
        if (messaging === 'whatsapp') return { state: 'do-whatsapp', updates: { messaging } };
        if (messaging === 'slack') return { state: 'do-slack', updates: { messaging } };
        return { state: 'do-start-server', updates: { messaging } };
      },
    },

    'do-telegram': {
      id: 'do-telegram',
      kind: 'action',
      action: {
        kind: 'setup-telegram-agentic',
        description: 'Walk through Telegram bot creation with browser automation',
      },
      next: () => 'do-start-server',
    },

    'do-whatsapp': {
      id: 'do-whatsapp',
      kind: 'action',
      action: { kind: 'setup-whatsapp-agentic', description: 'Pair WhatsApp' },
      next: () => 'do-start-server',
    },

    'do-slack': {
      id: 'do-slack',
      kind: 'action',
      action: { kind: 'setup-slack-agentic', description: 'Create Slack app + channels' },
      next: () => 'do-start-server',
    },

    'do-start-server': {
      id: 'do-start-server',
      kind: 'action',
      action: { kind: 'start-server', description: 'Start the agent server' },
      next: () => 'do-install-autostart',
    },

    'do-install-autostart': {
      id: 'do-install-autostart',
      kind: 'action',
      action: { kind: 'install-autostart', description: 'Install auto-start on login' },
      next: () => 'do-send-greeting',
    },

    'do-send-greeting': {
      id: 'do-send-greeting',
      kind: 'action',
      action: { kind: 'send-greeting', description: 'Send the agent\'s first greeting' },
      next: () => 'complete',
    },

    complete: {
      id: 'complete',
      kind: 'terminal',
      farewell:
        'Your agent is set up and running. From here on, talk to it through your ' +
        'messaging channel — no terminal needed. It\'ll reach out when something ' +
        'needs your attention.\n' +
        '\n' +
        'Anything we set up just now (name, personality, autonomy, messaging) you ' +
        'can change anytime by just asking your agent — "make yourself less ' +
        'proactive", "switch me to WhatsApp", "I want to be called something ' +
        'else". The agent will update its own config and re-tune itself.',
    },

    declined: {
      id: 'declined',
      kind: 'terminal',
      farewell:
        'No problem. Run `npx instar` again whenever you\'re ready. Nothing was changed.',
    },
  };

  return states;
}

export const INITIAL_STATE = 'welcome';

/** Fixed text: no AI door is signed in yet, so nothing here can come from a model (spec 4.1). */
export const INSTALL_EXPLANATION =
  'An Instar agent is an AI that lives on your computer and works for you around the clock. ' +
  'It remembers what you tell it, does work on a schedule, keeps its promises, and asks you ' +
  'before anything risky.\n' +
  '\n' +
  'To work on its own it runs without a permission prompt for each action. It works while this ' +
  'computer is on and awake.';

export const INSTALL_DOOR_LABELS: Record<InstallDoor, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex',
};

export interface InstallFlowContext {
  /** Doors found on this machine, best first. */
  detectedDoors: InstallDoor[];
  /** The harness running the installer, when there is one. */
  runningInDoor?: InstallDoor;
  /** Refuses a name that can't be used, with a plain reason. */
  validateName: (name: string) => string | null;
  /** What the installer will do, listed in the single consent. */
  describePlan: (answers: WizardAnswers) => string[];
}

/** The door when there is nothing to ask: the harness running this, or the only one found. */
export function impliedInstallDoor(context: InstallFlowContext): InstallDoor | undefined {
  if (context.runningInDoor) return context.runningInDoor;
  return context.detectedDoors.length === 1 ? context.detectedDoors[0] : undefined;
}

/**
 * The installer's flow (spec install-experience 4.1). Deterministic and fixed-text up to sign-in,
 * with at most three questions before the single consent: name, purpose and, only when ambiguous,
 * which AI door. Lives beside the fresh-project flow, which stays until the comparison in 4.2.
 */
export function buildInstallFlow(context: InstallFlowContext): Record<string, WizardState> {
  const doorChoices = (Object.keys(INSTALL_DOOR_LABELS) as InstallDoor[]).map((value) => ({
    value,
    label: context.detectedDoors.includes(value)
      ? `${INSTALL_DOOR_LABELS[value]} (found on this computer)`
      : INSTALL_DOOR_LABELS[value],
  }));
  const consentChoices = [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ];
  const action = (id: string, kind: WizardActionKind, description: string, next: string): ActionState => ({
    id,
    kind: 'action',
    action: { kind, description },
    next: () => next,
  });

  return {
    'do-preflight': action('do-preflight', 'install-preflight', 'Check this computer', 'agent-name'),

    'agent-name': {
      id: 'agent-name',
      kind: 'narrative-then-prompt',
      narrativeContext: 'agent-name',
      prompt: 'What would you like to call your agent? (one word works best)',
      input: { kind: 'text', placeholder: 'e.g. scout', required: true },
      validate: (answer) => requireNonEmpty('name')(answer) ?? context.validateName(answer.trim()),
      next: (answer) => ({ state: 'agent-purpose', updates: { agentName: answer.trim() } }),
    },

    'agent-purpose': {
      id: 'agent-purpose',
      kind: 'narrative-then-prompt',
      narrativeContext: 'agent-role',
      prompt: 'In one sentence, what do you want help with? (you can change this anytime)',
      input: { kind: 'text', placeholder: 'e.g. keep my week organized', required: true },
      validate: requireNonEmpty('sentence'),
      next: (answer) => {
        const door = impliedInstallDoor(context);
        return door
          ? { state: 'consent', updates: { agentRole: answer.trim(), door } }
          : { state: 'door-choice', updates: { agentRole: answer.trim() } };
      },
    },

    'door-choice': {
      id: 'door-choice',
      kind: 'narrative-then-prompt',
      narrativeContext: 'door-choice',
      prompt:
        'Which AI do you want to use?\n' +
        '\n' +
        doorChoices.map((c, i) => `  ${i + 1}. ${c.label}`).join('\n'),
      input: { kind: 'choice', choices: doorChoices },
      validate: requireChoice(doorChoices),
      next: (answer) => ({
        state: 'consent',
        updates: { door: resolveChoice(answer, doorChoices)! as InstallDoor },
      }),
    },

    consent: {
      id: 'consent',
      kind: 'narrative-then-prompt',
      narrativeContext: 'consent',
      prompt: 'Is that okay?\n\n  1. Yes\n  2. No',
      renderPreamble: (answers) =>
        'This will:\n' +
        '\n' +
        context.describePlan(answers).map((line) => `  - ${line}`).join('\n') +
        '\n\n' +
        'This creates a new agent. To put an existing agent here, ask that agent.',
      input: { kind: 'choice', choices: consentChoices },
      validate: requireChoice(consentChoices),
      next: (answer) =>
        resolveChoice(answer, consentChoices) === 'yes'
          ? { state: 'do-install-tools', updates: { installConsent: true } }
          : { state: 'declined', updates: { installConsent: false } },
    },

    'do-install-tools': action('do-install-tools', 'install-tools', 'Install the tools your agent needs', 'do-tailscale-operator'),
    'do-tailscale-operator': action('do-tailscale-operator', 'install-tailscale-operator', 'Let your agent use Tailscale', 'do-door-install'),
    'do-door-install': action('do-door-install', 'door-install', 'Install your AI', 'do-door-sign-in'),
    'do-door-sign-in': action('do-door-sign-in', 'door-sign-in', 'Check your AI is signed in', 'do-init'),
    'do-init': action('do-init', 'agent-init', 'Create your agent', 'do-start-server'),
    'do-start-server': action('do-start-server', 'start-server', 'Start your agent', 'do-install-autostart'),
    'do-install-autostart': action('do-install-autostart', 'install-autostart', 'Set your agent to start after a reboot', 'do-owner-slot'),
    'do-owner-slot': action('do-owner-slot', 'owner-slot', 'Set up your dashboard access', 'complete'),

    complete: {
      id: 'complete',
      kind: 'terminal',
      farewell: 'Your agent is running.',
    },

    declined: {
      id: 'declined',
      kind: 'terminal',
      farewell: 'No problem. Nothing was installed. Run this again whenever you\'re ready.',
    },
  };
}

export const INSTALL_INITIAL_STATE = 'do-preflight';
