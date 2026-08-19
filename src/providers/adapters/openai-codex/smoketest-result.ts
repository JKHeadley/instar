export const CODEX_SMOKETEST_SCHEMA = 'instar-codex-smoketest/v1' as const;

export interface CodexSmoketestSuccess {
  readonly schema: typeof CODEX_SMOKETEST_SCHEMA;
  readonly status: 'passed';
  readonly responseNonEmpty: true;
}

interface SmokeOutput {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

/**
 * Build the acceptance receipt only when the live provider returned text.
 * Empty text remains a failure path owned by the smoke-test process.
 */
export function codexSmoketestSuccess(text: string): CodexSmoketestSuccess | null {
  if (text.length === 0) return null;
  return Object.freeze({
    schema: CODEX_SMOKETEST_SCHEMA,
    status: 'passed',
    responseNonEmpty: true,
  });
}

/** Keep JSON-mode stdout to one receipt while preserving the human CLI. */
export function createCodexSmoketestReporter(
  jsonOutput: boolean,
  output: SmokeOutput = process,
) {
  return Object.freeze({
    info(message: string): void {
      const stream = jsonOutput ? output.stderr : output.stdout;
      stream.write(`${message}\n`);
    },
    success(text: string): CodexSmoketestSuccess | null {
      const receipt = codexSmoketestSuccess(text);
      if (!receipt) return null;
      output.stdout.write(jsonOutput
        ? `${JSON.stringify(receipt)}\n`
        : '[openai-codex smoketest] PASSED\n');
      return receipt;
    },
  });
}
