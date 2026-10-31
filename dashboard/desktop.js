// Remote-desktop viewer. Secrets and frames stay in memory only.
const $ = id => document.getElementById(id);
let token = '';
let operatorSession = '';
let keyPair;
let ecdhKeyPair;
let aesKey;
let inputSequence = 0n;
let frameSequence = 0n;
let sendChain = Promise.resolve();
let receiveChain = Promise.resolve();
let requestId = '';
let machineId = '';
const trustedTargetKeys = new Map();
let trustedTargetSigningPublicKey = '';
let connectionNonce = '';
let socket;
let frameUrl = '';
let videoCodec = 'jpeg';
let activeVideoCodec = 'jpeg';
let decoder = null;
let decoderGeneration = 0;
let decoderStartupTimer = 0;
let decoderWidth = 0;
let decoderHeight = 0;
let needsVideoKeyframe = true;
let lastKeyframeRequestAt = 0;
let videoFallbackCount = 0;
const H264_CODEC = 'avc1.420028';
const H264_CONFIG = { codec: H264_CODEC, codedWidth: 1920, codedHeight: 1080,
  optimizeForLatency: true };
function videoContract(codec) {
  return codec === 'h264' ? 'desktop-video-v1:annexb:avc1.420028:1920x1080:g1'
    : 'desktop-video-v1:jpeg:g1';
}
let lastMoveAt = 0;
let pendingMove = null;
let moveFrame = 0;
let heartbeat = 0;
let inputEnabled = false;
let streamEpoch = 0;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let reconnectTimer = 0;
let resumeGeneration = 0;
let resumeAttempt = null;
let resumeSetupFailures = 0;
let resumeTransportFailures = 0;
const resumeControllers = new Set();
let stopping = false;
let trackpad = matchMedia('(pointer: coarse)').matches;
let touchCapable = matchMedia('(any-pointer: coarse)').matches;
let cursor = { x: 0.5, y: 0.5 };
const pointers = new Map();
let zoom = 1;
let panX = 0;
let panY = 0;
let twoFinger = null;
let wheelFrame = 0;
let pendingWheel = null;
let composingText = false;
let skipCompositionCommitKey = false;
let recentlyCommittedText = '';
let heldButton = null;
let heldPhase = 'none';
let holdHeartbeat = 0;
let buttonOperationId = 0;
let buttonReleaseRequested = false;
let nextKeyOperationId = 0;
const heldKeys = new Map();
const keyOperationIds = new Map();
const keyReleaseRequested = new Set();
const keyReleaseQueue = [];
const pendingKeyTaps = new Set();
const remoteKeys = new Set(['Meta', 'Control', 'Alt', 'Shift', 'Enter', 'Tab',
  'Escape', 'Backspace', 'Delete', 'Space', 'ArrowLeft', 'ArrowRight',
  'ArrowUp', 'ArrowDown', 'a', 'c', 'v', 'x', 'z']);

function syncHoldHeartbeat() {
  if (holdHeartbeat) { clearInterval(holdHeartbeat); holdHeartbeat = 0; }
  if (heldButton || heldKeys.size) {
    holdHeartbeat = setInterval(() => { if (inputEnabled) void sendCommand({ type: 'ping' }); }, 1_000);
  }
}

function setHeldButton(button, phase = button ? 'sent' : 'none') {
  if (!button) { buttonOperationId++; buttonReleaseRequested = false; }
  heldButton = button;
  heldPhase = phase;
  syncHoldHeartbeat();
  $('dragButton').textContent = button ? 'Release' : 'Drag';
  $('dragButton').setAttribute('aria-pressed', String(!!button));
}
function flushPendingMove() {
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  if (pendingMove) { send({ kind: 'move', ...pendingMove }); pendingMove = null; }
}
function releaseButton() {
  if (!heldButton || heldPhase === 'releasing' || heldPhase === 'unknown') return;
  if (heldPhase === 'pending') { buttonReleaseRequested = true; return; }
  flushPendingMove();
  const button = heldButton;
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++buttonOperationId;
  heldPhase = 'releasing';
  void send({ kind: 'buttonUp', ...cursor, button }).then(sent => {
    if (epoch !== streamEpoch || operation !== buttonOperationId
      || heldButton !== button || heldPhase !== 'releasing') return;
    if (sent) setHeldButton(null);
    else { heldPhase = 'unknown'; unexpectedDisconnect(streamSocket); }
  });
}
function beginHold(button) {
  if (heldButton) return;
  flushPendingMove();
  buttonReleaseRequested = false;
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++buttonOperationId;
  setHeldButton(button, 'pending');
  void send({ kind: 'buttonDown', ...cursor, button }).then(sent => {
    if (epoch !== streamEpoch || operation !== buttonOperationId
      || heldButton !== button || heldPhase !== 'pending') return;
    if (sent) { heldPhase = 'sent'; if (buttonReleaseRequested) releaseButton(); }
    else { heldPhase = 'unknown'; unexpectedDisconnect(streamSocket); }
  });
}
function updateKeyButton(key) {
  for (const button of document.querySelectorAll('[data-remote-key]')) {
    if (button.dataset.remoteKey === key && button.dataset.modifier) {
      button.setAttribute('aria-pressed', String(heldKeys.has(key)));
    }
  }
}
function drainKeyReleases() {
  while (keyReleaseQueue.length) {
    const key = keyReleaseQueue[0];
    if (heldKeys.get(key) === 'pending') return;
    keyReleaseQueue.shift();
    keyReleaseRequested.delete(key);
    if (heldKeys.get(key) === 'sent') void releaseKey(key, true);
  }
}
function beginKey(key) {
  if (!inputEnabled || !remoteKeys.has(key) || heldKeys.has(key)) return Promise.resolve(false);
  heldKeys.set(key, 'pending');
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++nextKeyOperationId;
  keyOperationIds.set(key, operation);
  updateKeyButton(key);
  syncHoldHeartbeat();
  return send({ kind: 'keyDown', key }).then(sent => {
    if (epoch !== streamEpoch || keyOperationIds.get(key) !== operation
      || heldKeys.get(key) !== 'pending') return false;
    if (sent) {
      heldKeys.set(key, 'sent');
      drainKeyReleases();
    }
    else { heldKeys.set(key, 'unknown'); unexpectedDisconnect(streamSocket); }
    return sent;
  });
}
async function tapKey(key) {
  const epoch = streamEpoch;
  if (await beginKey(key) && epoch === streamEpoch) await releaseKey(key);
}
function releaseKey(key, fromQueue = false) {
  const phase = heldKeys.get(key);
  if (!phase || phase === 'releasing' || phase === 'unknown') return Promise.resolve(false);
  if (!fromQueue && (phase === 'pending' || keyReleaseQueue.length)) {
    if (!keyReleaseRequested.has(key)) { keyReleaseRequested.add(key); keyReleaseQueue.push(key); }
    drainKeyReleases();
    return Promise.resolve(false);
  }
  heldKeys.set(key, 'releasing');
  const epoch = streamEpoch;
  const streamSocket = socket;
  const operation = ++nextKeyOperationId;
  keyOperationIds.set(key, operation);
  return send({ kind: 'keyUp', key }).then(sent => {
    if (epoch !== streamEpoch || keyOperationIds.get(key) !== operation
      || heldKeys.get(key) !== 'releasing') return false;
    if (sent) { heldKeys.delete(key); keyOperationIds.delete(key); updateKeyButton(key); syncHoldHeartbeat(); }
    else { heldKeys.set(key, 'unknown'); unexpectedDisconnect(streamSocket); }
    return sent;
  });
}
function releaseControls() {
  releaseButton();
  for (const key of heldKeys.keys()) releaseKey(key);
}

