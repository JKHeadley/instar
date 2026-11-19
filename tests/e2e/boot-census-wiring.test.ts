/**
 * restart-lock-continuity part A: production wiring is alive. The census is taken
 * before the boot purge, the 15-minute notice is scheduled after it, and the
 * routes are served outside the resume-queue 503 guard.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const server = read('src/commands/server.ts');

describe('boot census wiring', () => {
  it('captures the census before purgeDeadSessions', () => {
    const capture = server.indexOf('census.capture(state.listSessions())');
    const purge = server.indexOf('await sessionManager.purgeDeadSessions();');
    expect(capture).toBeGreaterThan(0);
    expect(purge).toBeGreaterThan(capture);
    expect(server).toMatch(/setActiveBootSessionCensus\(census\)/);
  });

  it('schedules the once-per-boot open-work notice after the purge', () => {
    const purge = server.indexOf('await sessionManager.purgeDeadSessions();');
    const notice = server.indexOf('buildOpenWorkNotice(census.classify(file, deps))');
    expect(notice).toBeGreaterThan(purge);
    expect(server).toMatch(/if \(!census\.markNoticeSent\(\)\) return;/);
    expect(server).toMatch(/15 \* 60 \* 1000/);
  });

  it('serves the census routes independently of the resume queue', () => {
    const routes = read('src/server/routes.ts');
    const census = routes.indexOf("router.get('/sessions/boot-census'");
    const rq = routes.indexOf("router.get('/sessions/resume-queue'");
    expect(census).toBeGreaterThan(0);
    expect(routes.slice(census, rq)).not.toMatch(/ctx\.resumeQueue/);
    expect(routes).toMatch(/router\.post\('\/sessions\/boot-census\/reviewed'/);
  });
});
