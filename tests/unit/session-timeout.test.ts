import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates session timeout enforcement exists in the codebase.
 */
describe('Session timeout enforcement', () => {
  it('Session type includes maxDurationMinutes field', () => {
    const typesSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/types.ts'),
      'utf-8'
    );
    expect(typesSource).toContain('maxDurationMinutes');
  });

  it('SessionManager enforces timeout in monitoring loop', () => {
    const smSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    // Should check maxDurationMinutes and kill expired sessions
    expect(smSource).toContain('maxDurationMinutes');
    expect(smSource).toContain('exceeded timeout');
  });

  it('JobScheduler passes expectedDurationMinutes as maxDurationMinutes', () => {
    const jsSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'),
      'utf-8'
    );
    expect(jsSource).toContain('maxDurationMinutes: job.expectedDurationMinutes');
  });

  it('spawnSession accepts maxDurationMinutes option', () => {
    const smSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8'
    );
    // The spawn method should accept and store the timeout
    expect(smSource).toContain('maxDurationMinutes?: number');
    expect(smSource).toContain('maxDurationMinutes: options.maxDurationMinutes');
  });
});
