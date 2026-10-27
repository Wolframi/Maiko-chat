export const AUTO_RINGTONE_SECONDS = 30;
export const RINGTONE_CACHE_VERSION = 4;
export const RINGTONE_ANALYSIS_RATE = 11025;

export function ringtoneAudioPath(remote: string) {
  return `/api/ringtones/audio?u=${encodeURIComponent(remote)}&v=${RINGTONE_CACHE_VERSION}`;
}
