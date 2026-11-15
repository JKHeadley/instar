/**
 * native-conversation-any-machine-access §3f — agent awareness and migration parity for transcript
 * copies, and the dark default with its ladder entry.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { transcriptCopiesAwareness, TRANSCRIPT_COPIES_AWARENESS_MARKER } from '../../src/core/transcriptCheckpoints.js';
import { getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DARK_GATE_EXCLUSIONS } from '../../src/core/devGatedFeatures.js';
import { readShippedRegistry } from '../../src/monitoring/MaturationLadderService.js';
import { parseLadderRegistry } from '../../src/monitoring/MaturationLadder.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('transcript copies awareness installation parity', () => {
  it('new agents learn the copy read, the coverage sentence and the audience rule', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(transcriptCopiesAwareness(4042));
    for (const phrase of ['via: "copy"', 'later rows are not here yet', '/transcript-copies', 'withheldRows', 'No phone, member or guest reads a copy']) expect(md).toContain(phrase);
    expect(generateClaudeMd('solo', 'Solo', 4042, false)).toContain(TRANSCRIPT_COPIES_AWARENESS_MARKER);
  });

  it('existing agents receive it once, in CLAUDE.md and the framework shadow', () => {
    const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
    const projectDir = fs.mkdtempSync(path.join(tmpBase, 'tc-awareness-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(md, '# Existing custom instructions\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1740' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split(TRANSCRIPT_COPIES_AWARENESS_MARKER)).toHaveLength(2);
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8').split(TRANSCRIPT_COPIES_AWARENESS_MARKER)).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:tc-awareness:cleanup' });
    }
  });
});

describe('dark until its live date', () => {
  it('ships off on every agent, declared as a dark-gate exclusion, with a sensitive ladder entry', () => {
    const d = getMigrationDefaults('standalone') as { multiMachine: { stateSync: { sessionTranscripts: { enabled: boolean; bytesPerDay: number } } } };
    expect(d.multiMachine.stateSync.sessionTranscripts).toEqual({ enabled: false, bytesPerDay: 256 * 1024 * 1024 });
    const excl = DARK_GATE_EXCLUSIONS.find((e) => e.configPath === 'multiMachine.stateSync.sessionTranscripts.enabled');
    expect(excl?.reason).toContain('CMT-047');
    const parsed = parseLadderRegistry(readShippedRegistry());
    if (!parsed.ok) throw new Error(parsed.reason);
    const entry = parsed.registry.entries.find((e) => e.id === 'multiMachine.stateSync.sessionTranscripts')!;
    expect(entry).toMatchObject({ risk: 'sensitive', disposition: 'ladder', final: 'default-on' });
    expect(entry.rungs['dev-agent-live']).toBeDefined();
    expect(entry.rungs.fleet).toBeDefined();
  });
});
