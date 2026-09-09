"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  canSelectAudioOutput,
  getMicDeviceId,
  getSpeakerDeviceId,
  listAudioDevices,
  playSpeakerTest,
  setMicDeviceId,
  setSpeakerDeviceId,
  subscribeVoiceSettings,
  type AudioDeviceOption,
} from "@/lib/mediaDevices";
import { getKrispEnabled, setKrispEnabled } from "@/lib/noiseFilter";
import { IconHeadphones, IconMic, IconNoise, IconVolume } from "@/lib/icons";

function meterCaptureConstraints(deviceId: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: { ideal: 1 },
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

export function VoiceSettings() {
  const [mics, setMics] = useState<AudioDeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<AudioDeviceOption[]>([]);
  const [micId, setMicId] = useState(getMicDeviceId);
  const [speakerId, setSpeakerId] = useState(getSpeakerDeviceId);
  const [krispOn, setKrispOn] = useState(getKrispEnabled);
  const [permError, setPermError] = useState<string | null>(null);
  const [testingOut, setTestingOut] = useState(false);
  const [outputSupported] = useState(canSelectAudioOutput);
  const fillRef = useRef<HTMLSpanElement>(null);
  const meterGenRef = useRef(0);
  const meterRef = useRef<{
    stream: MediaStream | null;
    ctx: AudioContext | null;
    raf: number;
  }>({ stream: null, ctx: null, raf: 0 });

  const paintMeter = useCallback((value: number) => {
    const fill = fillRef.current;
    if (!fill) return;
    const pct = Math.max(0, Math.min(100, value * 100));
    fill.style.width = `${pct}%`;
    fill.classList.toggle("is-hot", pct >= 70);
  }, []);

  const stopMeter = useCallback(() => {
    meterGenRef.current += 1;
    const state = meterRef.current;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    if (state.ctx) {
      void state.ctx.close().catch(() => undefined);
      state.ctx = null;
    }
    paintMeter(0);
  }, [paintMeter]);

  const loadDevices = useCallback(async () => {
    try {
      const next = await listAudioDevices();
      setMics(next.mics);
      setSpeakers(next.speakers);
      setPermError(null);
    } catch (err) {
      setPermError(
        err instanceof Error ? err.message : "Нет доступа к микрофону",
      );
    }
  }, []);

  const startMeter = useCallback(
    async (deviceId: string) => {
      stopMeter();
      const gen = meterGenRef.current;
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: meterCaptureConstraints(deviceId),
          video: false,
        });
        if (gen !== meterGenRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctx) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const ctx = new Ctx();
        if (ctx.state === "suspended") await ctx.resume();
        if (gen !== meterGenRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          void ctx.close().catch(() => undefined);
          return;
        }
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        const floatBuf =
          typeof analyser.getFloatTimeDomainData === "function"
            ? new Float32Array(analyser.fftSize)
            : null;
        const byteBuf = floatBuf ? null : new Uint8Array(analyser.fftSize);
        let envelope = 0;
        meterRef.current = { stream, ctx, raf: 0 };

        const tick = () => {
          if (gen !== meterGenRef.current) return;
          let sum = 0;
          let peak = 0;
          const samples = floatBuf ?? byteBuf;
          if (!samples) return;
          if (floatBuf) {
            analyser.getFloatTimeDomainData(floatBuf);
            for (let i = 0; i < floatBuf.length; i += 1) {
              const v = floatBuf[i];
              sum += v * v;
              const a = Math.abs(v);
              if (a > peak) peak = a;
            }
          } else if (byteBuf) {
            analyser.getByteTimeDomainData(byteBuf);
            for (let i = 0; i < byteBuf.length; i += 1) {
              const v = (byteBuf[i] - 128) / 128;
              sum += v * v;
              const a = Math.abs(v);
              if (a > peak) peak = a;
            }
          }
          const rms = Math.sqrt(sum / samples.length);
          const mag = Math.max(rms * 1.15, peak * 0.72);
          const db = mag > 1e-7 ? 20 * Math.log10(mag) : -100;
          const target = Math.min(1, Math.max(0, (db + 50) / 41));
          const k = target > envelope ? 0.5 : 0.13;
          envelope += (target - envelope) * k;
          paintMeter(envelope);
          meterRef.current.raf = requestAnimationFrame(tick);
        };
        meterRef.current.raf = requestAnimationFrame(tick);
        setPermError(null);
      } catch (err) {
        setPermError(
          err instanceof Error ? err.message : "Не удалось открыть микрофон",
        );
      }
    },
    [paintMeter, stopMeter],
  );

  useEffect(() => {
    void loadDevices();
    const onDeviceChange = () => void loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        onDeviceChange,
      );
      stopMeter();
    };
  }, [loadDevices, stopMeter]);

  useEffect(() => {
    void startMeter(micId);
    return () => stopMeter();
  }, [micId, startMeter, stopMeter]);

  useEffect(() => {
    return subscribeVoiceSettings(() => {
      setMicId(getMicDeviceId());
      setSpeakerId(getSpeakerDeviceId());
      setKrispOn(getKrispEnabled());
    });
  }, []);

  async function handleSpeakerTest() {
    setTestingOut(true);
    try {
      await playSpeakerTest(speakerId);
    } finally {
      setTestingOut(false);
    }
  }

  return (
    <section className="voice-settings" aria-label="Голос и звук">
      <label className="field">
        <span className="voice-settings__label">
          <IconMic size={14} />
          Устройство ввода
        </span>
        <select
          value={mics.some((device) => device.deviceId === micId) ? micId : ""}
          onChange={(event) => {
            const next = event.target.value;
            setMicId(next);
            setMicDeviceId(next);
          }}
        >
          <option value="">По умолчанию</option>
          {mics.map((device, index) => (
            <option
              key={device.deviceId || device.label || `mic-${index}`}
              value={device.deviceId}
            >
              {device.label}
            </option>
          ))}
        </select>
        <div className="voice-settings__meter" aria-hidden>
          <span ref={fillRef} className="voice-settings__meter-fill" />
        </div>
      </label>

      <label className="field">
        <span className="voice-settings__label">
          <IconHeadphones size={14} />
          Устройство вывода
        </span>
        <div className="voice-settings__row">
          <select
            value={
              speakers.some((device) => device.deviceId === speakerId)
                ? speakerId
                : ""
            }
            disabled={!outputSupported}
            onChange={(event) => {
              const next = event.target.value;
              setSpeakerId(next);
              setSpeakerDeviceId(next);
            }}
          >
            <option value="">По умолчанию</option>
            {speakers.map((device, index) => (
              <option
                key={device.deviceId || device.label || `spk-${index}`}
                value={device.deviceId}
              >
                {device.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="voice-settings__test"
            disabled={testingOut}
            onClick={() => void handleSpeakerTest()}
          >
            <IconVolume size={14} />
            {testingOut ? "…" : "Тест"}
          </button>
        </div>
        {!outputSupported && (
          <em className="voice-settings__hint">
            Этот браузер не умеет выбирать колонки — используется системный выход
          </em>
        )}
      </label>

      <label className="profile__toggle">
        <span className="voice-settings__krisp">
          <IconNoise size={14} />
          <span>
            Krisp
            <em>Нейросеть убирает клавиатуру, вентилятор и улицу</em>
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={krispOn}
          className={`profile__switch ${krispOn ? "is-on" : ""}`}
          onClick={() => {
            const next = !krispOn;
            setKrispOn(next);
            setKrispEnabled(next);
          }}
        >
          <span className="profile__switch-knob" />
        </button>
      </label>

      {permError && <p className="profile__error">{permError}</p>}
    </section>
  );
}
