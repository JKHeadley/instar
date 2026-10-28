/** Authenticated video payload inside the existing desktop AEAD frame record.
 * JPEG keeps its legacy bytes. H.264 uses one complete Annex B access unit
 * with a fixed header; the decoder may start only at an SPS/PPS/IDR key unit. */
export const H264_CODEC = 'avc1.42001F';
export const H264_MAX_WIDTH = 960;
export const H264_MAX_HEIGHT = 540;
export const H264_MAX_ACCESS_UNIT = 600_000;
export function desktopVideoContract(codec: 'jpeg' | 'h264'): string {
  return codec === 'h264'
    ? 'desktop-video-v1:annexb:avc1.42001F:960x540:g1'
    : 'desktop-video-v1:jpeg:g1';
}
const MAGIC = Buffer.from('IDV1');
const HEADER_SIZE = 18;

export interface DesktopH264Frame {
  data: Buffer;
  keyframe: boolean;
  width: number;
  height: number;
}

function nalTypes(data: Buffer): Set<number> {
  const types = new Set<number>();
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      types.add(data[i + 4] & 0x1f);
      i += 4;
    }
  }
  return types;
}

export function parseNativeH264(payload: Buffer): DesktopH264Frame {
  if (payload.length < 10 || payload.length > H264_MAX_ACCESS_UNIT
    || (payload[0] !== 0 && payload[0] !== 1)) throw new Error('desktop-h264-frame-invalid');
  const width = payload.readUInt16BE(1);
  const height = payload.readUInt16BE(3);
  if (width < 2 || width > H264_MAX_WIDTH || height < 2 || height > H264_MAX_HEIGHT
    || width % 2 !== 0 || height % 2 !== 0) throw new Error('desktop-h264-geometry-invalid');
  const data = payload.subarray(5);
  if (!data.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))) {
    throw new Error('desktop-h264-annexb-invalid');
  }
  const types = nalTypes(data);
  if (payload[0] === 1 && (!types.has(7) || !types.has(8) || !types.has(5))) {
    throw new Error('desktop-h264-keyframe-invalid');
  }
  if (payload[0] === 0 && !types.has(1)) throw new Error('desktop-h264-delta-invalid');
  return { data, keyframe: payload[0] === 1, width, height };
}

export function encodeDesktopH264(frame: DesktopH264Frame, capturedAt = Date.now()): Buffer {
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height)
    || frame.width < 2 || frame.width > H264_MAX_WIDTH || frame.width % 2 !== 0
    || frame.height < 2 || frame.height > H264_MAX_HEIGHT || frame.height % 2 !== 0
    || frame.data.length < 5 || frame.data.length + HEADER_SIZE > H264_MAX_ACCESS_UNIT
    || !frame.data.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))
    || !Number.isSafeInteger(capturedAt)
    || capturedAt < 0) throw new Error('desktop-h264-frame-invalid');
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header);
  header[4] = 1; // Annex B AVC baseline level 3.1
  header[5] = frame.keyframe ? 1 : 0;
  header.writeUInt16BE(frame.width, 6);
  header.writeUInt16BE(frame.height, 8);
  header.writeBigUInt64BE(BigInt(capturedAt), 10);
  return Buffer.concat([header, frame.data]);
}
