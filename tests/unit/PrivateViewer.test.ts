/**
 * Unit tests for PrivateViewer.
 *
 * Tests CRUD operations, HTML rendering, and state persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrivateViewer } from '../../src/publishing/PrivateViewer.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';

describe('PrivateViewer', () => {
  let project: TempProject;
  let viewsDir: string;

  beforeEach(() => {
    project = createTempProject();
    viewsDir = path.join(project.stateDir, 'views');
  });

  afterEach(() => {
    project.cleanup();
  });

  function createViewer(): PrivateViewer {
    return new PrivateViewer({ viewsDir });
  }

  describe('create', () => {
    it('creates a view with UUID id', () => {
      const viewer = createViewer();
      const view = viewer.create('Test Title', '# Hello\n\nWorld');

      expect(view.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(view.title).toBe('Test Title');
      expect(view.markdown).toBe('# Hello\n\nWorld');
      expect(view.createdAt).toBeTruthy();
    });

    it('persists view to disk', () => {
      const viewer = createViewer();
      const view = viewer.create('Persisted', 'content');

      const filePath = path.join(viewsDir, `${view.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(saved.title).toBe('Persisted');
    });

    it('creates views directory if it does not exist', () => {
      const customDir = path.join(project.dir, 'custom-views');
      const viewer = new PrivateViewer({ viewsDir: customDir });
      viewer.create('Test', 'content');
      expect(fs.existsSync(customDir)).toBe(true);
    });
  });

  describe('get', () => {
    it('retrieves an existing view', () => {
      const viewer = createViewer();
      const created = viewer.create('Get Test', 'markdown');

      const retrieved = viewer.get(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe('Get Test');
      expect(retrieved!.markdown).toBe('markdown');
    });

    it('returns null for non-existent view', () => {
      const viewer = createViewer();
      expect(viewer.get('nonexistent-id')).toBeNull();
    });

    it('survives across instances', () => {
      const viewer1 = createViewer();
      const view = viewer1.create('Survive', 'data');

      const viewer2 = createViewer();
      const retrieved = viewer2.get(view.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe('Survive');
    });
  });

  describe('update', () => {
    it('updates title and markdown', () => {
      const viewer = createViewer();
      const view = viewer.create('Original', 'old content');

      const updated = viewer.update(view.id, 'Updated', 'new content');
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Updated');
      expect(updated!.markdown).toBe('new content');
      expect(updated!.updatedAt).toBeTruthy();
    });

    it('returns null for non-existent view', () => {
      const viewer = createViewer();
      expect(viewer.update('fake-id', 'Title', 'md')).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes an existing view', () => {
      const viewer = createViewer();
      const view = viewer.create('Delete Me', 'content');

      expect(viewer.delete(view.id)).toBe(true);
      expect(viewer.get(view.id)).toBeNull();
    });

    it('returns false for non-existent view', () => {
      const viewer = createViewer();
      expect(viewer.delete('fake-id')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all views sorted by newest first', () => {
      const viewer = createViewer();
      viewer.create('First', 'a');
      viewer.create('Second', 'b');
      viewer.create('Third', 'c');

      const views = viewer.list();
      expect(views).toHaveLength(3);
      // Newest first
      expect(views[0].title).toBe('Third');
      expect(views[2].title).toBe('First');
    });

    it('returns empty array when no views', () => {
      const viewer = createViewer();
      expect(viewer.list()).toEqual([]);
    });
  });

  describe('PIN protection', () => {
    it('creates a view with PIN hash', () => {
      const viewer = createViewer();
      const view = viewer.create('Secret', 'content', '1234');

      expect(view.pinHash).toBeTruthy();
      expect(view.pinHash).not.toBe('1234'); // Should be hashed
    });

    it('creates a view without PIN when not provided', () => {
      const viewer = createViewer();
      const view = viewer.create('Public', 'content');

      expect(view.pinHash).toBeUndefined();
    });

    it('verifyPin returns true for correct PIN', () => {
      const viewer = createViewer();
      const view = viewer.create('Secret', 'content', 'mypin');

      expect(viewer.verifyPin(view.id, 'mypin')).toBe(true);
    });

    it('verifyPin returns false for wrong PIN', () => {
      const viewer = createViewer();
      const view = viewer.create('Secret', 'content', 'mypin');

      expect(viewer.verifyPin(view.id, 'wrongpin')).toBe(false);
    });

    it('verifyPin returns false for non-existent view', () => {
      const viewer = createViewer();
      expect(viewer.verifyPin('fake-id', '1234')).toBe(false);
    });

    it('verifyPin returns false for view without PIN', () => {
      const viewer = createViewer();
      const view = viewer.create('NoPIN', 'content');

      expect(viewer.verifyPin(view.id, '1234')).toBe(false);
    });

    it('PIN hash persists across instances', () => {
      const viewer1 = createViewer();
      const view = viewer1.create('Persist', 'content', 'secret');

      const viewer2 = createViewer();
      expect(viewer2.verifyPin(view.id, 'secret')).toBe(true);
    });

    it('renderPinPage returns HTML with PIN form', () => {
      const viewer = createViewer();
      const view = viewer.create('Locked', 'content', '1234');

      const html = viewer.renderPinPage(view);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('PIN-protected');
      expect(html).toContain('pin-input');
      expect(html).toContain('Unlock');
      expect(html).toContain('Locked');
      // Should NOT contain the actual markdown content
      expect(html).not.toContain('>content<');
    });

    it('renderPinPage shows error when error=true', () => {
      const viewer = createViewer();
      const view = viewer.create('Locked', 'content', '1234');

      const html = viewer.renderPinPage(view, true);
      expect(html).toContain('Incorrect PIN');
      expect(html).toContain("display: block");
    });

    it('renderPinPage escapes title to prevent XSS', () => {
      const viewer = createViewer();
      const view = viewer.create('<script>alert(1)</script>', 'content', '1234');

      const html = viewer.renderPinPage(view);
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('renderHtml', () => {
    it('produces valid HTML with title', () => {
      const viewer = createViewer();
      const view = viewer.create('My Report', '# Report\n\nSome **bold** text.');

      const html = viewer.renderHtml(view);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>My Report</title>');
      expect(html).toContain('<h1>My Report</h1>');
      expect(html).toContain('<h3>');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('Served by Instar');
    });

    it('escapes HTML in title', () => {
      const viewer = createViewer();
      const view = viewer.create('<script>alert("xss")</script>', 'content');

      const html = viewer.renderHtml(view);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('renders code blocks with syntax styling', () => {
      const viewer = createViewer();
      const view = viewer.create('Code', '```\nconst x = 1;\n```');

      const html = viewer.renderHtml(view);
      expect(html).toContain('<pre>');
      expect(html).toContain('<code>');
    });

    it('renders lists correctly', () => {
      const viewer = createViewer();
      const view = viewer.create('Lists', '- Item 1\n- Item 2');

      const html = viewer.renderHtml(view);
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>');
    });

    it('includes inline CSS (self-contained)', () => {
      const viewer = createViewer();
      const view = viewer.create('Styled', 'text');

      const html = viewer.renderHtml(view);
      expect(html).toContain('<style>');
      expect(html).toContain('font-family');
      // Should NOT have external stylesheet references
      expect(html).not.toContain('<link rel="stylesheet"');
    });
  });
});
