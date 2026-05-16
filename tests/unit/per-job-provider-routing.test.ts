/**
 * Tests for per-job provider routing (feat/per-job-provider-routing).
 *
 * Uses the static-analysis pattern established in SessionManager-injection.test.ts:
 * read source as string, assert structural properties. Behavioral tests are added
 * where the static analysis is insufficient.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TYPES_SRC = path.join(process.cwd(), 'src/core/types.ts');
const SESSION_MANAGER_SRC = path.join(process.cwd(), 'src/core/SessionManager.ts');
const JOB_SCHEDULER_SRC = path.join(process.cwd(), 'src/scheduler/JobScheduler.ts');
const CONFIG_SRC = path.join(process.cwd(), 'src/core/Config.ts');

// ── 1. ProviderConfig interface ──────────────────────────────────────────────

describe('ProviderConfig interface in types.ts', () => {
  it('exists and has required claudePath field', () => {
    const source = fs.readFileSync(TYPES_SRC, 'utf-8');
    expect(source).toContain('export interface ProviderConfig');
    expect(source).toContain('claudePath: string;');
  });

  it('has optional env field typed as Record<string, string>', () => {
    const source = fs.readFileSync(TYPES_SRC, 'utf-8');
    const start = source.indexOf('export interface ProviderConfig');
    const end = source.indexOf('\n}', start) + 2;
    const block = source.slice(start, end);
    expect(block).toContain('env?:');
    expect(block).toContain('Record<string, string>');
  });

  it('has optional modelTiers field typed as Partial<Record<ModelTier, string>>', () => {
    const source = fs.readFileSync(TYPES_SRC, 'utf-8');
    const start = source.indexOf('export interface ProviderConfig');
    const end = source.indexOf('\n}', start) + 2;
    const block = source.slice(start, end);
    expect(block).toContain('modelTiers?:');
    expect(block).toContain('Partial<Record<ModelTier, string>>');
  });

  it('ProviderConfig is declared before ModelTier is used (ModelTier already exported)', () => {
    const source = fs.readFileSync(TYPES_SRC, 'utf-8');
    // ModelTier must be exported
    expect(source).toContain("export type ModelTier = 'opus' | 'sonnet' | 'haiku'");
  });
});

// ── 2. SessionManagerConfig.providers ────────────────────────────────────────

describe('SessionManagerConfig.providers in types.ts', () => {
  it('is an optional Record<string, ProviderConfig>', () => {
    const source = fs.readFileSync(TYPES_SRC, 'utf-8');
    const start = source.indexOf('export interface SessionManagerConfig');
    const end = source.indexOf('\n}', start) + 2;
    const block = source.slice(start, end);
    expect(block).toContain('providers?:');
    expect(block).toContain('Record<string, ProviderConfig>');
  });
});

// ── 3. JobDefinition.provider ─────────────────────────────────────────────────

describe('JobDefinition.provider in types.ts', () => {
  it('is an optional string field', () => {
    const source = fs.readFileSync(TYPES_SRC, 'utf-8');
    const start = source.indexOf('export interface JobDefinition');
    const end = source.indexOf('\n}', start) + 2;
    const block = source.slice(start, end);
    expect(block).toContain('provider?:');
    expect(block).toContain('string');
  });
});

// ── 4–5. spawnSession claudePath resolution ───────────────────────────────────

describe('SessionManager.spawnSession — provider resolution', () => {
  it('accepts provider option in spawnSession signature', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const start = source.indexOf('async spawnSession(options:');
    const optionsEnd = source.indexOf('): Promise<Session>', start);
    const signature = source.slice(start, optionsEnd);
    expect(signature).toContain('provider?:');
    expect(signature).toContain('string');
  });

  it('resolves claudePath from provider when provider is set', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    // Must have the provider resolution line
    expect(source).toContain('provider?.claudePath ?? this.config.claudePath');
  });

  it('falls through to config.claudePath when no provider is set', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    // The ?? fallback guarantees back-compat
    expect(source).toContain('provider?.claudePath ?? this.config.claudePath');
    // And it must NOT use this.config.claudePath directly in the tmux spawn call
    const spawnStart = source.indexOf('execFileSync(this.config.tmuxPath');
    const spawnBlock = source.slice(spawnStart, spawnStart + 2000);
    // The spawn uses `claudePath` variable, not `this.config.claudePath`
    expect(spawnBlock).toMatch(/\bclaudePath\b, \.\.\.claudeArgs/);
    expect(spawnBlock).not.toContain('this.config.claudePath, ...claudeArgs');
  });

  it('resolves provider config from options.provider key', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    expect(source).toContain("this.config.providers?.[providerName]");
  });
});

// ── 6. Env merge ──────────────────────────────────────────────────────────────

describe('SessionManager.spawnSession — env merge', () => {
  it('builds provider env flags from provider.env entries', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    expect(source).toContain('provider?.env');
    expect(source).toContain('providerEnvFlags');
  });

  it('appends provider env flags AFTER the base env so provider keys win', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    // providerEnvFlags must appear after DATABASE_URL= isolation block in the spawn args
    const spawnStart = source.indexOf('execFileSync(this.config.tmuxPath');
    const spawnEnd = source.indexOf('], { encoding:', spawnStart);
    const spawnArgs = source.slice(spawnStart, spawnEnd);

    const dbIdx = spawnArgs.lastIndexOf("DATABASE_URL_TEST=");
    const providerIdx = spawnArgs.indexOf('...providerEnvFlags');
    expect(providerIdx).toBeGreaterThan(dbIdx);
  });
});

// ── 7–8. Model tier translation ───────────────────────────────────────────────

describe('SessionManager.spawnSession — model tier translation', () => {
  it('translates model tier through provider.modelTiers when available', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    expect(source).toContain('provider?.modelTiers?.[options.model]');
  });

  it('falls through to raw tier name when modelTiers is absent or tier not listed', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    // The ?? options.model fallback preserves the current behavior
    expect(source).toContain('provider?.modelTiers?.[options.model] ?? options.model');
  });

  it('passes actualModel (translated) to --model flag, not options.model directly', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    // The model push must use actualModel, not options.model
    expect(source).toContain("claudeArgs.push('--model', actualModel)");
    // And the guard must check actualModel, not options.model
    expect(source).toContain('if (actualModel)');
  });
});

// ── 9. JobScheduler passes job.provider ──────────────────────────────────────

describe('JobScheduler.spawnJobSession — passes job.provider', () => {
  it('passes provider: job.provider to sessionManager.spawnSession', () => {
    const source = fs.readFileSync(JOB_SCHEDULER_SRC, 'utf-8');
    // Find the spawnSession call site
    const start = source.indexOf('this.sessionManager.spawnSession({');
    const end = source.indexOf('}).then(', start);
    const callBlock = source.slice(start, end);
    expect(callBlock).toContain('provider: job.provider');
  });
});

// ── 10. Config.ts loads sessions.providers ────────────────────────────────────

describe('Config.ts — loads sessions.providers', () => {
  it('copies sessions.providers into SessionManagerConfig', () => {
    const source = fs.readFileSync(CONFIG_SRC, 'utf-8');
    expect(source).toContain('sessions.providers');
  });

  it('validates that providers is an object and warns if not', () => {
    const source = fs.readFileSync(CONFIG_SRC, 'utf-8');
    expect(source).toContain('sessions.providers is not an object');
  });
});
