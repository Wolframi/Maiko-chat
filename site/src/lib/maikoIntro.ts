export type MaikoIntro = "hiphop" | "samba";
export const maikoIntroDuration = { hiphop: 8150, samba: 8150 } as const;
// Keep the model's own particle assembly, after preparation has completed.
export const MAIKO_INTRO_START_SECONDS = 0;
export const chooseMaikoIntro = (random: number): MaikoIntro => random < 0.5 ? "hiphop" : "samba";
export const MAIKO_MODEL_VERSION = "bind-axes-1-gzip-1";
export const maikoIntroAsset = (intro: MaikoIntro) => `/models/maiko-${intro}.bin.gz?v=${MAIKO_MODEL_VERSION}`;
