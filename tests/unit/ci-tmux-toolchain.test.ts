/** Every real-process lane must use the same fixed tmux, before running tests. */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string; uses?: string };
const workflow = yaml.load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};

describe('CI tmux child-exit toolchain', () => {
  it.each(['unit', 'integration', 'e2e'])('%s installs the fixed toolchain before its real-process suite', (lane) => {
    const steps = workflow.jobs[lane].steps;
    const setup = steps.findIndex((s) => s.run === 'bash .github/scripts/setup-ci-tmux.sh');
    const test = steps.findIndex((s) => /npm run test:/.test(s.run ?? ''));
    expect(setup, `${lane} must not inherit Ubuntu tmux 3.4's lost-child-status race`).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(setup);
  });
});
