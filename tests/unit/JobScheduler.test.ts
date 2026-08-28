import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { JobSchedulerConfig, JobDefinition } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildSyntheticAgent, mkAgentMd, mkManifest } from './scheduler/agentmd-helpers.js';

describe('JobScheduler', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let jobsFile: string;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    jobsFile = createSampleJobsFile(project.stateDir);

    // Pre-seed lastRun so checkMissedJobs doesn't trigger jobs at startup.
    // Missed-job detection is tested separately in job-scheduler-edge.test.ts.
    for (const slug of ['health-check', 'email-check']) {
      project.state.saveJobState({
        slug,
        lastRun: new Date().toISOString(),
        lastResult: 'success',
        runCount: 1,
        consecutiveFailures: 0,
      });
    }
  });

  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
  });

  function makeConfig(overrides?: Partial<JobSchedulerConfig>): JobSchedulerConfig {
    return {
      jobsFile,
      enabled: true,
      maxParallelJobs: 2,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      ...overrides,
    };
  }

  function createScheduler(configOverrides?: Partial<JobSchedulerConfig>): JobScheduler {
    scheduler = new JobScheduler(
      makeConfig(configOverrides),
      mockSM as any,
      project.state,
      project.stateDir,
    );
    return scheduler;
  }

  describe('start/stop', () => {
    it('starts and loads jobs', () => {
      createScheduler();
      scheduler.start();

      const status = scheduler.getStatus();
      expect(status.running).toBe(true);
      expect(status.jobCount).toBe(3); // 2 enabled + 1 disabled
      expect(status.enabledJobs).toBe(2);
    });

    it('stops cleanly', () => {
      createScheduler();
      scheduler.start();
      scheduler.stop();

      expect(scheduler.getStatus().running).toBe(false);
    });

    it('start is idempotent', () => {
      createScheduler();
      scheduler.start();
      scheduler.start(); // Should not throw
      expect(scheduler.getStatus().running).toBe(true);
    });
  });

  describe('triggerJob', () => {
    it('triggers a known job', async () => {
      createScheduler();
      scheduler.start();

      const result = await scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('triggered');
      expect(mockSM._spawnCount).toBe(1);
    });

    it('refuses unknown job', async () => {
      createScheduler();
      scheduler.start();

      const result = await scheduler.triggerJob('nonexistent', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
    });

    it('queues when at max parallel jobs', async () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      // First trigger succeeds
      const r1 = await scheduler.triggerJob('health-check', 'test');
      expect(r1).toBe('triggered');

      // Second trigger gets queued — at capacity
      const r2 = await scheduler.triggerJob('email-check', 'test');
      expect(r2).toBe('queued');

      expect(scheduler.getStatus().queueLength).toBe(1);
    });

    it('skips when paused', async () => {
      createScheduler();
      scheduler.start();
      scheduler.pause();

      const result = await scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
    });

    it('skips when quota callback returns false', async () => {
      createScheduler();
      scheduler.start();
      scheduler.canRunJob = () => false;

      const result = await scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
    });

    it('re-reads a changed job body from disk without restarting', async () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'health-check',
          name: 'Health Check',
          description: 'Live body refresh test',
          schedule: '0 * * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'prompt', value: 'original body' },
        },
      ]);
      createScheduler();
      scheduler.start();

      await scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));
      expect(mockSM._lastSpawnArgs?.prompt).toContain('original body');

      const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')) as Array<Record<string, unknown>>;
      (jobs[0].execute as { value: string }).value = 'updated body';
      fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
      scheduler.refreshJobs();
      expect(scheduler.getJobs().find(j => j.slug === 'health-check')?.execute.value).toBe('updated body');
    });

    it('re-reads a changed agentmd body from disk on the next admission without restarting', async () => {
      const agent = buildSyntheticAgent({
        jobsJson: [],
        manifests: {
          'live-agentmd': mkManifest({
            slug: 'live-agentmd',
            origin: 'user',
            schedule: '0 * * * *',
            priority: 'medium',
            model: 'haiku',
            expectedDurationMinutes: 5,
            enabled: true,
            execute: { type: 'agentmd' },
          }),
        },
        userMd: {
          'live-agentmd': mkAgentMd({
            body: '# Live Agentmd\n\noriginal markdown body\n',
          }),
        },
      });

      try {
        scheduler = new JobScheduler(
          { ...makeConfig(), jobsFile: agent.jobsFile },
          mockSM as any,
          project.state,
          project.stateDir,
        );
        scheduler.start();
        expect(scheduler.getJobs().find(j => j.slug === 'live-agentmd')?.body).toContain('original markdown body');

        fs.writeFileSync(
          path.join(agent.jobsRoot, 'user', 'live-agentmd.md'),
          mkAgentMd({ body: '# Live Agentmd\n\nupdated markdown body\n' }),
        );

        const result = await scheduler.triggerJob('live-agentmd', 'test');
        expect(result).toBe('triggered');
        await new Promise(r => setTimeout(r, 50));
        expect(mockSM._lastSpawnArgs?.prompt).toContain('updated markdown body');
      } finally {
        agent.cleanup();
      }
    });

    it('refuses to admit a job once its enabled flag changes on disk', async () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'health-check',
          name: 'Health Check',
          description: 'Live disable test',
          schedule: '0 * * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'prompt', value: 'body' },
        },
      ]);
      createScheduler();
      scheduler.start();

      const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')) as Array<Record<string, unknown>>;
      jobs[0].enabled = false;
      fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

      const result = await scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
      expect(scheduler.getJobs().find(j => j.slug === 'health-check')?.enabled).toBe(false);
    });
  });

  describe('gate auth context injection', () => {
    it('exposes authToken and projectName to gate shell', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const capturePath = path.join(project.stateDir, 'gate-capture.txt');
      const jobs: JobDefinition[] = [{
        slug: 'gate-capture',
        name: 'Gate Capture',
        description: 'Writes the auth env var to disk',
        schedule: '0 0 * * *',
        priority: 'medium',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        gate: `echo "token=$INSTAR_AUTH_TOKEN agent=$INSTAR_AGENT_ID" > ${capturePath}`,
        execute: { type: 'skill', value: 'noop' },
      }];
      const customJobsFile = createSampleJobsFile(project.stateDir, jobs);
      scheduler = new JobScheduler(
        { ...makeConfig(), jobsFile: customJobsFile, authToken: 'test-token-xyz', projectName: 'test-agent' },
        mockSM as any,
        project.state,
        project.stateDir,
      );
      scheduler.start();

      const result = await scheduler.triggerJob('gate-capture', 'test');
      expect(result).toBe('triggered');
      const captured = fs.readFileSync(capturePath, 'utf-8').trim();
      expect(captured).toBe('token=test-token-xyz agent=test-agent');
    });

    it('leaves $INSTAR_AUTH_TOKEN unset when no authToken is configured', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const capturePath = path.join(project.stateDir, 'gate-capture-noauth.txt');
      const jobs: JobDefinition[] = [{
        slug: 'gate-capture-noauth',
        name: 'Gate Capture No Auth',
        description: 'Writes the auth env var to disk (should be empty)',
        schedule: '0 0 * * *',
        priority: 'medium',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        gate: `echo "token=$INSTAR_AUTH_TOKEN" > ${capturePath}`,
        execute: { type: 'skill', value: 'noop' },
      }];
      const customJobsFile = createSampleJobsFile(project.stateDir, jobs);
      // The contract under test is "when config.authToken is absent, the
      // scheduler does not INJECT a token into the gate env." When the test
      // runner itself inherits INSTAR_AUTH_TOKEN (e.g. tests are invoked from
      // inside an instar-managed session), the gate shell would see it via
      // inherited process.env and produce a false failure. Clear the env var
      // for the duration of this test to make the assertion hermetic.
      const savedAuth = process.env.INSTAR_AUTH_TOKEN;
      delete process.env.INSTAR_AUTH_TOKEN;
      try {
        scheduler = new JobScheduler(
          { ...makeConfig(), jobsFile: customJobsFile }, // no authToken
          mockSM as any,
          project.state,
          project.stateDir,
        );
        scheduler.start();

        const result = await scheduler.triggerJob('gate-capture-noauth', 'test');
        expect(result).toBe('triggered');
        const captured = fs.readFileSync(capturePath, 'utf-8').trim();
        expect(captured).toBe('token=');
      } finally {
        if (savedAuth !== undefined) process.env.INSTAR_AUTH_TOKEN = savedAuth;
      }
    });
  });

  describe('queue processing', () => {
    it('drains queue when slot opens', async () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      // Fill the slot
      await scheduler.triggerJob('health-check', 'test');
      expect(mockSM._spawnCount).toBe(1);

      // Queue a job
      await scheduler.triggerJob('email-check', 'test');
      expect(scheduler.getStatus().queueLength).toBe(1);

      // Simulate session completion — mark the running session as completed
      const session = mockSM._sessions[0];
      session.status = 'completed';
      mockSM._aliveSet.delete(session.tmuxSession);

      // Process the queue
      scheduler.processQueue();
      expect(mockSM._spawnCount).toBe(2);
      expect(scheduler.getStatus().queueLength).toBe(0);
    });

    it('does not dequeue duplicates', async () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      await scheduler.triggerJob('health-check', 'test');
      await scheduler.triggerJob('email-check', 'test-1');
      await scheduler.triggerJob('email-check', 'test-2'); // duplicate slug

      expect(scheduler.getStatus().queueLength).toBe(1);
    });

    it('does not process queue when paused', async () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      await scheduler.triggerJob('health-check', 'test');
      await scheduler.triggerJob('email-check', 'test');

      // Clear the slot
      mockSM._sessions[0].status = 'completed';
      mockSM._aliveSet.delete(mockSM._sessions[0].tmuxSession);

      scheduler.pause();
      scheduler.processQueue();
      expect(mockSM._spawnCount).toBe(1); // Only the first one
    });
  });

  describe('pause/resume', () => {
    it('resume processes pending queue', async () => {
      createScheduler({ maxParallelJobs: 1 });
      scheduler.start();

      await scheduler.triggerJob('health-check', 'test');
      await scheduler.triggerJob('email-check', 'test');
      scheduler.pause();

      // Clear the slot
      mockSM._sessions[0].status = 'completed';
      mockSM._aliveSet.delete(mockSM._sessions[0].tmuxSession);

      scheduler.resume();
      expect(mockSM._spawnCount).toBe(2);
    });

    it('getStatus reflects paused state', () => {
      createScheduler();
      scheduler.start();

      expect(scheduler.getStatus().paused).toBe(false);
      scheduler.pause();
      expect(scheduler.getStatus().paused).toBe(true);
      scheduler.resume();
      expect(scheduler.getStatus().paused).toBe(false);
    });
  });

  describe('failure tracking', () => {
    it('increments consecutive failures on spawn error', async () => {
      createScheduler();
      scheduler.start();

      // Make spawnSession reject
      mockSM.spawnSession = async () => { throw new Error('tmux failed'); };

      await scheduler.triggerJob('health-check', 'test');

      // Wait for the async rejection to be handled
      await new Promise(r => setTimeout(r, 50));

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('failure');
      expect(jobState?.consecutiveFailures).toBe(1);

      const events = project.state.queryEvents({ type: 'job_error' });
      expect(events[0].metadata).toMatchObject({
        slug: 'health-check',
        error: 'tmux failed',
        terminal: true,
        retry: 'next-trigger',
      });
    });
  });

  describe('getJobs', () => {
    it('returns loaded job definitions', () => {
      createScheduler();
      scheduler.start();

      const jobs = scheduler.getJobs();
      expect(jobs).toHaveLength(3);
      expect(jobs.map(j => j.slug)).toContain('health-check');
      expect(jobs.map(j => j.slug)).toContain('disabled-job');
    });
  });

  describe('activity events', () => {
    it('emits scheduler_start event', () => {
      createScheduler();
      scheduler.start();

      const events = project.state.queryEvents({ type: 'scheduler_start' });
      expect(events).toHaveLength(1);
    });

    it('emits job_triggered event', async () => {
      createScheduler();
      scheduler.start();
      await scheduler.triggerJob('health-check', 'manual');

      // Wait for async spawn to complete
      await new Promise(r => setTimeout(r, 50));

      const events = project.state.queryEvents({ type: 'job_triggered' });
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain('health-check');
    });

    it('emits scheduler_stop event', () => {
      createScheduler();
      scheduler.start();
      scheduler.stop();

      const events = project.state.queryEvents({ type: 'scheduler_stop' });
      expect(events).toHaveLength(1);
    });
  });

  describe('machine scope filtering', () => {
    it('runs all jobs when no machine identity is set', async () => {
      createScheduler();
      scheduler.start();

      // Both enabled jobs should be schedulable
      const result1 = await scheduler.triggerJob('health-check', 'test');
      expect(result1).toBe('triggered');
    });

    it('runs unscoped jobs on any machine', async () => {
      jobsFile = createSampleJobsFile(project.stateDir);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      // Default sample jobs have no machines field — should run
      const result = await scheduler.triggerJob('health-check', 'test');
      expect(result).toBe('triggered');
    });

    it('runs jobs scoped to this machine by ID', async () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'scoped-job',
          name: 'Scoped Job',
          description: 'Only on this machine',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_abc123def456'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      const result = await scheduler.triggerJob('scoped-job', 'test');
      expect(result).toBe('triggered');
    });

    it('runs jobs scoped to this machine by name (case-insensitive)', async () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'name-scoped',
          name: 'Name Scoped',
          description: 'Scoped by machine name',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['Justins-MacBook'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      const result = await scheduler.triggerJob('name-scoped', 'test');
      expect(result).toBe('triggered');
    });

    it('skips jobs scoped to a different machine', async () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'other-machine-job',
          name: 'Other Machine Job',
          description: 'Not for this machine',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_other_machine_id', 'adrianas-laptop'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_abc123def456', 'justins-macbook');
      scheduler.start();

      const result = await scheduler.triggerJob('other-machine-job', 'test');
      expect(result).toBe('skipped');
      expect(mockSM._spawnCount).toBe(0);
    });

    it('only schedules cron tasks for machine-scoped jobs', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'local-job',
          name: 'Local Job',
          description: 'Runs here',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_this_machine'],
        },
        {
          slug: 'remote-job',
          name: 'Remote Job',
          description: 'Runs elsewhere',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: ['m_other_machine'],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_this_machine', 'my-laptop');
      scheduler.start();

      // Should log that 1 job was skipped by machine scope
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('1 job(s) skipped (machine scope)')
      );
      logSpy.mockRestore();

      // Verify the start event mentions the scope filtering
      const events = project.state.queryEvents({ type: 'scheduler_start' });
      expect(events[0].summary).toContain('1 skipped by machine scope');
    });

    it('treats empty machines array as unscoped (runs everywhere)', async () => {
      jobsFile = createSampleJobsFile(project.stateDir, [
        {
          slug: 'empty-scope',
          name: 'Empty Scope',
          description: 'No machine restriction',
          schedule: '0 */4 * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'skill', value: 'scan' },
          machines: [],
        },
      ]);
      createScheduler();
      scheduler.setMachineIdentity('m_any_machine', 'any-name');
      scheduler.start();

      const result = await scheduler.triggerJob('empty-scope', 'test');
      expect(result).toBe('triggered');
    });
  });

  describe('notifyJobComplete', () => {
    it('saves the job state before recording terminal completion', async () => {
      createScheduler();
      scheduler.start();

      await scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));

      const session = mockSM._sessions[mockSM._sessions.length - 1];
      session.status = 'completed';
      project.state.saveSession(session);

      const sequence: string[] = [];
      const originalSave = project.state.saveJobState.bind(project.state);
      const originalRecord = (scheduler as any).runHistory.recordCompletion.bind((scheduler as any).runHistory);

      vi.spyOn(project.state, 'saveJobState').mockImplementation((jobState) => {
        sequence.push(`save:${jobState.lastResult}`);
        return originalSave(jobState);
      });
      vi.spyOn((scheduler as any).runHistory, 'recordCompletion').mockImplementation((opts) => {
        sequence.push(`record:${opts.result}`);
        return originalRecord(opts);
      });

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      expect(sequence).toEqual(['save:success', 'record:success']);
      expect(project.state.getJobState('health-check')?.lastResult).toBe('success');
    });

    // Observer-2 finding 2: script jobs terminate in their own then/catch, NOT via
    // notifyJobComplete. Both of those terminal paths must obey the same charter
    // clause 1(c) ordering the model-session path above asserts.
    function scriptJobsFile(script: string): string {
      return createSampleJobsFile(project.stateDir, [
        {
          slug: 'script-job',
          name: 'Script Job',
          description: 'Script terminal-path ordering',
          schedule: '0 * * * *',
          priority: 'medium',
          expectedDurationMinutes: 5,
          model: 'haiku',
          enabled: true,
          execute: { type: 'script', value: script },
        },
      ]);
    }

    function traceTerminalOrder(): string[] {
      const sequence: string[] = [];
      const originalSave = project.state.saveJobState.bind(project.state);
      const originalRecord = (scheduler as any).runHistory.recordCompletion.bind((scheduler as any).runHistory);
      vi.spyOn(project.state, 'saveJobState').mockImplementation((jobState) => {
        sequence.push(`save:${jobState.lastResult}`);
        return originalSave(jobState);
      });
      vi.spyOn((scheduler as any).runHistory, 'recordCompletion').mockImplementation((opts) => {
        sequence.push(`record:${opts.result}`);
        return originalRecord(opts);
      });
      return sequence;
    }

    // A script job's terminal work runs in a fire-and-forget then/catch, so wait for
    // the run-history record specifically — sequence length alone would be satisfied
    // by the pre-terminal `save:pending` write that triggerJob performs.
    async function waitForTerminal(sequence: string[]): Promise<void> {
      for (let i = 0; i < 200 && !sequence.some(e => e.startsWith('record:')); i++) {
        await new Promise(r => setTimeout(r, 25));
      }
    }

    it('saves the job state before recording completion on script-job SUCCESS', async () => {
      jobsFile = scriptJobsFile('exit 0');
      createScheduler();
      scheduler.start();
      const sequence = traceTerminalOrder();

      await scheduler.triggerJob('script-job', 'test');
      await waitForTerminal(sequence);

      // Full lifecycle: the trigger-time pending save, then the terminal save,
      // then the terminal record. Also proves no extra terminal write sneaks in.
      expect(sequence).toEqual(['save:pending', 'save:success', 'record:success']);
      expect(project.state.getJobState('script-job')?.lastResult).toBe('success');
    });

    it('saves the job state before recording completion on script-job FAILURE', async () => {
      jobsFile = scriptJobsFile('exit 7');
      createScheduler();
      scheduler.start();
      const sequence = traceTerminalOrder();

      await scheduler.triggerJob('script-job', 'test');
      await waitForTerminal(sequence);

      // Full lifecycle: the trigger-time pending save, then the terminal save,
      // then the terminal record. Also proves no extra terminal write sneaks in.
      expect(sequence).toEqual(['save:pending', 'save:failure', 'record:failure']);
      expect(project.state.getJobState('script-job')?.lastResult).toBe('failure');
    });

    // The timeout verdict is produced by the SAME catch block as failure — only the
    // `result` discriminant differs — so this asserts the discriminant AND the ordering
    // without waiting out a real (>=120s) execFile timeout.
    it('saves the job state before recording completion on script-job TIMEOUT', async () => {
      jobsFile = scriptJobsFile('echo "operation timed out" >&2; exit 1');
      createScheduler();
      scheduler.start();
      const sequence = traceTerminalOrder();

      await scheduler.triggerJob('script-job', 'test');
      await waitForTerminal(sequence);

      // Full lifecycle: the trigger-time pending save, then the terminal save,
      // then the terminal record. Also proves no extra terminal write sneaks in.
      expect(sequence).toEqual(['save:pending', 'save:timeout', 'record:timeout']);
      expect(project.state.getJobState('script-job')?.lastResult).toBe('timeout');
    });

    it('updates job state with success on completed session', async () => {
      createScheduler();
      scheduler.start();

      // Trigger a job to create session state
      await scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));

      // Get the spawned session
      const sessions = mockSM._sessions;
      expect(sessions.length).toBeGreaterThan(0);
      const session = sessions[sessions.length - 1];

      // Simulate session completion
      session.status = 'completed';
      project.state.saveSession(session);

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('success');
      expect(jobState?.consecutiveFailures).toBe(0);
    });

    it('updates job state with failure on failed session', async () => {
      createScheduler();
      scheduler.start();

      // Trigger a job to create session state
      await scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));

      const sessions = mockSM._sessions;
      const session = sessions[sessions.length - 1];

      // Simulate session failure
      session.status = 'failed';
      project.state.saveSession(session);

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('failure');
      expect(jobState?.consecutiveFailures).toBe(1);
    });

    it('updates job state with failure on killed session', async () => {
      createScheduler();
      scheduler.start();

      await scheduler.triggerJob('health-check', 'test');
      await new Promise(r => setTimeout(r, 50));

      const sessions = mockSM._sessions;
      const session = sessions[sessions.length - 1];

      // Simulate session killed (e.g., timeout)
      session.status = 'killed';
      project.state.saveSession(session);

      await scheduler.notifyJobComplete(session.id, session.tmuxSession);

      const jobState = project.state.getJobState('health-check');
      expect(jobState?.lastResult).toBe('failure');
    });
  });

  // ── extractHandoff ──────────────────────────────────────────────

  describe('extractHandoff', () => {
    it('extracts handoff notes from output with [HANDOFF] markers', () => {
      const output = 'Some session output\n[HANDOFF]\nCheck ERROR-128 next time.\nAlso verify Safari fix.\n[/HANDOFF]\nMore output';
      expect(JobScheduler.extractHandoff(output)).toBe('Check ERROR-128 next time.\nAlso verify Safari fix.');
    });

    it('returns null when no handoff markers present', () => {
      expect(JobScheduler.extractHandoff('Normal output without markers')).toBeNull();
    });

    it('handles case-insensitive markers', () => {
      const output = '[handoff]\nLowercase notes\n[/handoff]';
      expect(JobScheduler.extractHandoff(output)).toBe('Lowercase notes');
    });

    it('handles empty handoff block', () => {
      const output = '[HANDOFF]\n   \n[/HANDOFF]';
      expect(JobScheduler.extractHandoff(output)).toBe('');
    });

    it('extracts only the first handoff block', () => {
      const output = '[HANDOFF]\nFirst block\n[/HANDOFF]\n[HANDOFF]\nSecond block\n[/HANDOFF]';
      expect(JobScheduler.extractHandoff(output)).toBe('First block');
    });
  });
});
