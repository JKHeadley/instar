/**
 * InputInjection implementation for openai-codex.
 *
 * For `codex exec` sessions running inside tmux, this primitive uses
 * tmux send-keys (analog of the Anthropic adapter pattern). When the
 * Codex app-server is in use, a future iteration can route through
 * `turn/steer` JSON-RPC; until that lands, the tmux path covers both
 * the headless-exec and interactive-REPL session shapes.
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

import { execFileSync } from 'node:child_process';
import { chunkLiteralForTmux, buildLiteralSendArgs } from '../../../../core/tmuxLiteralSend.js';
import type { CancellationOptions, SessionHandle } from '../../../types.js';
import type {
  InputInjection,
  InputInjectionOptions,
  ControlKey,
} from '../../../primitives/control/inputInjection.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError } from '../../../errors.js';
import { OPENAI_CODEX_ID } from '../errors.js';
import { tmuxSessionFromHandle } from '../transport/agenticSessionHeadless.js';
import type { OpenAiCodexConfig } from '../config.js';

const KEY_TO_TMUX: Record<ControlKey, string> = {
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

class OpenAiCodexInputInjection implements InputInjection {
  readonly capability = CapabilityFlag.InputInjection;

  constructor(private readonly config: OpenAiCodexConfig) {}

  async send(session: SessionHandle, input: string, options?: InputInjectionOptions): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    const submit = options?.submitOnEnter !== false;
    const padding = options?.paddingMs ?? 500;
    try {
      // Chunked: `send-keys -l` carries its payload in one argv element, so a
      // large injected input fails with `command too long`
      // (src/core/tmuxLiteralSend.ts).
      for (const chunk of chunkLiteralForTmux(input)) {
        execFileSync(this.config.tmuxPath, buildLiteralSendArgs(tmuxName, chunk), {
          encoding: 'utf-8',
          timeout: 5000,
        });
      }
      if (submit) {
        if (padding > 0) await new Promise((r) => setTimeout(r, padding));
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', tmuxName, 'Enter'], {
          encoding: 'utf-8',
          timeout: 5000,
        });
      }
    } catch (err) {
      throw new UnexpectedError(
        `Failed to send input via tmux: ${(err as Error).message}`,
        OPENAI_CODEX_ID,
        err,
      );
    }
  }

  async sendKey(session: SessionHandle, key: ControlKey, _options?: CancellationOptions): Promise<void> {
    const tmuxName = tmuxSessionFromHandle(session);
    const tmuxKey = KEY_TO_TMUX[key];
    try {
      execFileSync(this.config.tmuxPath, ['send-keys', '-t', tmuxName, tmuxKey], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch (err) {
      throw new UnexpectedError(
        `Failed to send control key via tmux: ${(err as Error).message}`,
        OPENAI_CODEX_ID,
        err,
      );
    }
  }
}

export function createInputInjection(config: OpenAiCodexConfig): InputInjection {
  return new OpenAiCodexInputInjection(config);
}
