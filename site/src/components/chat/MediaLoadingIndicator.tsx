"use client";

import type { MediaDownload } from "@/lib/mediaDownload";

export function MediaLoadingIndicator({ sticker = false, progress }: { sticker?: boolean; progress?: MediaDownload }) {
  const total = progress?.total;
  const percent = total ? Math.min(100, Math.floor((progress?.received || 0) / total * 100)) : undefined;
  const received = progress?.received || 0;
  const bytes = received < 1024 ? `${received} Б` : received < 1024 * 1024 ? `${Math.round(received / 1024)} КБ` : `${(received / (1024 * 1024)).toFixed(1)} МБ`;
  const text = percent !== undefined ? `${percent}%` : received ? bytes : "…";
  return <span className={`media-loading${sticker ? " media-loading--sticker" : ""}`}
    role="progressbar" aria-label={sticker ? "Загрузка стикера" : "Загрузка медиа"}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={text}>
    {sticker ? <span className="media-loading__sticker" aria-hidden="true" /> : null}
    <span className={`media-loading__ring${total ? "" : " media-loading__ring--indeterminate"}`} aria-hidden="true">
      <svg viewBox="0 0 44 44" fill="none">
        <circle cx="22" cy="22" r="17" stroke="currentColor" strokeWidth="3" opacity=".25" />
        <circle className="media-loading__arc" cx="22" cy="22" r="17" stroke="currentColor"
          strokeWidth="3" strokeLinecap="round" pathLength="100" strokeDasharray="100"
          strokeDashoffset={100 - (percent ?? 25)} />
      </svg>
    </span>
  </span>;
}
