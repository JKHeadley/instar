import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

describe('actual trace writer all-tier advisory wiring', () => {
  it('calls the HTTP consumer at Tier 1 and Tier 2, reuses the same source and keeps failures explicit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constitutional-trace-'));
    const repository = process.cwd();
    let calls = 0;
    const context = { checkerIdentity: 'fixture-checker', governing: { available: true, identity: 'fixture-source' } };
    const server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('conformance-metrics')) { res.end(JSON.stringify({ context })); return; }
      calls++;
      let data = ''; for await (const chunk of req) data += chunk;
      const { markdown } = JSON.parse(data);
      expect(markdown).toContain('export const widget = 1');
      expect(markdown.startsWith('---')).toBe(false); // never a second parent-fit request
      res.end(JSON.stringify({ report: { ...context, degraded: false, checkedAt: new Date().toISOString(), findings: [{ standard: 'Rule 10', reason: 'fixture finding delivered to the builder' }] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const write = (file: string, content: string) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
    const git = (args: string[]) => SafeGitExecutor.execSync(args, { cwd: root, stdio: 'ignore', operation: 'constitutional-trace-integration:git' });
    try {
      git(['init', '-q']);
      for (const file of ['skills/instar-dev/scripts/write-trace.mjs', 'skills/instar-dev/scripts/constitutional-review.mjs', 'dist/core/durableSecretScrub.js']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.copyFileSync(path.join(repository, file), path.join(root, file));
      }
      const trusted = path.join(root, '.instar/shadow-install/node_modules/instar');
      fs.mkdirSync(path.join(trusted, 'dist/core'), { recursive: true });
      fs.writeFileSync(path.join(trusted, 'package.json'), '{"type":"module"}');
      fs.copyFileSync(path.join(repository, 'dist/core/durableSecretScrub.js'), path.join(trusted, 'dist/core/durableSecretScrub.js'));
      write('package.json', '{"type":"module"}');
      write('.instar/config.json', JSON.stringify({ projectName: 'fixture-agent', port }));
      write('src/widget.ts', 'export const widget = 1;\n');
      write('docs/specs/widget.eli16.md', '# Widget overview\nA narrow fixture change.');
      write('docs/specs/widget.md', '---\nslug: widget\n---\n# Widget design\nA narrow fixture change.');
      write('upgrades/side-effects/widget.md', '# Assessment\n' + 'Review fixture describing effects and rollback. '.repeat(8));
      git(['add', 'src/widget.ts', 'docs/specs/widget.eli16.md', 'docs/specs/widget.md', 'upgrades/side-effects/widget.md']);
      const run = (tier: number) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const args = ['skills/instar-dev/scripts/write-trace.mjs', '--artifact', 'upgrades/side-effects/widget.md', '--files', 'src/widget.ts', '--tier', String(tier), ...(tier === 1 ? ['--eli16-path', 'docs/specs/widget.eli16.md'] : ['--spec', 'docs/specs/widget.md'])];
        const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, INSTAR_AGENT_HOME: root, INSTAR_AUTH_TOKEN: 'fixture-auth', INSTAR_DEV_ALLOW_UNINSTALLED_GATE: '1' } });
        let stdout = '', stderr = ''; child.stdout.on('data', (c) => stdout += c); child.stderr.on('data', (c) => stderr += c);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
      const one = await run(1); expect(one.status, one.stderr).toBe(0);
      const first = JSON.parse(fs.readFileSync(path.join(root, one.stdout.trim()), 'utf8'));
      expect(first.constitutionalReview.status).toBe('checked');
      expect(one.stderr).toContain('fixture finding delivered to the builder');
      write('.instar/instar-dev-decisions/precommit-output.json', JSON.stringify({ constitutionalReview: first.constitutionalReview, verdict: 'pass' }));
      git(['add', '.instar/instar-dev-decisions/precommit-output.json']);
      const two = await run(1); expect(two.status, two.stderr).toBe(0);
      expect(calls).toBe(1); // the generated/staged trace did not review itself
      const full = await run(2); expect(full.status, full.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(root, full.stdout.trim()), 'utf8')).constitutionalReview.status).toBe('checked');
      expect(calls).toBe(2); // a different overview is a different complete input
      await new Promise<void>((resolve) => server.close(() => resolve()));
      write('src/widget.ts', 'export const widget = 2;\n'); git(['add', 'src/widget.ts']);
      const unavailable = await run(1); expect(unavailable.status, unavailable.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(root, unavailable.stdout.trim()), 'utf8')).constitutionalReview.status).toBe('unavailable');
    } finally {
      server.closeAllConnections(); server.close();
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'constitutional-trace-integration:cleanup' });
    }
  });
});
