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
import {
  audioCaptureConstraints,
  getNeuralNoiseEnabled,
  setNeuralNoiseEnabled,
  startNoiseFilter,
  stopNoiseFilter,
  type NoiseFilterSession,
} from "@/lib/noiseFilter";
import { IconHeadphones, IconMic, IconNoise, IconVolume } from "@/lib/icons";

function meterCaptureConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...audioCaptureConstraints(),
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

/** Человекочитаемый текст ошибки устройства вместо «Requested device not found». */
function friendlyDeviceError(err: Error): string {
  if (/device not found|NotFoundError/i.test(err.name + err.message)) {
    return "Микрофон не найден — подключите устройство";
  }
  if (/NotAllowed|Permission|denied/i.test(err.name + err.message)) {
    return "Разрешите доступ к микрофону";
  }
  return "Не удалось открыть микрофон";
}

export function VoiceSettings() {
  const [mics, setMics] = useState<AudioDeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<AudioDeviceOption[]>([]);
  const [micId, setMicId] = useState(getMicDeviceId);
  const [speakerId, setSpeakerId] = useState(getSpeakerDeviceId);
  const [dtlnOn, setDtlnOn] = useState(getNeuralNoiseEnabled);
  const [permError, setPermError] = useState<string | null>(null);
  const [testingOut, setTestingOut] = useState(false);
  const [outputSupported] = useState(canSelectAudioOutput);
  const fillRef = useRef<HTMLSpanElement>(null);
  const meterGenRef = useRef(0);
  const meterRef = useRef<{
    stream: MediaStream | null;
    filter: NoiseFilterSession | null;
    ctx: AudioContext | null;
    raf: number;
  }>({ stream: null, filter: null, ctx: null, raf: 0 });

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
    void stopNoiseFilter(state.filter);
    state.filter = null;
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
        err instanceof Error
          ? friendlyDeviceError(err)
          : "Нет доступа к микрофону",
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
        meterRef.current.stream = stream;
        const raw = stream.getAudioTracks()[0];
        if (!raw) throw new Error("NotFoundError");
        const filter = await startNoiseFilter(raw);
        if (gen !== meterGenRef.current) {
          await stopNoiseFilter(filter);
          return;
        }
        meterRef.current.filter = filter;
        // The preference may change while the models are loading.
        await filter.setEnabled(getNeuralNoiseEnabled());
        if (gen !== meterGenRef.current) {
          await stopNoiseFilter(filter);
          return;
        }
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctx) {
          stopMeter();
          return;
        }
        const ctx = new Ctx();
        meterRef.current.ctx = ctx;
        if (ctx.state === "suspended") await ctx.resume();
        if (gen !== meterGenRef.current) {
          await stopNoiseFilter(filter);
          void ctx.close().catch(() => undefined);
          return;
        }
        const source = ctx.createMediaStreamSource(new MediaStream([filter.outputTrack]));
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
        meterRef.current = { stream, filter, ctx, raf: 0 };

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
        if (gen !== meterGenRef.current) return;
        stopMeter();
        setPermError(
          err instanceof Error
            ? friendlyDeviceError(err)
            : "Не удалось открыть микрофон",
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
    return subscribeVoiceSettings((change) => {
      setMicId(getMicDeviceId());
      setSpeakerId(getSpeakerDeviceId());
      setDtlnOn(getNeuralNoiseEnabled());
      if (change.noise) {
        void meterRef.current.filter?.setEnabled(getNeuralNoiseEnabled());
      }
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
            DTLN
            <em>Нейросетевое шумоподавление на вашем устройстве</em>
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-label="Шумоподавление DTLN"
          aria-checked={dtlnOn}
          className={`profile__switch ${dtlnOn ? "is-on" : ""}`}
          onClick={() => {
            const next = !dtlnOn;
            setDtlnOn(next);
            setNeuralNoiseEnabled(next);
          }}
        >
          <span className="profile__switch-knob" />
        </button>
      </label>

      {permError && <p className="profile__error">{permError}</p>}
    </section>
  );
}
