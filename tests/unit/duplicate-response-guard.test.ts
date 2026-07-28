import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { duplicateResponseGuard, errorHandler } from '../../src/server/middleware.js';

describe('duplicateResponseGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses a direct second JSON send after a response is committed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express();
    app.use(duplicateResponseGuard);
    app.get('/double-send', (_req, res) => {
      res.json({ first: true });
      expect(() => res.status(500).json({ second: true })).not.toThrow();
    });
    app.use(errorHandler);

    const res = await request(app).get('/double-send');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ first: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Suppressed duplicate response send'));
  });

  it('does not emit a second 500 when an error arrives after a response was sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express();
    app.use(duplicateResponseGuard);
    app.get('/sent-then-error', (_req, res, next) => {
      res.json({ ok: true });
      next(new Error('late handler failure'));
    });
    app.use(errorHandler);

    const res = await request(app).get('/sent-then-error');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Error after response was already sent'));
  });
});
