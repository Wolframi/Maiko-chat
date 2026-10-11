"use client";

export type SignalQuality = "excellent" | "good" | "ok" | "poor" | "lost" | "unknown";

export function ConnectionSignal({ quality = "unknown", pending, rttMs }: {
  quality?: SignalQuality;
  pending?: string | null;
  rttMs?: number;
}) {
  const level = pending ? "unknown" : quality;
  const labels: Record<SignalQuality, string> = {
    excellent: "Отличная связь", good: "Хорошая связь", ok: "Средняя связь",
    poor: "Слабая связь", lost: "Связь потеряна", unknown: "Проверяем качество связи…",
  };
  const label = pending || labels[level];
  const bars = level === "excellent" || level === "good" ? 3 : level === "ok" ? 2 : level === "poor" ? 1 : 0;
  return (
    <span className={`connection-signal connection-signal--${level}`} title={label} role="status" aria-label={label}>
      <span className="connection-signal__bars" aria-hidden="true">
        {[1, 2, 3].map((bar) => <i key={bar} className={bar <= bars ? "is-lit" : ""} />)}
      </span>
      <span>{label}{!pending && rttMs != null ? ` · ${rttMs} мс` : ""}</span>
    </span>
  );
}
