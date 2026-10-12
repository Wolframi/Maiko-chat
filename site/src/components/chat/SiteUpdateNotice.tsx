"use client";

import { useSyncExternalStore } from "react";
import { getSiteUpdateNotice, requestPendingSiteReload, subscribeSiteUpdateNotice } from "@/lib/liveReload";

const serverSnapshot = () => null;
export function SiteUpdateNotice() {
  const notice = useSyncExternalStore(subscribeSiteUpdateNotice, getSiteUpdateNotice, serverSnapshot);
  if (!notice) return null;
  return <aside className="site-update-notice" role="status" aria-label="Обновление сайта">
    <div>
      <strong>Сайт обновился — обновите сайт</strong>
      <p>{notice.error || "При перезагрузке демонстрация остановится. Можно обновить после её завершения."}</p>
    </div>
    <button type="button" onClick={requestPendingSiteReload} disabled={notice.busy}>
      {notice.busy ? "Обновляем…" : "Обновить сайт"}
    </button>
  </aside>;
}
