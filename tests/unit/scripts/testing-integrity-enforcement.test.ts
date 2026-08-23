// safe-git-allow: test fixture cleanup removes only per-test mkdtempSync directories.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverRouteEvidenceFiles,
  enumerateHttpRoutes,
  enforceTestingIntegrity,
  evaluateTestingIntegrity,
} from '../../../scripts/lint-testing-integrity.mjs';

const temporaryDirectories: string[] = [];

function temporaryTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-integrity-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Testing Integrity route enforcement', () => {
  it('derives a route planted in a nested source directory', () => {
    const root = temporaryTree();
    const source = path.join(root, 'src', 'server', 'nested', 'planted.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(
      source,
      "import { Router } from 'express';\nconst router = Router();\nrouter.get('/planted', (_req, res) => res.status(200).json({ ok: true }));\n",
    );

    const routes = enumerateHttpRoutes({ root });

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/planted' });
  });

  it('fails closed when the derived route population is empty', () => {
    const root = temporaryTree();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });

    expect(() => enumerateHttpRoutes({ root })).toThrow(/zero HTTP routes/i);
  });

  it('does not put a non-Express literal get call in the blocking denominator', () => {
    const root = temporaryTree();
    const source = path.join(root, 'src', 'mixed.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, [
      "const client = { get: (_path: string) => undefined };",
      "client.get('/not-an-http-route');",
      'const router = Router();',
      "router.get('/real-route', (_req, res) => res.status(200).end());",
    ].join('\n'));

    const routes = enumerateHttpRoutes({ root });

    expect(routes.map(route => `${route.method} ${route.path}`)).toEqual(['GET /real-route']);
  });

  it('rejects a planted changed route when no executed evidence exists', () => {
    const route = {
      method: 'GET',
      path: '/planted',
      fingerprint: 'changed-handler',
      declarations: ['src/server/planted.ts'],
    };

    const result = evaluateTestingIntegrity({
      currentRoutes: [route],
      baseRoutes: [],
      executedEvidence: [],
    });

    expect(result.passed).toBe(false);
    expect(result.changedRoutes).toEqual(['GET /planted']);
    expect(result.errors).toContain('GET /planted has no executed Tier-3 route evidence');
  });

  it('detects a symbol-preserving handler hollow as a material route change', () => {
    const root = temporaryTree();
    const source = path.join(root, 'src', 'server', 'route.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "const router = Router();\nrouter.get('/alive', (_req, res) => res.status(200).json({ ok: true }));\n");
    const baseRoutes = enumerateHttpRoutes({ root });

    fs.writeFileSync(source, "const router = Router();\nrouter.get('/alive', (_req, res) => res.status(503).json({ ok: true }));\n");
    const currentRoutes = enumerateHttpRoutes({ root });
    const result = evaluateTestingIntegrity({ currentRoutes, baseRoutes, executedEvidence: [] });

    expect(result.passed).toBe(false);
    expect(result.changedRoutes).toEqual(['GET /alive']);
  });

  it('accepts a changed route only when matching executed evidence exists', () => {
    const route = {
      method: 'POST',
      path: '/alive',
      fingerprint: 'new-handler',
      declarations: ['src/server/route.ts'],
    };

    const result = evaluateTestingIntegrity({
      currentRoutes: [route],
      baseRoutes: [],
      executedEvidence: [{ method: 'POST', path: '/alive', status: 201 }],
    });

    expect(result).toMatchObject({ passed: true, populationCount: 1, changedRoutes: ['POST /alive'], errors: [] });
  });

  it('fails closed on malformed production TypeScript', () => {
    const root = temporaryTree();
    const source = path.join(root, 'src', 'broken.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "const router = Router();\nrouter.get('/broken', (\n");

    expect(() => enumerateHttpRoutes({ root })).toThrow(/could not parse/i);
  });

  it.runIf(process.platform !== 'win32')('fails closed when a source input is unreadable', () => {
    const root = temporaryTree();
    const source = path.join(root, 'src', 'unreadable.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "const router = Router();\nrouter.get('/unreadable', (_req, res) => res.status(200).end());\n");
    fs.chmodSync(source, 0o000);

    try {
      expect(() => enumerateHttpRoutes({ root })).toThrow(/could not read/i);
    } finally {
      fs.chmodSync(source, 0o600);
    }
  });

  it('treats a changed non-literal Express route as not proven', () => {
    const root = temporaryTree();
    const source = path.join(root, 'src', 'dynamic.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "const api = Router();\napi.get(routePath, (_req, res) => res.status(200).end());\n");
    const baseRoutes = enumerateHttpRoutes({ root });

    fs.writeFileSync(source, "const api = Router();\napi.get(routePath, (_req, res) => res.status(201).end());\n");
    const currentRoutes = enumerateHttpRoutes({ root });
    const result = evaluateTestingIntegrity({ currentRoutes, baseRoutes, executedEvidence: [] });

    expect(result.passed).toBe(false);
    expect(result.errors[0]).toMatch(/changed non-literal route declaration; result is NOT-PROVEN/);
  });

  it('discovers only canonical executable evidence calls and recurses below tests/e2e', () => {
    const root = temporaryTree();
    const evidence = path.join(root, 'tests', 'e2e', 'nested', 'alive.test.ts');
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    fs.writeFileSync(evidence, [
      "import { expectRouteAlive } from '../../helpers/testingIntegrity.js';",
      "it('alive', async () => {",
      "  await expectRouteAlive(server, { method: 'PATCH', routePath: '/nested/:id', requestPath: '/nested/1', expectedStatus: 200 });",
      '});',
    ].join('\n'));

    const found = discoverRouteEvidenceFiles({ root });

    expect(found.get('PATCH /nested/:id')).toEqual(['tests/e2e/nested/alive.test.ts']);
  });

  it('enforces the planted violation through the named guard entry point', async () => {
    const root = temporaryTree();
    const source = path.join(root, 'src', 'server', 'planted.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "const router = Router();\nrouter.get('/planted', (_req, res) => res.status(200).end());\n");

    const result = await enforceTestingIntegrity({ root, baseRoutes: [], executedEvidence: [] });

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(['GET /planted has no executed Tier-3 route evidence']);
  });
});
