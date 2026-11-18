// @ts-nocheck — browser-native modules.
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
const root = path.resolve(__dirname, '../../dashboard/console');
const module = () => import(path.join(root, 'agent-health-note.js'));
const answer = (issues = [], extra = {}) => ({ok:true,data:{verdict:'attention',issues,truncated:false,...extra}});
const waiting = {impact:'user-affecting',requiresUserAction:false};
afterEach(() => { vi.useRealTimers(); });
describe('Agent status beside the door', () => {
 it('shows declared waits, distinguishes unreadable/truncated answers, and leaves actionable issues to Needs you', async () => {
  const {agentHealthNote} = await module();
  expect(agentHealthNote(answer([waiting]))).toBe('note');
  expect(agentHealthNote(answer([{impact:'user-affecting'}]))).toBe('clear');
  expect(agentHealthNote(answer([{impact:'internal'}]))).toBe('clear');
  for (const res of [{ok:false},answer([],{truncated:true}),answer([],{verdict:'unsure'}),answer([null]),{ok:true,data:{}}]) expect(agentHealthNote(res)).toBe('unknown');
 });
 it('polls the authenticated read, replaces stale mounts, surfaces failure, and stops on disconnect', async () => {
  vi.useFakeTimers();
  const dom = new JSDOM('<body><a id="first">Agent</a><a id="second">Agent</a>',{pretendToBeVisual:true});
  globalThis.document = dom.window.document;
  const {mountAgentHealthNote} = await module();
  let finish;
  const old = vi.fn(() => new Promise(r => {finish=r;}));
  const first = document.querySelector('#first');
  mountAgentHealthNote(first,{get:old});
  const second = document.querySelector('#second');
  const get = vi.fn().mockResolvedValueOnce(answer([waiting])).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(answer());
  const stop = mountAgentHealthNote(second,{get});
  await Promise.resolve(); await Promise.resolve();
  finish(answer([waiting])); await Promise.resolve();
  expect(first.querySelector('.dot')).toBeNull();
  expect(second.querySelector('.dot').className).toBe('dot attn');
  expect(get).toHaveBeenCalledWith('/mobile/health-issues');
  await vi.advanceTimersByTimeAsync(45000);
  expect(second.querySelector('.dot').getAttribute('aria-label')).toContain('could not be read');
  await vi.advanceTimersByTimeAsync(45000);
  expect(second.querySelector('.dot').hidden).toBe(true);
  second.remove(); await vi.advanceTimersByTimeAsync(90000);
  expect(get).toHaveBeenCalledTimes(3);
  stop();
 });
 it('the real shell mounts it on the Agent link after inserting the app', () => {
  const shell = fs.readFileSync(path.join(root,'console.js'),'utf8');
  expect(shell).toContain("import { mountAgentHealthNote } from './agent-health-note.js'");
  expect(shell).toContain('mountAgentHealthNote(app.querySelector(\'nav a[data-door="agent"]\'), { get })');
  expect(shell.indexOf('document.body.replaceChildren(app)')).toBeLessThan(shell.indexOf('mountAgentHealthNote(app.querySelector'));
 });
});
