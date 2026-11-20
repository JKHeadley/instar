/**
 * The "Project" label (docs/specs/work-front-doors.md §3.1 "the effort is the Project", §4.3 "the project name on
 * a card"), stage 2:
 *   - a card read carries its project's name with its key, to the same viewers only (an owner yes, a member no);
 *   - the card page's project link, with "Project name unavailable" for a missing or ID-only name;
 *   - an effort in Conversations is a Project when its front door or a conversation in it is a tracked project,
 *     a Group when it is not, and unsaid when the projects could not be read.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { cardJson } from '../../src/core/workBoardViews.js';
import { cardProjectLink } from '../../dashboard/console/work-model.js';
import { projectForEffort, graphConversationKey } from '../../dashboard/console/conversations-model.js';
import { trackedProjects } from '../../dashboard/console/chats-model.js';

const AGENT: WorkPrincipal = { kind: 'agent' };

function makeService() {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-20T03:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings({});
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_key, build) => {
      const hlc: HlcTimestamp = { physical: clock, logical: logical++, node: 'm_a' };
      const data = build(hlc, 'm_a');
      if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm_a' });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: () => null,
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: '' }),
    displayName: (k) => k,
  });
  return { svc };
}

const CARD = { title: 'Pick a venue', need: 'Choose one', doneWhen: [{ id: 'd1', text: 'Booked' }], outward: false, recommendation: 'Venue A', whyYou: 'Only you know who is coming.', projectKey: 'telegram:142440' };

describe('a card read carries its project name, to the viewers who see its project key', () => {
  it('the owner gets projectKey and projectTitle; a member gets neither', () => {
    const { svc } = makeService();
    const r = svc.createCard(AGENT, CARD); if (!r.ok) throw new Error(r.error);
    const v = svc.view(r.cardId)!;
    const owner = cardJson(svc, v, { isOwner: true, isAgent: false, personKey: 'justin' }, (k) => k, { projectTitle: 'Instar task system' });
    expect(owner.projectKey).toBe('telegram:142440');
    expect(owner.projectTitle).toBe('Instar task system');
    const member = cardJson(svc, v, { isOwner: false, isAgent: false, personKey: 'adriana' }, (k) => k, { projectTitle: 'Instar task system' });
    expect(member.projectKey).toBeUndefined();
    expect(member.projectTitle).toBeUndefined();
  });

  it('no name known, or a blank one, sends no projectTitle (the key still goes)', () => {
    const { svc } = makeService();
    const r = svc.createCard(AGENT, CARD); if (!r.ok) throw new Error(r.error);
    const v = svc.view(r.cardId)!;
    for (const projectTitle of [null, '   ', undefined]) {
      const j = cardJson(svc, v, { isOwner: true, isAgent: false, personKey: 'justin' }, (k) => k, { projectTitle });
      expect(j.projectKey).toBe('telegram:142440');
      expect(j.projectTitle).toBeUndefined();
    }
  });
});

describe('cardProjectLink (the card page)', () => {
  it('links to the project row on the Work page with its name', () => {
    expect(cardProjectLink({ projectKey: 'telegram:142440', projectTitle: 'Instar task system' })).toEqual({ href: '#/work/board?project=telegram%3A142440', label: 'Instar task system' });
  });
  it('a missing or ID-only name reads "Project name unavailable"; no key, a removed card or no card shows nothing', () => {
    expect(cardProjectLink({ projectKey: 'telegram:142440' })?.label).toBe('Project name unavailable');
    expect(cardProjectLink({ projectKey: 'telegram:142440', projectTitle: 'telegram:142440' })?.label).toBe('Project name unavailable');
    expect(cardProjectLink({ projectKey: null, projectTitle: 'X' })).toBeNull();
    expect(cardProjectLink({ projectKey: 'telegram:1', removed: true })).toBeNull();
    expect(cardProjectLink(null)).toBeNull();
  });
});

describe('an effort is a Project when the Chief of Staff tracks it', () => {
  const tracked = trackedProjects({ projects: [{ conversationKey: 'telegram:142440', key: 'telegram:142440', title: 'Instar task system' }] });
  const tg = (topicId: number) => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId });
  const effort = (frontDoor: unknown = null) => ({ kind: 'effort', frontDoor });

  it('graph refs map to the shared conversation keys', () => {
    expect(graphConversationKey(tg(5))).toBe('telegram:5');
    expect(graphConversationKey({ kind: 'conversation', platform: 'app', conversationKey: '0b2c-uuid' })).toBe('app:0b2c-uuid');
    expect(graphConversationKey({ kind: 'conversation', platform: 'slack', channel: 'C1' })).toBeNull();
    expect(graphConversationKey({ kind: 'effort', id: 'e' })).toBeNull();
  });

  it('its front door, or a conversation directly in it, is a tracked project → the project', () => {
    expect(projectForEffort(effort(tg(142440)), [], tracked)).toMatchObject({ title: 'Instar task system' });
    expect(projectForEffort(effort(), [{ kind: 'conversation', ref: tg(142440) }], tracked)).toMatchObject({ key: 'telegram:142440' });
  });

  it('a plain group is false; unreadable projects are null (unsaid, never called a group)', () => {
    expect(projectForEffort(effort(tg(7)), [{ kind: 'conversation', ref: tg(8) }], tracked)).toBe(false);
    expect(projectForEffort(effort(tg(142440)), [], null)).toBeNull();
  });

  it('a conversation is never a project here, and a nested effort does not make its parent one', () => {
    expect(projectForEffort({ kind: 'conversation' }, [], tracked)).toBe(false);
    expect(projectForEffort(effort(), [{ kind: 'effort', ref: { kind: 'effort', id: 'x' } }], tracked)).toBe(false);
  });
});
