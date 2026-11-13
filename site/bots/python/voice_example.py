"""Пример: бот входит в голосовой канал Майко и публикует в него аудио/видео.

Требуется медиа-SDK LiveKit для Python:

    py -m pip install -r site/bots/python/requirements-voice.txt

Сервер Майко выдаёт боту LiveKit-токен (bot:voiceJoin), а сам бот подключается
к SFU как обычный участник и публикует треки. Пример экспериментальный:
API livekit-rtc меняется между версиями, поэтому при ошибке сверьтесь с
документацией установленной версии `livekit`.

Запуск:
    py site/bots/python/voice_example.py --token maiko_bot_... \
        --channel group_my-group::voice_general --wav music.wav --video

Без --wav бот играет сгенерированный тон. Видео (если есть numpy) — бегущий
градиент, публикуется как демонстрация экрана (SOURCE_SCREENSHARE), при этом
в составе канала у бота появляется плашка «демонстрация».
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
import struct
import sys
import wave
from typing import Optional

from maiko_bot import BotError, MaikoBot

try:
    from livekit import rtc
except ImportError:  # pragma: no cover — зависит от окружения бота
    rtc = None  # type: ignore[assignment]


def read_wav(path: str) -> tuple[int, bytes]:
    """Вернуть (sample_rate, mono s16le PCM). Поддерживается PCM 16 бит."""
    with wave.open(path, "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        frames = source.readframes(source.getnframes())
    if width != 2:
        raise SystemExit("Нужен WAV PCM 16 бит")
    if channels > 1:
        samples = struct.unpack(f"<{len(frames) // 2}h", frames)
        mono = samples[::channels]
        frames = struct.pack(f"<{len(mono)}h", *mono)
    return rate, frames


def tone_pcm(rate: int = 48000, seconds: float = 5.0) -> bytes:
    samples = int(rate * seconds)
    data = bytearray(samples * 2)
    for index in range(samples):
        value = math.sin(2 * math.pi * 440 * index / rate) * 0.25
        struct.pack_into("<h", data, index * 2, int(value * 32767))
    return bytes(data)


async def publish_audio(room: "rtc.Room", rate: int, pcm: bytes, loop: bool) -> None:
    source = rtc.AudioSource(rate, 1)
    track = rtc.LocalAudioTrack.create_audio_track("bot-audio", source)
    options = rtc.TrackPublishOptions()
    options.source = rtc.TrackSource.SOURCE_MICROPHONE
    await room.local_participant.publish_track(track, options)

    samples_per_frame = max(160, rate // 50)  # 20 мс
    frame_bytes = samples_per_frame * 2
    print(f"[voice] публикую аудио {rate} Гц, {len(pcm) / 2 / rate:.1f} c")
    while True:
        for offset in range(0, len(pcm), frame_bytes):
            chunk = pcm[offset : offset + frame_bytes]
            if len(chunk) < frame_bytes:
                break
            frame = rtc.AudioFrame(
                data=chunk,
                sample_rate=rate,
                num_channels=1,
                samples_per_channel=samples_per_frame,
            )
            await source.capture_frame(frame)
            await asyncio.sleep(0.02)
        if not loop:
            break
        print("[voice] повторяю аудио")


async def publish_video(room: "rtc.Room") -> None:
    width, height = 640, 360
    source = rtc.VideoSource(width, height)
    track = rtc.LocalVideoTrack.create_video_track("bot-screen", source)
    options = rtc.TrackPublishOptions()
    options.source = rtc.TrackSource.SOURCE_SCREENSHARE
    await room.local_participant.publish_track(track, options)
    print("[voice] публикую видео как демонстрацию экрана")

    try:
        import numpy as np
    except ImportError:
        np = None

    for tick in range(600):
        if np is not None:
            x = np.arange(width, dtype=np.uint16)[None, :]
            y = np.arange(height, dtype=np.uint16)[:, None]
            red = ((x + tick * 3) % 256).astype(np.uint8)
            green = ((y + tick * 2) % 256).astype(np.uint8)
            blue = np.full_like(red, 160)
            rgb = np.dstack([red, np.broadcast_to(green, red.shape), blue])
            payload = rgb.tobytes()
        else:
            payload = bytes([40, 90, 180]) * (width * height)
        frame = rtc.VideoFrame(width, height, rtc.VideoBufferType.RGB24, payload)
        await source.capture_frame(frame)
        await asyncio.sleep(0.05)


async def media_session(
    livekit: dict,
    rate: int,
    pcm: bytes,
    with_video: bool,
    loop: bool,
) -> None:
    room = rtc.Room()
    await room.connect(livekit["url"], livekit["token"])
    print(f"[voice] подключился к LiveKit room={livekit.get('room')}")
    tasks = [asyncio.create_task(publish_audio(room, rate, pcm, loop))]
    if with_video:
        tasks.append(asyncio.create_task(publish_video(room)))
    try:
        await asyncio.gather(*tasks)
    finally:
        await room.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser(description="Бот в голосовом канале Майко")
    parser.add_argument("--token", default=os.environ.get("MAIKO_BOT_TOKEN"))
    parser.add_argument("--url", default=os.environ.get("MAIKO_URL", "http://127.0.0.1:3000"))
    parser.add_argument("--channel", default=None, help="id голосового канала или часть названия")
    parser.add_argument("--wav", default=None, help="WAV-файл PCM 16 бит")
    parser.add_argument("--video", action="store_true", help="публиковать видео (демонстрация)")
    parser.add_argument("--once", action="store_true", help="не повторять аудио")
    parser.add_argument("--seconds", type=float, default=600, help="сколько секунд работать")
    args = parser.parse_args()

    if not args.token:
        raise SystemExit("Нужен токен: --token maiko_bot_...")
    if rtc is None:
        raise SystemExit("Установите медиа-SDK: py -m pip install -r site/bots/python/requirements-voice.txt")

    bot = MaikoBot(token=args.token, url=args.url)
    try:
        bot.connect()
        channels = bot.voice_channels()
        if not channels:
            raise SystemExit("У бота нет голосовых каналов — добавьте его в группу")
        channel = channels[0]
        if args.channel:
            channel = next(
                (
                    item
                    for item in channels
                    if item.get("id") == args.channel
                    or args.channel.lower() in str(item.get("title", "")).lower()
                ),
                channel,
            )
        joined = bot.join_voice(channel["id"])
        livekit = joined.get("livekit")
        if not livekit:
            print("[voice] LiveKit не настроен: доступно только присутствие в канале")
            bot.set_voice_media(muted=True)
            return
        print(f"[voice] канал «{channel.get('title')}», участников: {len(joined.get('members') or [])}")
        bot.set_voice_media(muted=False)
        if args.video:
            bot.set_voice_media(sharing_screen=True)

        if args.wav:
            rate, pcm = read_wav(args.wav)
        else:
            rate, pcm = 48000, tone_pcm()

        try:
            asyncio.run(
                asyncio.wait_for(
                    media_session(livekit, rate, pcm, args.video, not args.once),
                    timeout=args.seconds,
                )
            )
        except asyncio.TimeoutError:
            pass
    except (BotError, KeyboardInterrupt) as error:
        print(f"[voice] остановлено: {error}")
    finally:
        try:
            bot.leave_voice()
        except Exception:  # noqa: BLE001
            pass
        bot.stop()


if __name__ == "__main__":
    main()
