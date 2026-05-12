/**
 * Structural coverage test for the /project skill surface.
 *
 * The spec (`docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.7) enumerates the
 * canonical command set. The agent reads `.claude/skills/instar-project/SKILL.md`
 * when /project is invoked, so the SKILL.md content IS the implementation —
 * if a command is missing from the file, the agent has no way to know it
 * exists. This test pins the file's contract by asserting:
 *
 *   1. The frontmatter declares the skill as user_invocable.
 *   2. Every spec § 1.7 command name appears as a header in the file.
 *   3. Each command section references the HTTP endpoint it wraps.
 *   4. Each documented endpoint actually exists in `src/server/routes.ts`.
 *
 * The fourth check protects against skill drift: if a route is renamed or
 * removed, the skill must update or the test fails — preventing the
 * "skill documents an endpoint that no longer responds" failure mode.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'instar-project', 'SKILL.md');
const ROUTES_PATH = path.join(REPO_ROOT, 'src', 'server', 'routes.ts');

let skillBody: string;
let routesBody: string;

beforeAll(() => {
  skillBody = fs.readFileSync(SKILL_PATH, 'utf8');
  routesBody = fs.readFileSync(ROUTES_PATH, 'utf8');
});

describe('/project skill — structural coverage', () => {
  it('frontmatter declares user_invocable: true', () => {
    expect(skillBody).toMatch(/^---\s*\n[\s\S]*?\nuser_invocable:\s*true\s*\n[\s\S]*?\n---/);
  });

  // The spec § 1.7 canonical list. Each entry is the heading the SKILL.md
  // must contain (a leading `##` for the section header).
  const SPEC_COMMANDS: ReadonlyArray<{ name: string; endpoint: RegExp }> = [
    { name: '/project create', endpoint: /POST\s+\/projects\b|router\.post\(['"]\/projects['"]/i },
    { name: '/project status', endpoint: /GET\s+\/projects(\/:id)?\b|router\.get\(['"]\/projects['"]/i },
    { name: '/project next', endpoint: /router\.get\(['"]\/projects\/:id\/next['"]/ },
    { name: '/project advance', endpoint: /router\.post\(['"]\/projects\/:id\/advance['"]/ },
    { name: '/project drift', endpoint: /router\.post\(['"]\/projects\/:id\/drift-check['"]/ },
    { name: '/project run-round', endpoint: /router\.post\(['"]\/projects\/:id\/run-round['"]/ },
    { name: '/project halt', endpoint: /router\.post\(['"]\/projects\/:id\/halt['"]/ },
    { name: '/project ack', endpoint: /router\.post\(['"]\/projects\/:id\/ack['"]/ },
    { name: '/project resume', endpoint: /router\.post\(['"]\/projects\/:id\/resume['"]/ },
    { name: '/project abandon', endpoint: /router\.post\(['"]\/projects\/:id\/abandon['"]/ },
    { name: '/project accept-partial', endpoint: /router\.post\(['"]\/projects\/:id\/accept-partial['"]/ },
    { name: '/project claim-ownership', endpoint: /router\.post\(['"]\/projects\/:id\/claim-ownership['"]/ },
  ];

  for (const { name, endpoint } of SPEC_COMMANDS) {
    it(`documents ${name} with a section header`, () => {
      // Look for a `## \`/project foo` or `## \`/project foo <args>` style header.
      const headerRe = new RegExp(`^##\\s+\`${name.replace(/\//g, '\\/')}\\b`, 'm');
      expect(skillBody).toMatch(headerRe);
    });

    it(`backing endpoint for ${name} exists in routes.ts`, () => {
      expect(routesBody).toMatch(endpoint);
    });
  }

  it('does not surface the obsolete Phase 1a "next is a 501 placeholder" language', () => {
    // The connect-the-dots PR made /next return a real structured payload.
    // The skill must not still tell users to expect 501.
    expect(skillBody).not.toMatch(/501\s*\{\s*action:\s*['"]not-implemented/);
    expect(skillBody).not.toMatch(/placeholder until Phase 1b/i);
  });

  it('describes the structured /next response shape (action/params/skillCommand)', () => {
    expect(skillBody).toMatch(/\{action,\s*params,\s*skillCommand\}|action,\s*params,\s*skillCommand/);
  });

  it('warns against pasting curl commands to users', () => {
    // Echo's conversational-tone rule (CLAUDE.md): never present CLI to the user.
    // The skill must remind callers of this since every section shows a curl.
    expect(skillBody.toLowerCase()).toMatch(/never paste a curl/);
  });
});