function status(message) { $('status').textContent = message; $('liveStatus').textContent = message; }
const encoder = new TextEncoder();
const bytesToBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64ToBytes = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
function recordIv(direction, sequence) {
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  view.setUint32(0, direction === 'frame' ? 1 : 2);
  view.setBigUint64(4, sequence);
  return iv;
}
function recordAad(direction) {
  return encoder.encode(JSON.stringify(['instar-desktop-aead-v1', requestId, direction]));
}
async function deriveAesKey(targetPublic, salt) {
  const target = await crypto.subtle.importKey('raw', base64ToBytes(targetPublic),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: target }, ecdhKeyPair.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: base64ToBytes(salt),
    info: encoder.encode(`instar-desktop-aead-v1:${requestId}:${machineId}`) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function verifyTarget(result) {
  const expectedVideoCodec = resumeAttempt?.body.videoCodec ?? videoCodec;
  if (result.videoCodec !== expectedVideoCodec) throw new Error('Remote video configuration changed.');
  if (result.machineId !== machineId || !Number.isSafeInteger(result.expiresAt)
    || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 10 * 60_000 + 2000) {
    throw new Error('Remote target identity or lease changed.');
  }
  const publicBytes = base64ToBytes(result.targetSigningPublicKey);
  if (!trustedTargetSigningPublicKey
    || bytesToBase64(publicBytes) !== trustedTargetSigningPublicKey) {
    throw new Error('Remote target key does not match the registered machine.');
  }
  const publicKey = await crypto.subtle.importKey('spki', publicBytes, 'Ed25519', false, ['verify']);
  const payload = encoder.encode(JSON.stringify(['desktop-target-key-v1', requestId, machineId,
    bytesToBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey)),
    bytesToBase64(await crypto.subtle.exportKey('raw', ecdhKeyPair.publicKey)),
    result.targetEcdhPublicKey, result.salt, result.videoCodec,
    videoContract(result.videoCodec), result.connectionNonce, result.expiresAt]));
  const valid = await crypto.subtle.verify('Ed25519', publicKey,
    base64ToBytes(result.targetSignature), payload);
  if (!valid) throw new Error('Remote target signature did not verify.');
}
function sendCommand(command) {
  const epoch = streamEpoch;
  sendChain = sendChain.then(async () => {
    if (epoch !== streamEpoch) return false;
    if (!inputEnabled && command.type === 'input') return false;
    if (socket?.readyState !== WebSocket.OPEN || !aesKey) return false;
    const sequence = ++inputSequence;
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM',
      iv: recordIv('input', sequence), additionalData: recordAad('input') }, aesKey,
    encoder.encode(JSON.stringify(command))));
    const record = new Uint8Array(8 + ciphertext.length);
    new DataView(record.buffer).setBigUint64(0, sequence);
    record.set(ciphertext, 8);
    if (epoch !== streamEpoch || socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(record);
    return true;
  }).catch(() => { if (epoch === streamEpoch) leave('Encrypted remote input failed.'); return false; });
  return sendChain;
}
function resetVideoDecoder() {
  decoderGeneration++;
  if (decoderStartupTimer) { clearTimeout(decoderStartupTimer); decoderStartupTimer = 0; }
  try { decoder?.close(); } catch { /* It may already have failed. */ }
  decoder = null;
  decoderWidth = 0;
  decoderHeight = 0;
  needsVideoKeyframe = true;
  $('videoCanvas').hidden = true;
}
function requestVideoKeyframe() {
  const now = Date.now();
  if (now - lastKeyframeRequestAt < 500) return;
  lastKeyframeRequestAt = now;
  if (inputEnabled) void sendCommand({ type: 'keyframe' });
}
function fallbackVideo(epoch) {
  if (epoch !== streamEpoch || activeVideoCodec !== 'h264') return;
  resetVideoDecoder();
  activeVideoCodec = 'jpeg';
  if (++videoFallbackCount > 1) { leave('Remote video decoder unavailable.'); return; }
  void sendCommand({ type: 'video-fallback' });
  status('Video switched to compatibility mode.');
}
function nalTypes(bytes) {
  const types = new Set();
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      types.add(bytes[i + 4] & 31);
      i += 4;
    }
  }
  return types;
}
function receiveH264(bytes, epoch) {
  if (activeVideoCodec !== 'h264' || bytes.length < 23 || bytes.length > 1_250_018
    || String.fromCharCode(...bytes.subarray(0, 4)) !== 'IDV1' || bytes[4] !== 1
    || (bytes[5] !== 0 && bytes[5] !== 1)) throw new Error('H.264 packet invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6);
  const height = view.getUint16(8);
  if (width < 2 || width > 1920 || width % 2 || height < 2 || height > 1080 || height % 2) {
    throw new Error('H.264 geometry invalid.');
  }
  const data = bytes.subarray(18);
  if (data[0] !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 1) {
    throw new Error('H.264 Annex B invalid.');
  }
  const keyframe = bytes[5] === 1;
  const types = nalTypes(data);
  if (keyframe ? !(types.has(7) && types.has(8) && types.has(5)) : !types.has(1)) {
    throw new Error('H.264 access unit invalid.');
  }
  if (decoder && (decoderWidth !== width || decoderHeight !== height)) resetVideoDecoder();
  if (needsVideoKeyframe && !keyframe) { requestVideoKeyframe(); return; }
  if (!decoder) {
    if (!keyframe) { requestVideoKeyframe(); return; }
    const generation = ++decoderGeneration;
    decoderWidth = width;
    decoderHeight = height;
    decoder = new VideoDecoder({
      output: frame => {
        try {
          if (epoch !== streamEpoch || generation !== decoderGeneration || !inputEnabled) return;
          if (frame.displayWidth !== decoderWidth || frame.displayHeight !== decoderHeight
            || frame.displayWidth > 1920 || frame.displayHeight > 1080) {
            throw new Error('Decoded video geometry invalid.');
          }
          const canvas = $('videoCanvas');
          if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
          if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas unavailable.');
          context.drawImage(frame, 0, 0, canvas.width, canvas.height);
          if (decoderStartupTimer) { clearTimeout(decoderStartupTimer); decoderStartupTimer = 0; }
          canvas.hidden = false;
          $('screen').hidden = true;
          updateCursor();
        } catch { fallbackVideo(epoch); }
        finally { frame.close(); }
      },
      error: () => { if (generation === decoderGeneration) fallbackVideo(epoch); },
    });
    decoder.configure({ codec: H264_CODEC, codedWidth: width, codedHeight: height,
      optimizeForLatency: true });
    decoderStartupTimer = setTimeout(() => {
      if (generation === decoderGeneration && inputEnabled && activeVideoCodec === 'h264') {
        fallbackVideo(epoch);
      }
    }, 2_500);
  }
  if (decoder.decodeQueueSize >= 3) {
    resetVideoDecoder();
    requestVideoKeyframe();
    return;
  }
  const timestamp = Number(view.getBigUint64(10)) * 1000;
  if (!Number.isSafeInteger(timestamp)) throw new Error('H.264 timestamp invalid.');
  decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta',
    timestamp, data }));
  needsVideoKeyframe = false;
}
async function receiveFrame(recordBuffer, epoch) {
  if (!inputEnabled || epoch !== streamEpoch) return;
  if (!aesKey || !(recordBuffer instanceof ArrayBuffer) || recordBuffer.byteLength < 28
    || recordBuffer.byteLength > 1_600_000) throw new Error('Encrypted frame invalid.');
  const record = new Uint8Array(recordBuffer);
  const sequence = new DataView(recordBuffer).getBigUint64(0);
  // The target may drop an already-encrypted frame under backpressure. A
  // strictly increasing nonce still rejects replay/reordering without treating
  // an intentional video drop as a broken session.
  if (sequence <= frameSequence) throw new Error('Remote frame sequence invalid.');
  const frame = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: recordIv('frame', sequence),
    additionalData: recordAad('frame') }, aesKey, record.subarray(8));
  if (!inputEnabled || epoch !== streamEpoch) return;
  frameSequence = sequence;
  const bytes = new Uint8Array(frame);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    try { receiveH264(bytes, epoch); }
    catch { fallbackVideo(epoch); }
    return;
  }
  if (activeVideoCodec === 'h264') {
    resetVideoDecoder();
    activeVideoCodec = 'jpeg';
    status('Video switched to compatibility mode.');
  }
  const old = frameUrl;
  frameUrl = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
  $('screen').src = frameUrl;
  $('screen').hidden = false;
  if (old) URL.revokeObjectURL(old);
}
function clearFrame() {
  resetVideoDecoder();
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = '';
  $('screen').removeAttribute('src');
  $('screen').hidden = false;
}
function leave(message) {
  streamEpoch++;
  inputEnabled = false;
  if (socket) { socket.close(); socket = undefined; }
  if (heartbeat) { clearInterval(heartbeat); heartbeat = 0; }
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  pendingMove = null;
  if (wheelFrame) { cancelAnimationFrame(wheelFrame); wheelFrame = 0; }
  pendingWheel = null;
  pointers.clear();
  setHeldButton(null);
  for (const key of heldKeys.keys()) { heldKeys.delete(key); keyOperationIds.delete(key); updateKeyButton(key); }
  keyReleaseRequested.clear();
  keyReleaseQueue.length = 0;
  pendingKeyTaps.clear();
  syncHoldHeartbeat();
  clearFrame();
  closeKeyboard();
  composingText = false;
  skipCompositionCommitKey = false;
  recentlyCommittedText = '';
  resetZoom();
  resetVisualViewport();
  $('desktopTools').hidden = true;
  $('toolsButton').setAttribute('aria-expanded', 'false');
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  document.body.classList.remove('desktop-live', 'trackpad');
  $('control').hidden = true;
  if (token) $('request').hidden = false;
  status(message);
}
function unexpectedDisconnect(streamSocket) {
  if (socket !== streamSocket || stopping) return;
  leave('Connection interrupted. Checking whether access can resume…');
  if (!token || !operatorSession || !requestId) return;
  // Stop remains reachable while the target decides whether this interruption
  // may resume. The browser cannot create a new grant on its own.
  $('request').hidden = true;
  $('control').hidden = false;
  document.body.classList.add('desktop-live');
  syncVisualViewport();
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    status('Connection interrupted. Stop access, then open the desktop again.');
    return;
  }
  const generation = ++resumeGeneration;
  resumeSetupFailures = 0;
  resumeTransportFailures = 0;
  scheduleResume(generation, 500);
}
function scheduleResume(generation, delay) {
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (!stopping && generation === resumeGeneration) void resumeDesktop(generation);
  }, delay);
}
function abortResumeRequests() {
  for (const controller of resumeControllers) controller.abort();
  resumeControllers.clear();
}
async function resumeApi(path, method = 'GET', body) {
  const controller = new AbortController();
  resumeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 5_000);
  try { return await api(path, method, body, controller.signal); }
  finally { clearTimeout(timer); resumeControllers.delete(controller); }
}
async function resumeDesktop(generation) {
  const current = () => !stopping && generation === resumeGeneration && !!requestId;
  if (!current()) return;
  let activated = false;
  try {
    const state = await resumeApi(`/desktop/requests/${encodeURIComponent(requestId)}`);
    if (!current()) return;
    if (state.status === 'revoked') throw Object.assign(new Error('Desktop access ended. Open it again when needed.'), { terminal: true });
    if (state.status === 'approved') {
      if (resumeAttempt?.generation === generation && state.connectionNonce !== resumeAttempt.body.previousConnectionNonce) {
        resumeAttempt.approved = true;
        activated = true;
        await openStream(state, generation);
        return;
      }
    }
    if (state.status !== 'interrupted' && state.status !== 'approved') throw Object.assign(new Error('Desktop access cannot resume.'), { terminal: true });
    if (resumeAttempt?.approved) resumeAttempt = null;
    if (!resumeAttempt) {
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) throw Object.assign(new Error('Connection interrupted. Open the desktop again.'), { terminal: true });
      reconnectAttempts++;
      const previousKeyPair = keyPair;
      const previousConnectionNonce = connectionNonce;
      if (!previousKeyPair || !previousConnectionNonce || (state.status === 'approved'
        && state.connectionNonce !== previousConnectionNonce)) throw Object.assign(
          new Error('Desktop connection identity changed.'), { terminal: true });
      keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      ecdhKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      if (!current()) return;
      const publicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      const ecdhPublicKey = await crypto.subtle.exportKey('raw', ecdhKeyPair.publicKey);
      const attemptId = crypto.randomUUID().replaceAll('-', '');
      const browserNonce = crypto.randomUUID().replaceAll('-', '');
      const browserPublicKey = bytesToBase64(publicKey);
      const browserEcdhPublicKey = bytesToBase64(ecdhPublicKey);
      const nextVideoCodec = activeVideoCodec;
      const proof = await crypto.subtle.sign('Ed25519', previousKeyPair.privateKey,
        encoder.encode(JSON.stringify(['desktop-resume-v1', requestId, previousConnectionNonce,
          attemptId, browserPublicKey, browserEcdhPublicKey, browserNonce,
          videoCodec, nextVideoCodec])));
      if (!current()) return;
      resumeAttempt = { generation, approved: false, body: {
        attemptId, previousConnectionNonce, previousSignature: bytesToBase64(proof),
        browserPublicKey, browserEcdhPublicKey, browserNonce,
        previousVideoCodec: videoCodec, videoCodec: nextVideoCodec,
      } };
    }
    const resumeBody = resumeAttempt.body;
    let approved;
    for (let retry = 0; retry < 3 && current(); retry++) {
      try {
        approved = await resumeApi(`/desktop/requests/${encodeURIComponent(requestId)}/resume`, 'POST', resumeBody);
        break;
      } catch (error) {
        if (!current()) return;
        if (error.httpStatus === 403) throw error;
        // A lost HTTP response may follow a successful server activation.
        const observed = await resumeApi(`/desktop/requests/${encodeURIComponent(requestId)}`);
        if (observed.status === 'approved' && observed.connectionNonce !== resumeBody.previousConnectionNonce) {
          approved = observed; break;
        }
        if (observed.status !== 'interrupted' && observed.status !== 'approved') throw Object.assign(error, { terminal: true });
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** retry));
      }
    }
    if (!current()) return;
    if (!approved || approved.status !== 'approved') throw new Error('Desktop access could not resume.');
    resumeAttempt.approved = true;
    activated = true;
    await openStream(approved, generation);
  } catch (error) {
    if (!current()) return;
    if (activated && (error.transportFailure || error.transportSetup || error.httpStatus === 403)
      && ++resumeSetupFailures <= 3) {
      scheduleResume(generation, 500 * resumeSetupFailures);
      return;
    }
    // Only a temporary transport read failure may be retried. A target refusal
    // or expired PIN session is terminal for this automatic path.
    if (!activated && !error.httpStatus && !error.terminal && ++resumeTransportFailures <= 3) {
      scheduleResume(generation, 500 * 2 ** (resumeTransportFailures - 1));
      return;
    }
    resumeAttempt = null;
    leave(error.message || 'Desktop access cannot resume.');
  }
}
async function api(path, method = 'GET', body, signal) {
  let response;
  try { response = await fetch(path, {
    method, cache: 'no-store', credentials: 'same-origin',
    ...(signal ? { signal } : {}),
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Instar-Operator-Session': operatorSession,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Instar-Request': '1' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }); } catch (error) {
    if (signal) error.transportFailure = true;
    throw error;
  }
  let result;
  try { result = await response.json(); }
  catch (error) {
    if (signal && (error.name === 'AbortError' || error instanceof TypeError)) {
      error.transportFailure = true;
      throw error;
    }
    if (signal) throw error;
    result = {};
  }
  if (!response.ok) {
    const error = new Error(result.error || `Server answered ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return result;
}

function requirePinAgain() {
  token = '';
  operatorSession = '';
  $('retryButton').hidden = true;
  $('request').hidden = true;
  $('unlock').hidden = false;
  status('Your dashboard session ended. Enter your PIN again.');
}

async function loadTargetsAndMaybeOpen() {
  const targets = await api('/desktop/targets');
  const machines = targets.machines || [];
  $('machine').replaceChildren();
  trustedTargetKeys.clear();
  for (const target of machines) {
    const option = document.createElement('option');
    option.value = target.machineId;
    const trustedKey = typeof target.targetSigningPublicKey === 'string'
      ? target.targetSigningPublicKey : '';
    option.disabled = !target.ready || !trustedKey;
    option.textContent = option.disabled
      ? `${target.label} — ${target.unavailableReason || 'Unavailable right now'}`
      : target.label;
    if (!option.disabled) trustedTargetKeys.set(target.machineId, trustedKey);
    $('machine').append(option);
  }
  const preferredMachine = new URLSearchParams(location.search).get('machineId');
  const preferredTarget = preferredMachine
    ? machines.find(target => target.machineId === preferredMachine) : null;
  const hasPreferredMachine = !!preferredTarget?.ready && trustedTargetKeys.has(preferredMachine);
  if (hasPreferredMachine) $('machine').value = preferredMachine;
  $('unlock').hidden = true;
  const ready = [...$('machine').options].filter(option => !option.disabled);
  $('requestButton').disabled = ready.length === 0;
  if (!preferredMachine && ready.length > 0) $('machine').value = ready[0].value;
  if (preferredMachine && !hasPreferredMachine) {
    $('request').hidden = machines.length === 0;
    $('retryButton').hidden = false;
    status(preferredTarget?.unavailableReason || 'The requested machine is not available right now.');
    return;
  }
  if (ready.length === 0) {
    $('request').hidden = machines.length === 0;
    $('retryButton').hidden = false;
    const reason = machines.find(target => target.unavailableReason)?.unavailableReason;
    status(reason || 'This machine’s desktop is not available right now.');
    return;
  }
  $('retryButton').hidden = true;
  if (hasPreferredMachine || (machines.length === 1 && ready.length === 1)) {
    if (!hasPreferredMachine) $('machine').value = ready[0].value;
    status(`Opening ${$('machine').selectedOptions[0].textContent}…`);
    await requestDesktop();
  } else {
    $('request').hidden = false;
    status('Choose a machine to open.');
  }
}

$('unlockButton').addEventListener('click', async () => {
  $('unlockButton').disabled = true;
  try {
    const response = await fetch('/dashboard/unlock', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: $('pin').value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.token || !result.operatorSessionToken) {
      throw new Error(result.error || 'Dashboard PIN was not accepted.');
    }
    token = result.token;
    operatorSession = result.operatorSessionToken;
    $('pin').value = '';
    await loadTargetsAndMaybeOpen();
  } catch (error) {
    if (/dashboard operator session|dashboard PIN session/i.test(error.message || '')) requirePinAgain();
    else status(error.message || 'Could not unlock.');
  }
  finally { $('unlockButton').disabled = false; }
});

$('retryButton').addEventListener('click', async () => {
  $('retryButton').disabled = true;
  try { await loadTargetsAndMaybeOpen(); }
  catch (error) {
    if (/dashboard operator session|dashboard PIN session/i.test(error.message || '')) requirePinAgain();
    else status(error.message || 'Could not check this machine.');
  } finally { $('retryButton').disabled = false; }
});

async function requestDesktop() {
  reconnectAttempts = 0;
  resumeTransportFailures = 0;
  stopping = false;
  resumeGeneration++;
  resumeAttempt = null;
  abortResumeRequests();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  $('requestButton').disabled = true;
  const previousRequestId = requestId;
  requestId = '';
  try {
    if (previousRequestId) {
      // A lost WebSocket can remain half-open at the target. Revoke it before
      // seeking a fresh grant; the target's controller lock also fences overlap.
      try { await api(`/desktop/requests/${encodeURIComponent(previousRequestId)}/revoke`, 'POST', {}); }
      catch { /* A stale or unreachable grant is still fenced by the controller lock. */ }
    }
    keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    ecdhKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const ecdhPublicKey = await crypto.subtle.exportKey('raw', ecdhKeyPair.publicKey);
    machineId = $('machine').value;
    trustedTargetSigningPublicKey = trustedTargetKeys.get(machineId) || '';
    if (!trustedTargetSigningPublicKey) throw new Error('Target identity is not verified.');
    videoCodec = 'jpeg';
    if (window.VideoDecoder?.isConfigSupported) {
      try {
        if ((await VideoDecoder.isConfigSupported(H264_CONFIG)).supported) videoCodec = 'h264';
      } catch { /* JPEG remains available. */ }
    }
    activeVideoCodec = videoCodec;
    const result = await api('/desktop/requests', 'POST', {
      machineId,
      browserPublicKey: bytesToBase64(publicKey),
      browserEcdhPublicKey: bytesToBase64(ecdhPublicKey),
      browserNonce: crypto.randomUUID().replaceAll('-', ''),
      videoCodec,
    });
    requestId = result.requestId;
    const approved = await api(`/desktop/requests/${encodeURIComponent(requestId)}`);
    if (approved.status !== 'approved') throw new Error('Desktop access was not granted.');
    try {
      const point = await api(`/desktop/requests/${encodeURIComponent(requestId)}/cursor`);
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) cursor = point;
    } catch { /* A missing cursor readback cannot grant input or bypass host checks. */ }
    await openStream(approved);
  } catch (error) {
    if (requestId) {
      try { await api(`/desktop/requests/${encodeURIComponent(requestId)}/revoke`, 'POST', {}); }
      catch { /* The lease and idle limit still fence access if the revoke request fails. */ }
      requestId = '';
    }
    const message = error.message || 'Could not open desktop.';
    if (/dashboard operator session|dashboard PIN session/i.test(message)) {
      requirePinAgain();
    } else {
      $('request').hidden = false;
      status(message);
    }
  }
  finally { $('requestButton').disabled = false; }
}
$('requestButton').addEventListener('click', requestDesktop);

async function openStream(result, resume = null) {
  await verifyTarget(result);
  if (stopping || (resume !== null && resume !== resumeGeneration)) return;
  videoCodec = result.videoCodec;
  activeVideoCodec = videoCodec;
  videoFallbackCount = 0;
  resetVideoDecoder();
  // Keep the verified key and grant generation together even if the WebSocket
  // upgrade never reaches its open event. A later target interruption must be
  // signed by this generation, not by the already-replaced predecessor.
  connectionNonce = result.connectionNonce;
  aesKey = await deriveAesKey(result.targetEcdhPublicKey, result.salt);
  if (stopping || (resume !== null && resume !== resumeGeneration)) return;
  inputSequence = 0n;
  frameSequence = 0n;
  const payload = new TextEncoder().encode(JSON.stringify(['desktop-browser-possession-v1', requestId, result.connectionNonce]));
  const proof = await crypto.subtle.sign('Ed25519', keyPair.privateKey, payload);
  const ticket = await (resume === null ? api : resumeApi)(`/desktop/requests/${encodeURIComponent(requestId)}/ticket`, 'POST', {
    connectionNonce: result.connectionNonce,
    signature: bytesToBase64(proof),
  });
  if (stopping || (resume !== null && resume !== resumeGeneration)) return;
  if (ticket.machineId !== machineId || typeof ticket.ticket !== 'string') throw new Error('Target identity changed.');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}/desktop-stream`,
    ['instar-desktop-v1', `ticket.${ticket.ticket}`]);
  const streamSocket = socket;
  const epoch = ++streamEpoch;
  sendChain = Promise.resolve();
  receiveChain = Promise.resolve();
  socket.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
  let opened = false;
  let settled = false;
  const failSetup = () => {
    if (settled || opened) return;
    settled = true;
    clearTimeout(setupTimer);
    reject(Object.assign(new Error('Remote desktop connection could not open.'), { transportSetup: true }));
  };
  const setupTimer = setTimeout(() => {
    if (!opened) { try { streamSocket.close(); } catch { /* close may already be in flight */ } }
    failSetup();
  }, 5_000);
  socket.addEventListener('open', () => {
    if (socket !== streamSocket || stopping || (resume !== null && resume !== resumeGeneration)) {
      streamSocket.close(); failSetup(); return;
    }
    opened = true;
    settled = true;
    clearTimeout(setupTimer);
    inputEnabled = true;
    $('request').hidden = true;
    $('control').hidden = false;
    document.body.classList.add('desktop-live');
    syncVisualViewport();
    document.body.classList.toggle('trackpad', trackpad);
    syncTouchModeButton();
    updateCursor();
    $('machineName').textContent = ticket.label;
    status('Remote desktop is live.');
    if (resume !== null) resumeAttempt = null;
    resumeTransportFailures = 0;
    heartbeat = setInterval(() => {
      sendCommand({ type: 'ping' });
    }, 30_000);
    resolve();
  });
  socket.addEventListener('message', event => {
    if (socket !== streamSocket || epoch !== streamEpoch) return;
    receiveChain = receiveChain.then(() => receiveFrame(event.data, epoch))
      .catch(() => { if (socket === streamSocket && epoch === streamEpoch) leave('Encrypted remote display failed.'); });
  });
  socket.addEventListener('close', () => {
    if (!opened) { failSetup(); return; }
    unexpectedDisconnect(streamSocket);
  });
  socket.addEventListener('error', () => {
    if (!opened) { failSetup(); return; }
    unexpectedDisconnect(streamSocket);
  });
  });
}

