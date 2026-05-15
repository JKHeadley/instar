/**
 * LiveOutputStream for the interactive pool: snapshot + tail of the
 * underlying pool session's tmux pane.
 *
 * Mirrors the anthropic-headless implementation; the difference is that
 * this adapter looks up the tmux name via the pool's session registry
 * (handle → reserved pool session) rather than parsing it from the handle
 * string directly.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  LiveOutputStream,
  SnapshotOptions,
  TailOptions,
  OutputSnapshot,
  OutputChunk,
} from '../../../primitives/observability/liveOutputStream.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError, UnsupportedCapabilityError } from '../../../errors.js';
import type { InteractivePoolConfig } from '../config.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';
import { poolSessionForHandle } from '../transport/warmSessionInbox.js';

const execFileAsync = promisify(execFile);

const ANSI_RE = /\[[0-9;?]*[A-Za-z]/g;

class InteractivePoolLiveOutputStream implements LiveOutputStream {
  readonly capability = CapabilityFlag.LiveOutputStream;

  constructor(private readonly config: InteractivePoolConfig) {}

  async snapshot(session: SessionHandle, options?: SnapshotOptions): Promise<OutputSnapshot> {
    const ps = poolSessionForHandle(session);
    if (!ps) {
      throw new UnsupportedCapabilityError(
        `Unknown handle (not from interactive pool): ${session}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    const tmuxName = ps.tmuxName;
    const lines = options?.maxLines ?? 200;
    const includeAnsi = options?.includeAnsi === true;
    try {
      const { stdout } = await execFileAsync(
        this.config.tmuxPath,
        ['capture-pane', '-t', `=${tmuxName}:`, '-p', '-S', `-${lines}`, ...(includeAnsi ? ['-e'] : [])],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      );
      const text = includeAnsi ? stdout : stdout.replace(ANSI_RE, '');
      return {
        text,
        capturedAt: new Date().toISOString(),
        truncated: stdout.split('\n').length >= lines,
      };
    } catch (err) {
      throw new UnexpectedError(
        `Failed to capture pane for ${tmuxName}: ${(err as Error).message}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
        err,
      );
    }
  }

  tail(session: SessionHandle, options?: TailOptions): AsyncIterable<OutputChunk> {
    const ps = poolSessionForHandle(session);
    if (!ps) {
      throw new UnsupportedCapabilityError(
        `Unknown handle (not from interactive pool): ${session}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    const tmuxPath = this.config.tmuxPath;
    const tmuxName = ps.tmuxName;
    const intervalMs = options?.flushIntervalMs ?? 250;
    const signal = options?.signal;
    return {
      async *[Symbol.asyncIterator]() {
        let lastBuffer = '';
        if (options?.includeBacklog) {
          try {
            const { stdout } = await execFileAsync(
              tmuxPath,
              ['capture-pane', '-t', `=${tmuxName}:`, '-p', '-S', '-500'],
              { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
            );
            const text = stdout.replace(ANSI_RE, '');
            if (text) {
              yield { text, emittedAt: new Date().toISOString() };
              lastBuffer = stdout;
            }
          } catch {
            // session may not exist yet
          }
        }
        while (!signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          try {
            const { stdout } = await execFileAsync(
              tmuxPath,
              ['capture-pane', '-t', `=${tmuxName}:`, '-p', '-S', '-200'],
              { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
            );
            if (stdout !== lastBuffer) {
              const delta = stdout.slice(lastBuffer.length);
              const cleaned = delta.replace(ANSI_RE, '');
              if (cleaned) {
                yield { text: cleaned, emittedAt: new Date().toISOString() };
              }
              lastBuffer = stdout;
            }
          } catch {
            // session ended; stop iterating
            return;
          }
        }
      },
    };
  }
}

export function createLiveOutputStream(config: InteractivePoolConfig): LiveOutputStream {
  return new InteractivePoolLiveOutputStream(config);
}
