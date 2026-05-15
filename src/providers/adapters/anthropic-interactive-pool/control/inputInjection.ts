/**
 * InputInjection via tmux send-keys on the underlying pool session.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  InputInjection,
  InputInjectionOptions,
  ControlKey,
} from '../../../primitives/control/inputInjection.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError, UnsupportedCapabilityError } from '../../../errors.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';
import type { InteractivePoolConfig } from '../config.js';
import { poolSessionForHandle } from '../transport/warmSessionInbox.js';

const execFileAsync = promisify(execFile);

const KEY_MAP: Record<ControlKey, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  BackTab: 'BTab',
  Backspace: 'BSpace',
  Delete: 'DC',
  'C-c': 'C-c',
  'C-d': 'C-d',
  'C-z': 'C-z',
  'C-l': 'C-l',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
};

class InteractivePoolInputInjection implements InputInjection {
  readonly capability = CapabilityFlag.InputInjection;

  constructor(private readonly config: InteractivePoolConfig) {}

  async send(
    session: SessionHandle,
    input: string,
    options?: InputInjectionOptions,
  ): Promise<void> {
    const ps = poolSessionForHandle(session);
    if (!ps) {
      throw new UnsupportedCapabilityError(
        `Unknown handle: ${session}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    const submit = options?.submitOnEnter !== false;
    const padding = options?.paddingMs ?? 500;
    try {
      await execFileAsync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${ps.tmuxName}:`, '-l', input],
        { timeout: 5000 },
      );
      if (submit) {
        if (padding > 0) {
          await new Promise((resolve) => setTimeout(resolve, padding));
        }
        await execFileAsync(
          this.config.tmuxPath,
          ['send-keys', '-t', `=${ps.tmuxName}:`, 'Enter'],
          { timeout: 5000 },
        );
      }
    } catch (err) {
      throw new UnexpectedError(
        `Failed to inject input: ${(err as Error).message}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
        err,
      );
    }
  }

  async sendKey(session: SessionHandle, key: ControlKey): Promise<void> {
    const ps = poolSessionForHandle(session);
    if (!ps) {
      throw new UnsupportedCapabilityError(
        `Unknown handle: ${session}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    const tk = KEY_MAP[key];
    if (!tk) {
      throw new UnexpectedError(`Unmapped key: ${key}`, ANTHROPIC_INTERACTIVE_POOL_ID);
    }
    await execFileAsync(this.config.tmuxPath, ['send-keys', '-t', `=${ps.tmuxName}:`, tk], {
      timeout: 5000,
    });
  }
}

export function createInputInjection(config: InteractivePoolConfig): InputInjection {
  return new InteractivePoolInputInjection(config);
}
