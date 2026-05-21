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
}

export type WizardActionKind =
  | 'init'                  // run `instar init` with collected name + framework
  | 'add-user'              // `instar user add`
  | 'setup-telegram-agentic' // hand off to framework session w/ Playwright
  | 'setup-whatsapp-agentic'
  | 'setup-slack-agentic'
  | 'github-backup'         // create instar-<name> repo + push
  | 'start-server'          // `instar server start`
  | 'install-autostart'     // `instar autostart install`
  | 'send-greeting';        // greet via lifeline topic

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
  /** Optional preamble keys for the driver to look up narrative-prompt builders. */
  narrativeContext: string;
  input:
    | { kind: 'text'; placeholder?: string }
    | { kind: 'choice'; choices: Array<{ value: string; label: string }> };
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
      next: (answer) => {
        const choice = resolveChoice(answer, [
          { value: 'yes', label: 'Yes, let\'s go' },
          { value: 'no', label: 'Not right now' },
        ]) ?? 'yes';
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
      input: { kind: 'text', placeholder: 'e.g. echo, scout, codey' },
      next: (answer) => ({
        state: 'agent-role',
        updates: { agentName: answer.trim() || 'agent' },
      }),
    },

    'agent-role': {
      id: 'agent-role',
      kind: 'narrative-then-prompt',
      narrativeContext: 'agent-role',
      prompt:
        'In one sentence, what should this agent focus on? (you can change this anytime)',
      input: { kind: 'text', placeholder: 'e.g. coding assistant for this project' },
      next: (answer) => ({
        state: 'user-name',
        updates: { agentRole: answer.trim() || 'general-purpose autonomous agent' },
      }),
    },

    'user-name': {
      id: 'user-name',
      kind: 'narrative-then-prompt',
      narrativeContext: 'user-name',
      prompt: 'And what should the agent call you?',
      input: { kind: 'text', placeholder: 'your first name is fine' },
      next: (answer) => ({
        state: 'autonomy',
        updates: { userName: answer.trim() || 'friend' },
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
      next: (answer) => {
        const a = resolveChoice(answer, [
          { value: 'guided', label: 'Guided' },
          { value: 'proactive', label: 'Proactive' },
          { value: 'autonomous', label: 'Autonomous' },
        ]) as Autonomy | null;
        return { state: 'do-init', updates: { autonomy: a ?? 'proactive' } };
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
      next: (answer) => {
        const m = resolveChoice(answer, [
          { value: 'telegram', label: 'Telegram' },
          { value: 'whatsapp', label: 'WhatsApp' },
          { value: 'slack', label: 'Slack' },
          { value: 'skip', label: 'Skip' },
        ]) as Messaging | null;
        const messaging = m ?? 'skip';
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
