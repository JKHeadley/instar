// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { sheet, closeSheet } from '../../dashboard/console/ui.js';

afterEach(() => {
  closeSheet();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function press(key: string, shiftKey = false) {
  const e = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  document.activeElement?.dispatchEvent(e);
  return e.defaultPrevented;
}

function button() {
  const node = document.createElement('button');
  vi.spyOn(node, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  return node;
}

it('wraps focus around live controls and restores the opener on Escape', () => {
  const opener = button();
  const alreadyInert = document.createElement('aside');
  alreadyInert.setAttribute('inert', '');
  document.body.append(opener, alreadyInert);
  opener.focus();

  const last = button();
  const disabled = button();
  disabled.disabled = true;
  const hidden = button();
  hidden.hidden = true;
  const panel = sheet({ title: 'Example' }, last, disabled, hidden);
  const first = panel.querySelector<HTMLButtonElement>('.sheet-close')!;
  vi.spyOn(first, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  expect(document.activeElement).toBe(first);
  expect(opener.hasAttribute('inert')).toBe(true);

  expect(press('Tab', true)).toBe(true);
  expect(document.activeElement).toBe(last);
  expect(press('Tab')).toBe(true);
  expect(document.activeElement).toBe(first);

  const lateBackgroundControl = button();
  document.body.append(lateBackgroundControl);
  lateBackgroundControl.focus();
  expect(document.activeElement).toBe(first);

  expect(press('Escape')).toBe(true);
  expect(document.activeElement).toBe(opener);
  expect(opener.hasAttribute('inert')).toBe(false);
  expect(alreadyInert.hasAttribute('inert')).toBe(true);
});

it('restores the original opener after replacing a sheet', () => {
  const opener = button();
  document.body.append(opener);
  opener.focus();
  const first = sheet({ title: 'First' });
  const replacement = sheet({ title: 'Replacement' });

  expect(first.isConnected).toBe(false);
  expect(replacement.contains(document.activeElement)).toBe(true);
  closeSheet();
  expect(document.activeElement).toBe(opener);
  expect(opener.hasAttribute('inert')).toBe(false);
});
