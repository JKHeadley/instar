/**
 * Keeps a closed pipe from taking down the whole server.
 *
 * A write to a pipe whose reader has gone fails later, on the stream, as an
 * 'error' event. try/catch around the write never sees it, and a stream with no
 * 'error' listener turns it into an uncaught exception ("write EPIPE"). Two
 * uncaught ones crashed the Studio server on 2026-11-06.
 *
 * Only a gone reader is handled here. Any other stream error is rethrown, so it
 * still reaches the process-level policy and is judged there.
 */

interface ErrorEmitter {
  on?: (event: 'error', listener: (err: NodeJS.ErrnoException) => void) => unknown;
}

/** True when a pipe write failed because the reader closed its end. */
export function isClosedPipeError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null | undefined)?.code === 'EPIPE';
}

/**
 * Call on a child's stdin before writing to it. The child's own exit handling
 * still reports the failed call; this only stops the write error from becoming
 * uncaught. Tolerates a null stream (stdio not piped) and test doubles.
 */
export function guardChildStdin(stdin: ErrorEmitter | null | undefined, label: string): void {
  stdin?.on?.('error', (err) => {
    if (!isClosedPipeError(err)) throw err;
    console.warn(`[pipe-guard] ${label}: child closed stdin before the write finished (${err.message})`);
  });
}

/**
 * Call once at server start. The supervisor pipes the server's stderr through
 * `tee`, so stderr can lose its reader while the server is healthy. Each stream
 * reports once: the report itself goes through console, which writes to the
 * same streams, and a dead stdio pipe stays dead.
 */
export function guardProcessStdio(
  streams: ReadonlyArray<readonly [string, ErrorEmitter]> = [['stdout', process.stdout], ['stderr', process.stderr]],
): void {
  for (const [name, stream] of streams) {
    let reported = false;
    stream.on?.('error', (err) => {
      if (!isClosedPipeError(err)) throw err;
      if (reported) return;
      reported = true;
      console.warn(`[pipe-guard] process ${name} lost its reader; continuing without it (${err.message})\n${err.stack ?? ''}`);
    });
  }
}
