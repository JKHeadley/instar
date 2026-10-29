import { describe, expect, it } from 'vitest';
import { desktopVideoContract, encodeDesktopH264, parseNativeH264 } from '../../src/core/DesktopVideo.js';

const start = Buffer.from([0, 0, 0, 1]);
const key = Buffer.concat([start, Buffer.from([0x67, 1]), start, Buffer.from([0x68, 2]),
  start, Buffer.from([0x65, 3])]);
const delta = Buffer.concat([start, Buffer.from([0x41, 4])]);
const native = (flag: number, width: number, height: number, data: Buffer) => {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt16BE(width, 1);
  header.writeUInt16BE(height, 3);
  return Buffer.concat([header, data]);
};

describe('DesktopVideo contract and native framing', () => {
  it('pins AVC Annex B profile, maximum geometry, and generation in the signed contract', () => {
    expect(desktopVideoContract('h264')).toBe('desktop-video-v1:annexb:avc1.420028:1920x1080:g1');
    expect(desktopVideoContract('jpeg')).toBe('desktop-video-v1:jpeg:g1');
  });

  it('accepts a complete key unit and a dependent unit, retaining capture time', () => {
    const parsed = parseNativeH264(native(1, 1920, 1080, key));
    expect(parsed).toEqual({ data: key, keyframe: true, width: 1920, height: 1080 });
    const packet = encodeDesktopH264(parsed, 1_800_000_000_000);
    expect(packet.subarray(0, 4).toString()).toBe('IDV1');
    expect(packet[4]).toBe(1);
    expect(packet.readUInt16BE(6)).toBe(1920);
    expect(packet.readBigUInt64BE(10)).toBe(1_800_000_000_000n);
    expect(packet.subarray(18)).toEqual(key);
    expect(parseNativeH264(native(0, 640, 360, delta)).keyframe).toBe(false);
  });

  it('rejects incomplete key units, mislabeled deltas, and geometry outside the contract', () => {
    expect(() => parseNativeH264(native(1, 960, 540, delta))).toThrow('keyframe');
    expect(() => parseNativeH264(native(0, 960, 540, key))).toThrow('delta');
    expect(() => parseNativeH264(native(1, 1922, 1080, key))).toThrow('geometry');
    expect(() => parseNativeH264(native(1, 1920, 1082, key))).toThrow('geometry');
    expect(() => parseNativeH264(native(1, 960, 540, Buffer.from([1, 2, 3, 4, 0x65])))).toThrow('annexb');
    expect(() => parseNativeH264(native(1, 960, 540, Buffer.alloc(600_000)))).toThrow();
  });
});
