import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { pinLocalHistoryCopyVolume } from '../../src/import/LocalHistoryCopyVolume.js';

let root: string;
let upload: string;
let destination: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-volume-'));
  upload = fs.mkdirSync(path.join(root, 'upload'), { recursive: true })!;
  destination = fs.mkdirSync(path.join(root, 'destination'), { recursive: true })!;
});
afterEach(() => {
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(root, { recursive: true, operation: 'copy volume fixture cleanup' });
});

it('measures the shared volume and checks an opened regular file', () => {
  const pin = pinLocalHistoryCopyVolume(upload, [destination]);
  const fd = fs.openSync(path.join(destination, 'file'), 'wx');
  try {
    const measurement = pin.measure();
    expect(measurement.blockBytes).toBeGreaterThan(0);
    expect(measurement.total).toBeGreaterThanOrEqual(measurement.free);
    expect(() => pin.assertFileVolume(fd)).not.toThrow();
  } finally {
    fs.closeSync(fd);
    pin.close();
  }
  expect(() => pin.measure()).toThrow('local-history-copy-volume');
});

it('refuses replacement of a pinned destination directory', () => {
  const pin = pinLocalHistoryCopyVolume(upload, [destination]);
  try {
    fs.renameSync(destination, path.join(root, 'original'));
    fs.mkdirSync(destination);
    expect(() => pin.measure()).toThrow('local-history-copy-volume');
  } finally {
    pin.close();
  }
});

it('refuses a destination symlink', () => {
  const alias = path.join(root, 'alias');
  fs.symlinkSync(destination, alias);
  expect(() => pinLocalHistoryCopyVolume(upload, [alias])).toThrow('local-history-copy-volume');
});

it('refuses a destination descriptor on a different device', () => {
  const original = fs.fstatSync;
  let inspected = 0;
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options: { bigint: true }) => {
    const stat = original(fd, options);
    if (++inspected === 2) stat.dev += 1n;
    return stat;
  }) as typeof fs.fstatSync);
  expect(() => pinLocalHistoryCopyVolume(upload, [destination])).toThrow('local-history-copy-volume');
});

it('rejects a measurement when the upload directory changes during sampling', () => {
  const pin = pinLocalHistoryCopyVolume(upload, [destination]);
  const original = fs.statfsSync;
  vi.spyOn(fs, 'statfsSync').mockImplementationOnce(((directory: string, options: { bigint: true }) => {
    const stat = original(directory, options);
    fs.renameSync(upload, path.join(root, 'original-upload'));
    fs.mkdirSync(upload);
    return stat;
  }) as typeof fs.statfsSync);
  try {
    expect(() => pin.measure()).toThrow('local-history-copy-volume');
  } finally {
    pin.close();
  }
});
