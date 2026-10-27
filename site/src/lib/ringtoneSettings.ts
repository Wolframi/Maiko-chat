export type SavedRingtone = {
  id: string;
  title: string;
  url: string;
  startSec?: number;
  source?: { url: string; name: string; startSec: number; endSec: number };
};

export type RingtoneSettings = {
  initialized: boolean;
  ringtone: SavedRingtone | null;
  custom: SavedRingtone | null;
};
