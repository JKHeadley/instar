/**
 * Runs the install flow over the state machine, recording each step in the ledger.
 *
 * It never waits for a person inside a tool call (spec 4.3). With no terminal, a missing answer
 * or a step that needs the person records why and returns, and `--resume` continues.
 */
import type {
  NarrativeState,
  WizardActionKind,
  WizardAnswers,
  WizardState,
} from '../setup-wizard/state-machine.js';
import type { StepResult } from '../../install/doorSteps.js';
import type { InstallProgress, InstallStatus } from './progress.js';

export type { StepResult };

export type StepHandler = (answers: WizardAnswers, progress: InstallProgress) => Promise<StepResult>;

export interface InstallIo {
  print: (text: string) => void;
  /** The person's answer. Only called when `interactive` is true. */
  ask: (prompt: string) => Promise<string>;
  interactive: boolean;
}

export interface RunInstallFlowOptions {
  states: Record<string, WizardState>;
  progress: InstallProgress;
  save: (progress: InstallProgress) => void;
  handlers: Partial<Record<WizardActionKind, StepHandler>>;
  io: InstallIo;
  /** Answers given up front, by state id. A harness writes these, and `--yes` supplies consent. */
  preset?: Record<string, string>;
  now?: () => Date;
}

/** What an answers file calls each question. */
export const ANSWER_FIELDS: Record<string, string> = {
  'agent-name': 'name',
  'agent-purpose': 'purpose',
  'door-choice': 'door',
  consent: '--yes',
};

const MAX_REPROMPTS = 5;

export async function runInstallFlow(options: RunInstallFlowOptions): Promise<InstallStatus> {
  const { states, progress, save, handlers, io, preset = {} } = options;
  const now = options.now ?? (() => new Date());

  const stop = (status: InstallStatus): InstallStatus => {
    progress.status = status;
    save(progress);
    return status;
  };
  const advance = (stateId: string, next: string, note?: string): void => {
    progress.completed[stateId] = { at: now().toISOString(), ...(note ? { note } : {}) };
    progress.cursor = next;
    delete progress.awaiting;
    delete progress.needs;
    delete progress.failure;
    progress.status = 'running';
    save(progress);
  };

  progress.status = 'running';
  save(progress);

  for (;;) {
    const state = states[progress.cursor];
    if (!state) {
      progress.failure = {
        state: progress.cursor,
        message: `This install stopped at a step this version doesn't know (${progress.cursor}).`,
        nextStep: 'Run the install again with the same version that started it.',
      };
      return stop('failed');
    }

    if (state.kind === 'terminal') {
      io.print(state.farewell);
      return stop(state.id === 'declined' ? 'declined' : 'complete');
    }

    if (state.kind === 'narrative-then-prompt') {
      const answer = await obtainAnswer(state, progress, io, preset);
      if (answer === null) return stop('needs-answers');
      const { state: next, updates } = state.next(answer, progress.answers);
      Object.assign(progress.answers, updates);
      advance(state.id, next);
      continue;
    }

    const handler = handlers[state.action.kind];
    if (!handler) {
      progress.failure = {
        state: state.id,
        message: `This version has no way to run "${state.action.description}".`,
        nextStep: 'Update Instar and run instar install --resume.',
      };
      return stop('failed');
    }
    io.print(`  ${state.action.description}...`);
    let result: StepResult;
    try {
      result = await handler(progress.answers, progress);
    } catch (err) {
      result = {
        kind: 'failed',
        message: `"${state.action.description}" stopped on an error: ${err instanceof Error ? err.message : String(err)}`,
        nextStep: 'Fix what it names if you can, then run instar install --resume.',
      };
    }
    if (result.kind === 'awaiting-person') {
      progress.awaiting = {
        state: state.id,
        instruction: result.instruction,
        ...(result.loginPid !== undefined ? { loginPid: result.loginPid, loginStamp: result.loginStamp } : {}),
      };
      io.print(`  ${result.instruction}`);
      return stop('awaiting-person');
    }
    if (result.kind === 'failed') {
      progress.failure = { state: state.id, message: result.message, nextStep: result.nextStep };
      io.print(`  ${result.message}`);
      io.print(`  ${result.nextStep}`);
      return stop('failed');
    }
    Object.assign(progress.answers, result.updates ?? {});
    if (result.note) io.print(`  ${result.note}`);
    advance(state.id, state.next(progress.answers), result.note);
  }
}

async function obtainAnswer(
  state: NarrativeState,
  progress: InstallProgress,
  io: InstallIo,
  preset: Record<string, string>,
): Promise<string | null> {
  const field = ANSWER_FIELDS[state.id] ?? state.id;
  // Shown even when the answer is already given: nothing installs silently (spec 4.1).
  if (state.renderPreamble) io.print(state.renderPreamble(progress.answers).split('\n').map((line) => `  ${line}`).join('\n'));
  const given = preset[state.id];
  if (given !== undefined) {
    const reason = state.validate?.(given) ?? null;
    if (reason === null) return given;
    if (!io.interactive) {
      progress.needs = { state: state.id, field, reason };
      return null;
    }
    io.print(`  ${reason}`);
  }
  if (!io.interactive) {
    progress.needs = { state: state.id, field };
    io.print(`  Missing answer: ${field}. Add it and run instar install --resume.`);
    return null;
  }
  const prompt = state.prompt;
  for (let attempt = 0; attempt < MAX_REPROMPTS; attempt++) {
    const answer = await io.ask(prompt);
    const reason = state.validate?.(answer) ?? null;
    if (reason === null) return answer;
    io.print(`  ${reason}`);
  }
  progress.needs = { state: state.id, field, reason: 'No usable answer.' };
  return null;
}
