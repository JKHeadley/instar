import { inspectDesignGitTrees } from '../designGate/gitInspection.js';
/** Exit codes describe this manual inspection only, never a merge decision. */
export async function runDesignPolicyInspection(input: { repo: string; base: string; head: string }): Promise<number> {
  const report = await inspectDesignGitTrees(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === 'unavailable' ? 2 : report.status === 'structurally-valid' ? 0 : 1;
}
