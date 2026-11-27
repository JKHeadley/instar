/**
 * The one answer every "files are off" refusal gives (media-off), with the way to act on it.
 *
 * Every warning carries a direct path to act: the owner's phone turns files on for the whole agent
 * with one Face ID tap through the existing team switch route (POST /mobile/team/switches/turn-on
 * {setting: 'files'}), which sets `mobilePairing.native.media.enabled` on every machine and restarts
 * each one that changed. A phone that is not the owner's is refused there with words of its own.
 */
export const MEDIA_OFF_DETAIL = 'Files in app conversations are turned off on this agent.';

export const MEDIA_OFF_ACTION = Object.freeze({
  kind: 'team-switch-on',
  setting: 'files',
  label: 'Turn on files',
  method: 'POST',
  path: '/mobile/team/switches/turn-on',
  configPath: 'mobilePairing.native.media.enabled',
});

export function mediaOffBody(detail: string = MEDIA_OFF_DETAIL): { error: 'media-off'; detail: string; action: typeof MEDIA_OFF_ACTION } {
  return { error: 'media-off', detail, action: MEDIA_OFF_ACTION };
}
