/**
 * InputInjection implementation for anthropic-headless via tmux send-keys.
 */
/*
 * RULE 3: EXEMPT — this is a WRITE path, not a state detector.
 *
 * The Rule 3 pattern match fires on `tmux send-keys`, but every use here is
 * outbound: push literal text into a pane, then press Enter. Nothing in this
 * file reads pane content, parses provider output, or infers session state, so
 * there is no detection heuristic to carry a canary or a stability rationale —
 * the failure mode this file can have is "the text did not arrive", which is a
 * transport concern and is covered structurally instead:
 *
 *   - sends funnel through `buildLiteralSendArgs`/`chunkLiteralForTmux`
 *     (src/core/tmuxLiteralSend.ts), which bounds each argv payload below the
 *     measured ARG_MAX ceiling;
 *   - `scripts/lint-no-unfunneled-tmux-literal-send.js` fails the build if a
 *     raw unfunneled `send-keys -l` is reintroduced anywhere in src/;
 *   - `tests/integration/tmux-literal-send-ceiling.test.ts` asserts byte-exact
 *     delivery of a 40KB payload against a real pane.
 *
 * If this file ever starts READING pane state, this exemption stops being true
 * and a Rule 3.1 rationale plus canary is required.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chunkLiteralForTmux, buildLiteralSendArgs } from '../../../../core/tmuxLiteralSend.js';
import type {
  InputInjection,
  InputInjectionOptions,
  ControlKey,
} from '../../../primitives/control/inputInjection.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError } from '../../../errors.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';

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

class AnthropicHeadlessInputInjection implements InputInjection {
  readonly capability = CapabilityFlag.InputInjection;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  async send(
    session: SessionHandle,
    input: string,
    options?: InputInjectionOptions,
  ): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    const submit = options?.submitOnEnter !== false;
    const padding = options?.paddingMs ?? 500;

    try {
      // Chunked: `send-keys -l` carries its payload in one argv element, so a
      // large injected input fails with `command too long`
      // (src/core/tmuxLiteralSend.ts).
      for (const chunk of chunkLiteralForTmux(input)) {
        await execFileAsync(
          this.config.tmuxPath,
          buildLiteralSendArgs(`=${tmuxName}:`, chunk),
          { timeout: 5000 },
        );
      }

      if (submit) {
        if (padding > 0) {
          await new Promise((resolve) => setTimeout(resolve, padding));
        }
        await execFileAsync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxName}:`, 'Enter'], {
          timeout: 5000,
        });
      }
    } catch (err) {
      throw new UnexpectedError(
        `Failed to inject input into ${tmuxName}: ${(err as Error).message}`,
        ANTHROPIC_HEADLESS_ID,
        err,
      );
    }
  }

  async sendKey(session: SessionHandle, key: ControlKey): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    const tmuxKey = KEY_MAP[key];
    if (!tmuxKey) {
      throw new UnexpectedError(`Unmapped control key: ${key}`, ANTHROPIC_HEADLESS_ID);
    }
    try {
      await execFileAsync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxName}:`, tmuxKey], {
        timeout: 5000,
      });
    } catch (err) {
      throw new UnexpectedError(
        `Failed to send key ${key} to ${tmuxName}: ${(err as Error).message}`,
        ANTHROPIC_HEADLESS_ID,
        err,
      );
    }
  }
}

export function createInputInjection(config: AnthropicHeadlessConfig): InputInjection {
  return new AnthropicHeadlessInputInjection(config);
}
