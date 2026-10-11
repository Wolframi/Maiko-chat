"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { VoiceBubble } from "@/components/chat/VoiceBubble";
import { VoiceTranscript } from "@/components/chat/VoiceTranscript";
import type { AudioTrack } from "@/lib/audioPlayback";
import type { ChatMessage } from "@/lib/types";

function note(id: string, patch: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    room: "preview",
    author: "Артём",
    text: "Голосовое сообщение",
    createdAt: Date.now(),
    kind: "file",
    ...patch,
  };
}

function track(id: string): AudioTrack {
  return {
    id,
    messageId: id,
    roomId: "preview",
    src: "",
    kind: "voice",
    title: "Голосовое сообщение",
    author: "Артём",
    createdAt: Date.now(),
  };
}

function VoiceCard({
  message,
  mine = true,
}: {
  message: ChatMessage;
  mine?: boolean;
}) {
  return (
    <div
      className={`bubble bubble--mine bubble--audio ${mine ? "" : "bubble--theirs"}`}
      style={{ width: 320 }}
    >
      <div className="bubble__audio bubble__audio--voice">
        <div className="bubble__audio-item">
          <VoiceBubble
            src=""
            mine={mine}
            track={track(message.id)}
          />
          <VoiceTranscript
            message={message}
            mine={mine}
            clock={<span className="voice-transcript__time">22:14</span>}
          />
        </div>
      </div>
    </div>
  );
}

export default function VoicePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const [live, setLive] = useState<ChatMessage>(
    note("live", { transcriptionStatus: "pending" }),
  );

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        gap: 16,
        alignContent: "start",
        padding: 24,
        background: "#0c0c0e",
      }}
    >
      <VoiceCard
        message={note("empty", {
          transcription: "",
          transcriptionStatus: "ready",
        })}
      />
      <VoiceCard
        message={note("text", {
          transcription: "Завтра в семь у подъезда",
          transcriptionStatus: "ready",
        })}
      />
      <VoiceCard message={live} />
      <button
        type="button"
        onClick={() =>
          setLive(
            note("live", {
              transcription: "Я уже вышел, буду через пять минут",
              transcriptionStatus: "ready",
            }),
          )
        }
      >
        Показать расшифровку
      </button>
    </main>
  );
}
