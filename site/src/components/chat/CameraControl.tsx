"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCamera, IconCameraOff, IconChevronDown } from "@/lib/icons";
import { listCameraDevices, type CameraDeviceOption } from "@/lib/mediaDevices";

type CameraControlProps = {
  cameraOff: boolean;
  mediaBusy?: boolean;
  cameraDeviceId?: string;
  localStream: MediaStream | null;
  onToggleCamera: () => void;
  onSelectCamera?: (deviceId: string) => void;
};

export function CameraControl({
  cameraOff,
  mediaBusy = false,
  cameraDeviceId = "",
  localStream,
  onToggleCamera,
  onSelectCamera,
}: CameraControlProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const [devices, setDevices] = useState<CameraDeviceOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listCameraDevices().then(next => { if (!cancelled) setDevices(next); }).catch(() => undefined);
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, [localStream]);

  useEffect(() => {
    if (!position) return;
    select.current?.focus();
    const close = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPosition(null);
        trigger.current?.focus();
      }
    };
    const hide = () => setPosition(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", hide);
    };
  }, [position, loading]);

  async function open() {
    if (position) { setPosition(null); return; }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(12, Math.min(rect.right - 280, window.innerWidth - 292)), bottom: window.innerHeight - rect.top + 8 });
    setLoading(true);
    try { setDevices(await listCameraDevices(true)); }
    catch { setDevices([]); }
    finally { setLoading(false); }
  }

  return (
    <div className="call__camera-control">
      <button
        type="button"
        className={`call__btn call__btn--circle ${cameraOff ? "is-off" : ""}`}
        onClick={onToggleCamera}
        disabled={mediaBusy}
        aria-label={cameraOff ? "Включить камеру" : "Выключить камеру"}
        title={cameraOff ? "Камера выкл." : "Камера"}
      >
        {cameraOff ? <IconCameraOff size={20} /> : <IconCamera size={20} />}
      </button>
      {onSelectCamera && (
        <button ref={trigger} type="button" className="call__camera-select" onClick={() => void open()}
          disabled={mediaBusy} aria-label="Выбрать камеру" title="Выбрать камеру" aria-haspopup="dialog"
          aria-expanded={Boolean(position)} aria-controls={position ? id : undefined}>
          <IconChevronDown size={14} />
        </button>
      )}
      {position && createPortal(
        <div ref={popup} id={id} className="call__camera-menu" role="dialog" aria-label="Настройки камеры" style={position}>
          <label htmlFor={`${id}-device`}>Камера</label>
          <select ref={select} id={`${id}-device`} aria-label="Камера" value={cameraDeviceId} disabled={mediaBusy || loading}
            onChange={event => { onSelectCamera?.(event.target.value); setPosition(null); trigger.current?.focus(); }}>
            <option value="">По умолчанию</option>
            {cameraDeviceId && !devices.some(device => device.deviceId === cameraDeviceId) && (
              <option value={cameraDeviceId} disabled>Выбранная камера недоступна</option>
            )}
            {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
          {loading ? <small role="status">Поиск камер…</small> : !devices.length ? <small role="status">Камеры не найдены или доступ запрещён</small> : null}
        </div>, document.body,
      )}
    </div>
  );
}
