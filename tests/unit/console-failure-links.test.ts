// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { machineIssue, noteLinked, MACHINES_PAGE } from '../../dashboard/console/ui.js';

describe('anything that fails links to the problem: machines that did not answer', () => {
  it('recognises the console\'s own wording for an unanswered machine, and nothing else', () => {
    expect(machineIssue('Mama PC did not answer; its sessions are not shown.')).toBe(true);
    expect(machineIssue('Laptop did not answer; its jobs are not shown.')).toBe(true);
    expect(machineIssue('Mac Mini: not answering (last seen 3 min ago)')).toBe(true);
    expect(machineIssue("Couldn't read other machines’ jobs: timeout. Showing this machine only.")).toBe(true);
    expect(machineIssue('Nothing is running on this machine.')).toBe(false);
  });
  it('such a note carries a link to the Machines page; any other note stays plain', () => {
    const linked = noteLinked('Mama PC did not answer; its sessions are not shown.');
    expect(linked.querySelector('a')?.getAttribute('href')).toBe(MACHINES_PAGE);
    expect(noteLinked('All quiet.').querySelector('a')).toBeNull();
  });
});