function send(action) {
  if (!inputEnabled) return Promise.resolve(false);
  return sendCommand({ type: 'input', action });
}
function imageArea() {
  const source = $('videoCanvas').hidden ? $('screen') : $('videoCanvas');
  const rect = source.getBoundingClientRect();
  const sourceWidth = source === $('screen') ? source.naturalWidth : source.width;
  const sourceHeight = source === $('screen') ? source.naturalHeight : source.height;
  if (!sourceWidth || !sourceHeight || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return { left, top, width, height };
}
function clamp(value) { return Math.min(1, Math.max(0, value)); }
function position(event) {
  const area = imageArea();
  return area ? { x: clamp((event.clientX - area.left) / area.width),
    y: clamp((event.clientY - area.top) / area.height) } : null;
}
function updateCursor() {
  const area = imageArea();
  if (!area) return;
  const rect = $('viewTransform').getBoundingClientRect();
  $('localCursor').style.left = `${(area.left - rect.left + cursor.x * area.width) / zoom}px`;
  $('localCursor').style.top = `${(area.top - rect.top + cursor.y * area.height) / zoom}px`;
}
function queueMove(at) {
  pendingMove = at;
  if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
}
function flushMove(time) {
  if (time - lastMoveAt < 33) { moveFrame = requestAnimationFrame(flushMove); return; }
  moveFrame = 0;
  lastMoveAt = time;
  if (pendingMove) { send({ kind: 'move', ...pendingMove }); pendingMove = null; }
}
function moveCursor(dx, dy) {
  const area = imageArea();
  if (!area) return;
  cursor = { x: clamp(cursor.x + dx * 1.3 / area.width),
    y: clamp(cursor.y + dy * 1.3 / area.height) };
  updateCursor();
  queueMove(cursor);
}
function clickCursor(button = 'left') { if (!heldButton) send({ kind: 'click', ...cursor, button }); }
function syncTouchModeButton() {
  $('modeButton').hidden = !touchCapable;
  $('modeButton').textContent = trackpad ? 'Trackpad · swipe to move' : 'Direct · touch position';
  $('modeButton').setAttribute('aria-pressed', String(trackpad));
  $('modeButton').setAttribute('aria-label', trackpad
    ? 'Touch mode: Trackpad. Swipe to move the pointer; tap to click.'
    : 'Touch mode: Direct. The pointer follows your finger; tap to click.');
}
function flushWheel() {
  wheelFrame = 0;
  if (!pendingWheel) return;
  const { dx, dy } = pendingWheel;
  pendingWheel = null;
  if (inputEnabled && (dx || dy)) void send({ kind: 'scroll',
    dx: Math.max(-200, Math.min(200, dx)), dy: Math.max(-200, Math.min(200, dy)) });
}
function syncVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport || !document.body.classList.contains('desktop-live')) return;
  const control = $('control');
  control.style.setProperty('--desktop-visible-top', `${Math.max(0, viewport.offsetTop)}px`);
  control.style.setProperty('--desktop-visible-left', `${Math.max(0, viewport.offsetLeft)}px`);
  control.style.setProperty('--desktop-visible-width', `${Math.max(1, viewport.width)}px`);
  control.style.setProperty('--desktop-visible-height', `${Math.max(1, viewport.height)}px`);
  applyZoom();
}
function resetVisualViewport() {
  for (const name of ['--desktop-visible-top', '--desktop-visible-left',
    '--desktop-visible-width', '--desktop-visible-height']) $('control').style.removeProperty(name);
}
function applyZoom() {
  const rect = $('surface').getBoundingClientRect();
  panX = Math.max(-(zoom - 1) * rect.width / 2, Math.min((zoom - 1) * rect.width / 2, panX));
  panY = Math.max(-(zoom - 1) * rect.height / 2, Math.min((zoom - 1) * rect.height / 2, panY));
  $('viewTransform').style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  $('zoomResetButton').hidden = zoom <= 1.01;
  updateCursor();
}
function resetZoom() { zoom = 1; panX = 0; panY = 0; twoFinger = null; applyZoom(); }
function pairMetrics() {
  const [a, b] = [...pointers.values()];
  return { distance: Math.hypot(a.x - b.x, a.y - b.y),
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    bothMoved: Math.hypot(a.x - a.startX, a.y - a.startY) > 3 &&
      Math.hypot(b.x - b.startX, b.y - b.startY) > 3 };
}
function moveTwoFingers() {
  if (!twoFinger || pointers.size !== 2) return;
  const now = pairMetrics();
  const scaleChange = Math.abs(now.distance - twoFinger.distance);
  const travel = Math.hypot(now.x - twoFinger.x, now.y - twoFinger.y);
  if (twoFinger.mode === 'pending' && (now.bothMoved || (scaleChange > 24 && scaleChange > travel * 1.4))) {
    twoFinger.mode = zoom > 1.01 || scaleChange > Math.max(8, travel * .45) ? 'zoom' : 'scroll';
  }
  if (twoFinger.mode === 'zoom') {
    const nextZoom = Math.max(1, Math.min(4, twoFinger.zoom * now.distance / Math.max(1, twoFinger.distance)));
    const rect = $('surface').getBoundingClientRect();
    const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
    panX = now.x - centerX - (nextZoom / twoFinger.zoom) * (twoFinger.x - centerX - twoFinger.panX);
    panY = now.y - centerY - (nextZoom / twoFinger.zoom) * (twoFinger.y - centerY - twoFinger.panY);
    zoom = nextZoom;
    applyZoom();
  } else if (twoFinger.mode === 'scroll') {
    const dx = now.x - twoFinger.lastX, dy = now.y - twoFinger.lastY;
    if (dx || dy) send({ kind: 'scroll', dx: Math.max(-200, Math.min(200, dx * 1.5)),
      dy: Math.max(-200, Math.min(200, dy * 1.5)) });
  }
  twoFinger.lastX = now.x; twoFinger.lastY = now.y;
}
function closeKeyboard() {
  $('typeText').blur();
  $('keyboardBar').hidden = true;
  $('keyboardButton').setAttribute('aria-expanded', 'false');
  syncVisualViewport();
}
$('toolsButton').addEventListener('click', () => {
  const open = $('desktopTools').hidden;
  $('desktopTools').hidden = !open;
  $('toolsButton').setAttribute('aria-expanded', String(open));
});
$('keyboardButton').addEventListener('click', () => {
  if (!$('keyboardBar').hidden) { closeKeyboard(); return; }
  $('desktopTools').hidden = true;
  $('toolsButton').setAttribute('aria-expanded', 'false');
  $('keyboardBar').hidden = false;
  $('keyboardButton').setAttribute('aria-expanded', 'true');
  $('typeText').focus(); // Must happen in the trusted tap for the iOS keyboard.
  syncVisualViewport();
});
$('hideKeyboardButton').addEventListener('click', closeKeyboard);
$('zoomResetButton').addEventListener('click', resetZoom);
$('fullscreenButton').hidden = !document.fullscreenEnabled || !$('control').requestFullscreen;
$('fullscreenButton').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else if ($('control').requestFullscreen) void $('control').requestFullscreen().catch(() => {});
});
$('modeButton').addEventListener('click', () => {
  releaseButton();
  trackpad = !trackpad;
  pointers.clear();
  document.body.classList.toggle('trackpad', trackpad);
  syncTouchModeButton();
});
$('dragButton').addEventListener('click', () => {
  if (heldButton) { releaseButton(); return; }
  beginHold('left');
});
$('rightButton').addEventListener('click', () => clickCursor('right'));
for (const button of document.querySelectorAll('[data-remote-key]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.remoteKey;
    if (button.dataset.modifier) {
      if (heldKeys.has(key)) {
        const epoch = streamEpoch;
        void Promise.all([...pendingKeyTaps]).then(() => {
          if (epoch === streamEpoch) return releaseKey(key);
        });
      }
      else beginKey(key);
    } else {
      const tap = tapKey(key);
      pendingKeyTaps.add(tap);
      void tap.finally(() => pendingKeyTaps.delete(tap));
    }
  });
}
function eventKey(event) {
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return remoteKeys.has(key) ? key : null;
}
document.addEventListener('keydown', event => {
  if (!inputEnabled || event.target instanceof HTMLInputElement) return;
  const key = eventKey(event);
  if (!key) return;
  event.preventDefault();
  if (!event.repeat) beginKey(key);
});
document.addEventListener('keyup', event => {
  if (!inputEnabled || event.target instanceof HTMLInputElement) return;
  const key = eventKey(event);
  if (!key) return;
  event.preventDefault();
  releaseKey(key);
});
$('surface').addEventListener('contextmenu', event => event.preventDefault());
$('surface').addEventListener('wheel', event => {
  if (!inputEnabled || event.ctrlKey) return;
  event.preventDefault();
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2
    ? Math.max(1, $('surface').clientHeight) : 1;
  if (!pendingWheel) pendingWheel = { dx: 0, dy: 0 };
  pendingWheel.dx += event.deltaX * scale;
  pendingWheel.dy += event.deltaY * scale;
  if (!wheelFrame) wheelFrame = requestAnimationFrame(flushWheel);
}, { passive: false });
$('surface').addEventListener('pointerdown', event => {
  event.preventDefault();
  if (event.pointerType === 'touch' && !touchCapable) { touchCapable = true; syncTouchModeButton(); }
  $('surface').setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY,
    startX: event.clientX, startY: event.clientY, maxDistance: 0,
    at: Date.now(), multi: pointers.size > 0 });
  if (pointers.size > 1) for (const state of pointers.values()) state.multi = true;
  if (pointers.size === 2 && event.pointerType !== 'mouse') {
    const pair = pairMetrics();
    twoFinger = { ...pair, zoom, panX, panY, lastX: pair.x, lastY: pair.y, mode: 'pending' };
  }
  if (!trackpad || event.pointerType === 'mouse') {
    const at = position(event);
    if (at) { cursor = at; updateCursor(); queueMove(at); }
    if (event.pointerType === 'mouse' && at && !heldButton) beginHold(event.button === 2 ? 'right' : 'left');
  }
});
$('surface').addEventListener('pointermove', event => {
  const state = pointers.get(event.pointerId);
  if (!state) {
    if (event.pointerType === 'mouse') { const at = position(event); if (at) { cursor = at; updateCursor(); queueMove(at); } }
    return;
  }
  event.preventDefault();
  const dx = event.clientX - state.x, dy = event.clientY - state.y;
  state.x = event.clientX; state.y = event.clientY;
  state.maxDistance = Math.max(state.maxDistance,
    Math.hypot(event.clientX - state.startX, event.clientY - state.startY));
  if (pointers.size > 1 && event.pointerType !== 'mouse') {
    moveTwoFingers();
  } else if (state.multi && event.pointerType !== 'mouse') {
    // Do not turn the trailing finger of a scroll gesture into pointer motion.
  } else if (trackpad && event.pointerType !== 'mouse') moveCursor(dx, dy);
  else { const at = position(event); if (at) { cursor = at; queueMove(at); } }
});
$('surface').addEventListener('pointerup', event => {
  const state = pointers.get(event.pointerId);
  if (!state) return;
  event.preventDefault();
  pointers.delete(event.pointerId);
  if (pointers.size < 2) twoFinger = null;
  if (event.pointerType === 'mouse' && heldButton) {
    const at = position(event);
    if (at) { cursor = at; queueMove(at); }
    releaseButton();
    return;
  }
  const distance = Math.max(state.maxDistance,
    Math.hypot(event.clientX - state.startX, event.clientY - state.startY));
  if (!state.multi && distance < 10 && Date.now() - state.at < 500) {
    if (!trackpad || event.pointerType === 'mouse') { const at = position(event); if (at) cursor = at; }
    clickCursor(event.button === 2 ? 'right' : 'left');
  }
});
function cancelGestures() { pointers.clear(); twoFinger = null; releaseControls(); }
$('surface').addEventListener('pointercancel', cancelGestures);
window.addEventListener('blur', cancelGestures);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGestures(); });
window.addEventListener('resize', () => { syncVisualViewport(); applyZoom(); updateCursor(); });
window.visualViewport?.addEventListener('resize', syncVisualViewport);
window.visualViewport?.addEventListener('scroll', syncVisualViewport);
$('screen').addEventListener('load', updateCursor);
$('typeText').addEventListener('focus', () => { releaseControls(); syncVisualViewport(); });
$('typeText').addEventListener('compositionstart', () => { composingText = true; });
$('typeText').addEventListener('keydown', event => {
  if (composingText || event.isComposing || event.keyCode === 229) return;
  if (skipCompositionCommitKey && (event.key === 'Enter' || event.key === 'Backspace')) {
    event.preventDefault();
    skipCompositionCommitKey = false;
    return;
  }
  if (event.key === 'Enter' || event.key === 'Backspace') {
    event.preventDefault();
    void tapKey(event.key);
  }
});
$('typeText').addEventListener('input', event => {
  if (composingText || event.isComposing) return;
  const text = $('typeText').value;
  if (recentlyCommittedText && text === recentlyCommittedText) {
    $('typeText').value = '';
    recentlyCommittedText = '';
    return;
  }
  if (!text) {
    if (event.inputType === 'deleteContentBackward') void tapKey('Backspace');
    return;
  }
  $('typeText').value = '';
  for (let i = 0; i < text.length; i += 64) void send({ kind: 'type', text: text.slice(i, i + 64) });
});
$('typeText').addEventListener('compositionend', () => {
  composingText = false;
  skipCompositionCommitKey = true;
  setTimeout(() => { skipCompositionCommitKey = false; recentlyCommittedText = ''; }, 0);
  const text = $('typeText').value;
  $('typeText').value = '';
  recentlyCommittedText = text;
  if (text) void send({ kind: 'type', text });
});
$('stopButton').addEventListener('click', async () => {
  stopping = true;
  resumeGeneration++;
  resumeAttempt = null;
  abortResumeRequests();
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  inputEnabled = false;
  if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
  pendingMove = null;
  if (wheelFrame) { cancelAnimationFrame(wheelFrame); wheelFrame = 0; }
  pendingWheel = null;
  pointers.clear();
  setHeldButton(null);
  for (const key of heldKeys.keys()) { heldKeys.delete(key); keyOperationIds.delete(key); updateKeyButton(key); }
  keyReleaseRequested.clear();
  keyReleaseQueue.length = 0;
  pendingKeyTaps.clear();
  syncHoldHeartbeat();
  sendCommand({ type: 'stop' });
  const stoppingRequestId = requestId;
  // Blank the viewer immediately, even when the revoke HTTP request is slow.
  // Input was disabled above; late video frames are ignored by receiveFrame.
  clearFrame();
  $('control').hidden = true;
  status('Stopping remote desktop…');
  let message = 'Remote desktop stopped.';
  try { await api(`/desktop/requests/${encodeURIComponent(stoppingRequestId)}/revoke`, 'POST', {}); }
  catch { message = 'The viewer closed, but the target has not confirmed revocation. Access expires automatically.'; }
  leave(message);
});
window.addEventListener('beforeunload', () => {
  stopping = true;
  sendCommand({ type: 'stop' });
  clearFrame();
});
