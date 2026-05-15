/**
 * PromptRunner: inject a prompt into a pool session, wait for response,
 * extract clean text.
 *
 * Mechanic mirrors the feasibility prototype shell script:
 *   1. Snapshot pane buffer before sending
 *   2. tmux send-keys -l "$prompt" + Enter
 *   3. Poll pane buffer every second; declare done when:
 *      (a) buffer size stable for stabilitySeconds AND
 *      (b) idle marker visible
 *   4. Diff after-state against before-snapshot to extract response
 *   5. Strip status bar chrome (timing lines, idle markers)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AbortError, TimeoutError, UnexpectedError } from '../../errors.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from './errors.js';
import type { InteractivePoolConfig } from './config.js';
import type { InteractivePool, PoolSession } from './pool.js';

const execFileAsync = promisify(execFile);

const ANSI_RE = /\[[0-9;?]*[A-Za-z]/g;

export interface RunPromptOptions {
  signal?: AbortSignal;
  /** Override the default max-wait. */
  maxWaitSeconds?: number;
}

export interface RunPromptResult {
  /** Clean response text (status bar stripped). */
  text: string;
  /** Raw extracted text including any chrome. */
  raw: string;
  /** Wall-clock milliseconds from send to completion. */
  durationMs: number;
}

export async function runPrompt(
  pool: InteractivePool,
  session: PoolSession,
  prompt: string,
  config: InteractivePoolConfig,
  options: RunPromptOptions = {},
): Promise<RunPromptResult> {
  if (options.signal?.aborted) {
    throw new AbortError('aborted before send', ANTHROPIC_INTERACTIVE_POOL_ID);
  }

  const tmuxName = session.tmuxName;
  const maxWaitMs = (options.maxWaitSeconds ?? config.maxPromptWaitSeconds) * 1000;
  const stabilityMs = config.stabilitySeconds * 1000;

  const beforeBuffer = (await pool.capturePane(tmuxName, 500)) ?? '';
  const beforeLength = beforeBuffer.length;
  const startTs = Date.now();

  // Send prompt + Enter
  try {
    await execFileAsync(
      config.tmuxPath,
      ['send-keys', '-t', `=${tmuxName}:`, '-l', prompt],
      { timeout: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await execFileAsync(
      config.tmuxPath,
      ['send-keys', '-t', `=${tmuxName}:`, 'Enter'],
      { timeout: 5000 },
    );
  } catch (err) {
    throw new UnexpectedError(
      `Failed to send prompt: ${(err as Error).message}`,
      ANTHROPIC_INTERACTIVE_POOL_ID,
      err,
    );
  }

  // Poll for completion
  let lastSize = -1;
  let stableSince = 0;
  let elapsed = 0;
  while (elapsed < maxWaitMs) {
    if (options.signal?.aborted) {
      throw new AbortError('aborted during wait', ANTHROPIC_INTERACTIVE_POOL_ID);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    elapsed = Date.now() - startTs;
    const buf = (await pool.capturePane(tmuxName, 1000)) ?? '';
    const size = buf.length;
    if (size === lastSize) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= stabilityMs) {
        for (const marker of config.idleMarkers) {
          if (buf.includes(marker)) {
            // Done — extract response
            return extractResponse(beforeBuffer, beforeLength, buf, startTs);
          }
        }
        // Stable but no idle marker — reset and wait more
        stableSince = 0;
      }
    } else {
      stableSince = 0;
      lastSize = size;
    }
  }

  throw new TimeoutError(
    `Prompt did not complete within ${config.maxPromptWaitSeconds}s`,
    ANTHROPIC_INTERACTIVE_POOL_ID,
    Date.now() - startTs,
    { budgetMs: maxWaitMs },
  );
}

function extractResponse(
  _beforeBuffer: string,
  _beforeLength: number,
  afterBuffer: string,
  startTs: number,
): RunPromptResult {
  // Claude's tmux pane is a rotating window, not an append-only log. The
  // pane shows a fixed slice that scrolls as content arrives, so slicing by
  // `beforeLength` discards the response when the window has rolled. We
  // instead parse the after-buffer directly for Claude's marker grammar.
  //
  //   ❯ <echoed prompt>
  //   ⏺ <response line>
  //     [continuation lines]
  //   (optional) ⏺ Ran N stop hooks (…)
  //   ✻ Crunched for Ns
  //   <horizontal rule>
  //   ❯
  //   <horizontal rule>
  //   <status bar>
  //
  // Strategy:
  //   1. Strip ANSI.
  //   2. Find the LAST `❯ ` line that isn't the empty post-prompt prompt.
  //   3. From there, walk forward to the first `⏺ ` line — that's the start
  //      of the actual response.
  //   4. Stop at the next `⏺ Ran`, `✻ `, or horizontal-rule line.
  const cleanAfter = afterBuffer.replace(ANSI_RE, '');
  const lines = cleanAfter.split('\n');

  // Find the most-recent non-empty `❯ ` echo line. We treat that as the
  // prompt we just sent.
  let echoIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^❯\s+(\S.*)$/);
    if (m) {
      echoIdx = i;
      break;
    }
  }

  let text = '';
  if (echoIdx >= 0) {
    const collected: string[] = [];
    let started = false;
    for (let i = echoIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      // Stop conditions
      if (started && /^⏺\s+Ran\b/.test(line)) break;
      if (started && /^✻\s+/.test(line)) break;
      if (started && /^─{5,}/.test(line)) break;
      if (started && /^❯\s*$/.test(line)) break;
      if (started && /^❯\s+/.test(line)) break;

      if (!started) {
        const m = line.match(/^⏺\s+(.*)$/);
        if (m) {
          started = true;
          collected.push(m[1]!);
        }
        continue;
      }

      // Continuation: blank line, or `  <text>` indented continuation,
      // or `  ⎿  <text>` tool-result indent.
      if (line.trim() === '') {
        // Empty line might be inside the response; include it but stop
        // accumulating if the next non-empty is a marker.
        collected.push('');
        continue;
      }
      // Strip leading indent / box-drawing markers, then accept.
      const cleaned = line.replace(/^\s*[│⎿]?\s{0,2}/, '');
      collected.push(cleaned);
    }
    text = collected.join('\n').trim();
  }

  // Fall back to the legacy heuristic if marker parsing didn't find anything.
  if (!text) {
    const responseStart = cleanAfter.lastIndexOf('⏺');
    if (responseStart >= 0) {
      let tail = cleanAfter.slice(responseStart + 1);
      const timingMarker = tail.indexOf('✻');
      if (timingMarker >= 0) tail = tail.slice(0, timingMarker);
      text = tail
        .split('\n')
        .map((line) => line.replace(/^\s*[│]?\s{0,2}/, ''))
        .join('\n')
        .trim();
    }
  }

  return {
    text,
    raw: cleanAfter.trim(),
    durationMs: Date.now() - startTs,
  };
}
