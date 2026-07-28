/**
 * AgenticSessionHeadless implementation for anthropic-headless.
 *
 * Spawns `claude --dangerously-skip-permissions --model X -p PROMPT`
 * inside a detached tmux session. Returns a handle and an event stream.
 *
 * Pattern derived from SessionManager.spawn() in src/core/SessionManager.ts.
 * Phase 3 refactor will collapse the two paths once the adapter is wired
 * into the application layer.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type {
  AgenticSessionHeadless,
  AgenticSessionHeadlessOptions,
  AgenticSessionHandle,
} from '../../../primitives/transport/agenticSessionHeadless.js';
import type { CanonicalEvent } from '../../../events.js';
import type { SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError } from '../../../errors.js';
import { ANTHROPIC_HEADLESS_ID } from '../errors.js';
import { resolveCliModelFlag } from '../models.js';
import type { AnthropicHeadlessConfig } from '../config.js';

class AnthropicHeadlessAgenticSession implements AgenticSessionHeadless {
  readonly capability = CapabilityFlag.AgenticSessionHeadless;

  constructor(private readonly config: AnthropicHeadlessConfig) {}

  async start(options: AgenticSessionHeadlessOptions): Promise<AgenticSessionHandle> {
    const sessionId = `ahss-${randomBytes(8).toString('hex')}`;
    const tmuxName = `instar-${sessionId}`;
    const cwd = options.workingDirectory ?? this.config.defaultWorkingDirectory ?? process.cwd();
    const model = resolveCliModelFlag(options.model ?? this.config.defaultModel ?? 'balanced');

    const claudeArgs = ['--dangerously-skip-permissions', '--model', model, '-p', options.prompt];

    // Build environment for the tmux session
    const sessionEnv: Array<[string, string]> = [
      ['CLAUDECODE', ''], // strip nested-session marker
      ['INSTAR_SESSION_ID', sessionId],
      ['INSTAR_SESSION_NAME', tmuxName], // Threadline binding: attributes a relay-send to its origin session
    ];

    if (this.config.credential) {
      if (this.config.credential.startsWith('sk-ant-oat')) {
        sessionEnv.push(['CLAUDE_CODE_OAUTH_TOKEN', this.config.credential]);
        sessionEnv.push(['ANTHROPIC_API_KEY', '']);
      } else {
        sessionEnv.push(['ANTHROPIC_API_KEY', this.config.credential]);
        sessionEnv.push(['CLAUDE_CODE_OAUTH_TOKEN', '']);
      }
    }

    if (this.config.apiBaseUrl) {
      sessionEnv.push(['ANTHROPIC_BASE_URL', this.config.apiBaseUrl]);
    }

    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        sessionEnv.push([k, v]);
      }
    }

    const tmuxArgs = [
      'new-session',
      '-d',
      '-s',
      tmuxName,
      '-c',
      cwd,
    ];
    for (const [k, v] of sessionEnv) {
      tmuxArgs.push('-e', `${k}=${v}`);
    }
    tmuxArgs.push(this.config.claudePath, ...claudeArgs);

    try {
      execFileSync(this.config.tmuxPath, tmuxArgs, { encoding: 'utf-8' });
      // Increase scrollback for dashboard / monitoring history
      try {
        execFileSync(
          this.config.tmuxPath,
          ['set-option', '-t', `=${tmuxName}:`, 'history-limit', '50000'],
          { encoding: 'utf-8', timeout: 5000 },
        );
      } catch {
        /* nice-to-have */
      }
    } catch (err) {
      throw new UnexpectedError(
        `Failed to spawn tmux session: ${(err as Error).message}`,
        ANTHROPIC_HEADLESS_ID,
        err,
      );
    }

    const handle = sessionHandle(`${ANTHROPIC_HEADLESS_ID}/${tmuxName}`);

    // Phase 3a: events stream is best-effort. The richer event-stream
    // implementation (parsing hook events into CanonicalEvents) is wired
    // through HookEventReceiver in the observability layer; the session
    // handle's events here is a no-op iterable for now. Consumers that
    // need events use HookEventReceiver directly until Phase 3b unifies.
    const events: AsyncIterable<CanonicalEvent> = {
      // eslint-disable-next-line @typescript-eslint/require-await
      [Symbol.asyncIterator]: async function* () {
        // No events emitted from this stream in Phase 3a; see HookEventReceiver.
      },
    };

    return {
      handle,
      events,
      providerSpecific: {
        [ANTHROPIC_HEADLESS_ID]: {
          tmuxSession: tmuxName,
          sessionId,
          model,
          cwd,
        },
      },
    };
  }
}

/**
 * Extract the tmux session name from a SessionHandle issued by this
 * adapter. Throws if the handle wasn't issued by us.
 */
export function tmuxSessionFromHandle(handle: SessionHandle): string {
  const prefix = `${ANTHROPIC_HEADLESS_ID}/`;
  if (!handle.startsWith(prefix)) {
    throw new UnexpectedError(
      `SessionHandle was not issued by anthropic-headless: ${handle}`,
      ANTHROPIC_HEADLESS_ID,
    );
  }
  return handle.slice(prefix.length);
}

export function createAgenticSessionHeadless(
  config: AnthropicHeadlessConfig,
): AgenticSessionHeadless {
  return new AnthropicHeadlessAgenticSession(config);
}
