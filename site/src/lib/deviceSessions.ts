export type DeviceSession = {
  id: string;
  current: boolean;
  device: "desktop" | "mobile" | "tablet" | "unknown";
  browser: string;
  os: string;
  ip: string | null;
  location: string | null;
  issuedAt: number;
  lastSeenAt: number;
};

export type DeviceSessionsResult =
  | { ok: true; sessions: DeviceSession[] }
  | { ok: false; error: string };
