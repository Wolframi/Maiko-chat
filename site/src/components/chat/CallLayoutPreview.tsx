"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Avatar } from "@/components/chat/Avatar";
import { MessageList } from "@/components/chat/MessageList";
import { UnifiedPicker } from "@/components/chat/UnifiedPicker";
import { VoiceOverlay } from "@/components/chat/VoiceOverlay";
import { HeaderCallChip } from "@/components/chat/HeaderCallChip";
import {
  IconAttach,
  IconHash,
  IconMoreVertical,
  IconSearch,
  IconSend,
  IconSettings,
  IconUsers,
  IconVolume,
} from "@/lib/icons";
import type {
  AuthAccount,
  ChatMessage,
  PeopleUser,
  VoiceChannelUser,
} from "@/lib/types";

const account: AuthAccount = {
  token: "preview",
  userId: "self",
  username: "artem",
  displayName: "Артём",
  bio: "",
};

const people: PeopleUser[] = [
  {
    id: "alice",
    username: "alice",
    displayName: "Алиса",
    bio: "",
    online: true,
  },
  {
    id: "bob",
    username: "bob",
    displayName: "Боб",
    bio: "",
    online: true,
  },
  {
    id: "kirill",
    username: "kirill",
    displayName: "Кирилл",
    bio: "",
    online: true,
  },
];

const peers: VoiceChannelUser[] = [
  {
    userId: "alice",
    name: "Алиса",
    muted: false,
    deafened: false,
    speaking: true,
    cameraOff: false,
    sharingScreen: true,
  },
  {
    userId: "bob",
    name: "Боб",
    muted: true,
    deafened: false,
    cameraOff: true,
    sharingScreen: true,
  },
  {
    userId: "kirill",
    name: "Кирилл",
    muted: false,
    deafened: false,
    cameraOff: true,
    sharingScreen: true,
  },
];

const previewNow = Date.parse("2026-09-25T12:42:00.000Z");

const previewTextChannels = [
  { id: "general", title: "общий-чат", hint: "Основное обсуждение" },
  { id: "development", title: "разработка", hint: "Код и задачи" },
  { id: "design", title: "дизайн", hint: "Макеты и интерфейс" },
] as const;

type PreviewTextChannelId = (typeof previewTextChannels)[number]["id"];
type PreviewCallScenario = "screens" | "solo" | "duo" | "direct";

function paintScreen(
  title: string,
  accent: string,
  variant: "code" | "board" | "table" | "camera",
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) return new MediaStream();

  const gradient = context.createLinearGradient(0, 0, 1280, 720);
  gradient.addColorStop(0, "#11131a");
  gradient.addColorStop(1, "#08090d");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1280, 720);

  if (variant === "camera") {
    context.fillStyle = "#1c2130";
    context.fillRect(0, 0, 1280, 720);
    context.fillStyle = accent;
    context.beginPath();
    context.arc(640, 278, 126, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#d7d9e3";
    context.beginPath();
    context.arc(640, 245, 68, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.roundRect(485, 335, 310, 205, 90);
    context.fill();
  } else {
    context.fillStyle = "#181b24";
    context.fillRect(0, 0, 1280, 74);
    context.fillStyle = accent;
    context.fillRect(0, 0, 9, 720);
    context.fillStyle = "#f2f3f7";
    context.font = "600 26px sans-serif";
    context.fillText(title, 34, 46);

    context.fillStyle = "#10121a";
    context.fillRect(26, 100, 210, 584);
    for (let index = 0; index < 7; index += 1) {
      context.fillStyle = index === 1 ? `${accent}55` : "#222631";
      context.roundRect(48, 132 + index * 70, 166, 42, 10);
      context.fill();
    }

    if (variant === "code") {
      for (let index = 0; index < 13; index += 1) {
        context.fillStyle = index % 4 === 0 ? accent : "#7e879f";
        context.roundRect(282, 122 + index * 40, 340 + (index % 3) * 92, 13, 6);
        context.fill();
      }
    } else if (variant === "board") {
      for (let index = 0; index < 6; index += 1) {
        const x = 278 + (index % 3) * 302;
        const y = 126 + Math.floor(index / 3) * 248;
        context.fillStyle = "#222631";
        context.roundRect(x, y, 260, 200, 18);
        context.fill();
        context.fillStyle = index % 2 ? accent : "#5d6680";
        context.roundRect(x + 22, y + 24, 150, 14, 7);
        context.fill();
      }
    } else {
      context.fillStyle = "#20242e";
      context.roundRect(278, 124, 938, 514, 18);
      context.fill();
      for (let row = 0; row < 7; row += 1) {
        context.fillStyle = row === 0 ? `${accent}66` : row % 2 ? "#272c38" : "#222630";
        context.fillRect(300, 150 + row * 62, 894, 44);
      }
    }
  }

  const stream = canvas.captureStream(1);
  const track = stream.getVideoTracks()[0];
  if (track) track.contentHint = variant === "camera" ? "motion" : "detail";
  return stream;
}

function usePreviewStreams() {
  const [streams, setStreams] = useState<{
    remote: Record<string, MediaStream>;
    local: MediaStream | null;
  }>({ remote: {}, local: null });

  useEffect(() => {
    const aliceScreen = paintScreen("Проект Майко", "#7766ff", "code");
    const aliceCamera = paintScreen("Камера Алисы", "#855ee8", "camera");
    const bobScreen = paintScreen("Доска задач", "#3b82f6", "board");
    const kirillScreen = paintScreen("План релиза", "#36b37e", "table");
    const selfCamera = paintScreen("Камера Артёма", "#5277b8", "camera");
    const selfScreen = paintScreen("Экран Артёма", "#e05a78", "code");
    const all = [aliceScreen, aliceCamera, bobScreen, kirillScreen, selfCamera, selfScreen];
    setStreams({
      remote: {
        alice: new MediaStream([
          ...aliceCamera.getVideoTracks(),
          ...aliceScreen.getVideoTracks(),
        ]),
        bob: bobScreen,
        kirill: kirillScreen,
      },
      local: new MediaStream([
        ...selfCamera.getVideoTracks(),
        ...selfScreen.getVideoTracks(),
      ]),
    });
    return () => all.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  }, []);

  return streams;
}

export function CallLayoutPreview({
  initialMinimized = false,
}: {
  initialMinimized?: boolean;
}) {
  const { remote: remoteStreams, local: localStream } = usePreviewStreams();
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOff, setCameraOff] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [activeTextChannel, setActiveTextChannel] =
    useState<PreviewTextChannelId>("general");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [callScenario, setCallScenario] =
    useState<PreviewCallScenario>("screens");
  const [collapsedCall, setCollapsedCall] = useState(initialMinimized);
  const [compactLayout, setCompactLayout] = useState(false);
  const [utilityPortal, setUtilityPortal] = useState<HTMLDivElement | null>(null);
  const [composerPortal, setComposerPortal] = useState<HTMLDivElement | null>(null);
  const [callPanelHeight, setCallPanelHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const roomRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const ready = Object.keys(remoteStreams).length === 3 && Boolean(localStream);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("scenario");
    setCallScenario(
      requested === "solo" || requested === "duo" || requested === "direct"
        ? requested
        : "screens",
    );
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 641px) and (max-width: 1099px)");
    const sync = () => setCompactLayout(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setPickerOpen(false);
  }, [compactLayout]);

  const messages = useMemo<ChatMessage[]>(() => {
    if (activeTextChannel === "development") {
      return [
        {
          id: "preview-dev-1",
          room: "preview-development",
          author: "Кирилл",
          authorId: "kirill",
          text: "Сетка участников уже адаптивная",
          createdAt: previewNow - 210_000,
        },
        {
          id: "preview-dev-2",
          room: "preview-development",
          author: "Артём",
          authorId: "self",
          text: "Проверю ещё узкое окно",
          createdAt: previewNow - 95_000,
        },
      ];
    }
    if (activeTextChannel === "design") {
      return [
        {
          id: "preview-design-1",
          room: "preview-design",
          author: "Алиса",
          authorId: "alice",
          text: "Чат оставляем шириной как на телефоне",
          createdAt: previewNow - 160_000,
        },
        {
          id: "preview-design-2",
          room: "preview-design",
          author: "Артём",
          authorId: "self",
          text: "А справа будут каналы и эмодзи",
          createdAt: previewNow - 45_000,
        },
      ];
    }
    return [
      {
        id: "preview-1",
        room: "preview-group",
        author: "Алиса",
        authorId: "alice",
        text: "Привет, всё видно?",
        createdAt: previewNow - 180_000,
      },
      {
        id: "preview-2",
        room: "preview-group",
        author: "Артём",
        authorId: "self",
        text: "Да, демонстрация работает",
        createdAt: previewNow - 120_000,
      },
      {
        id: "preview-3",
        room: "preview-group",
        author: "Боб",
        authorId: "bob",
        text: "Я тоже включил экран",
        createdAt: previewNow - 80_000,
      },
      {
        id: "preview-4",
        room: "preview-group",
        author: "Артём",
        authorId: "self",
        text: "Отлично, все три экрана на месте",
        createdAt: previewNow - 30_000,
      },
    ];
  }, [activeTextChannel]);

  const activeChannel =
    previewTextChannels.find((channel) => channel.id === activeTextChannel) ??
    previewTextChannels[0];

  const previewPeers = useMemo<VoiceChannelUser[]>(() => {
    if (callScenario === "solo") return [];
    if (callScenario === "duo" || callScenario === "direct") {
      return [
        {
          ...peers[0],
          muted: false,
          speaking: false,
          cameraOff: true,
          sharingScreen: false,
        },
      ];
    }
    return peers;
  }, [callScenario]);

  const previewRemoteStreams = useMemo<Record<string, MediaStream>>(() => {
    if (callScenario === "screens") return remoteStreams;
    if (callScenario === "solo") return {};
    const alice = remoteStreams.alice;
    if (!alice) return {};
    const tracks = alice.getVideoTracks();
    const cameraTrack =
      tracks.find((track) => track.contentHint === "motion") ?? tracks[0];
    return cameraTrack ? { alice: new MediaStream([cameraTrack]) } : {};
  }, [callScenario, remoteStreams]);

  const participantCount = previewPeers.length + 1;
  const sharedScreenCount =
    (callScenario === "screens"
      ? previewPeers.filter((peer) => peer.sharingScreen).length
      : 0) + (sharingScreen ? 1 : 0);
  const callSummary = `${participantCount} ${
    participantCount === 1 ? "участник" : "участника"
  }${
    sharedScreenCount
      ? ` · ${sharedScreenCount} ${
          sharedScreenCount === 1 ? "демонстрация" : "демонстрации"
        }`
      : ""
  }`;

  function clampCallHeight(height: number) {
    const room = roomRef.current;
    if (!room) return Math.max(220, height);
    const header = room.querySelector<HTMLElement>(":scope > .room__header");
    const available = room.getBoundingClientRect().height - (header?.offsetHeight ?? 0) - 10;
    const maximum = Math.max(220, available - 220);
    return Math.min(maximum, Math.max(220, Math.round(height)));
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (!compactLayout) return;
    const dock = event.currentTarget.previousElementSibling;
    if (!(dock instanceof HTMLElement)) return;
    event.preventDefault();
    resizeRef.current = {
      startY: event.clientY,
      startHeight: dock.getBoundingClientRect().height,
    };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize) return;
    setCallPanelHeight(
      clampCallHeight(resize.startHeight + event.clientY - resize.startY),
    );
  }

  function handleResizeEnd(event: ReactPointerEvent<HTMLDivElement>) {
    resizeRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <main className="app-shell call-preview" data-preview-ready={ready}>
      <div className="workspace">
        <aside className="workspace__sidebar" aria-label="Навигация предпросмотра">
          <nav className="server-rail" aria-label="Серверы и группы">
            <button className="server-rail__orb server-rail__orb--home" type="button">М</button>
            <span className="server-rail__sep" />
            <button className="server-rail__orb server-rail__orb--guild is-active" type="button">РК</button>
            <button className="server-rail__orb server-rail__orb--guild" type="button">Д</button>
            <button className="server-rail__orb server-rail__orb--add" type="button">+</button>
          </nav>
          <div className="workspace__sidebar-pane call-preview__sidebar">
            <header>
              <strong>Рабочая команда</strong>
              <span>4 участника</span>
            </header>
            <p>КАНАЛЫ</p>
            <button type="button" className="is-active"><IconHash size={17} /> общий-чат</button>
            <button type="button"><IconHash size={17} /> разработка</button>
            <button type="button"><IconHash size={17} /> дизайн</button>
            <p>ГОЛОСОВЫЕ КАНАЛЫ</p>
            <button type="button" className="is-active"><IconVolume size={17} /> Общий звонок</button>
            <div className="call-preview__voice-users">
              <span>Алиса · экран + камера</span>
              <span>Боб · экран</span>
              <span>Кирилл · экран</span>
              <span>Артём</span>
            </div>
            <footer>
              <Avatar name="Артём" size="sm" online />
              <span><strong>Артём</strong><em>В сети</em></span>
              <IconSettings size={17} />
            </footer>
          </div>
        </aside>

        <section
          ref={roomRef}
          className={`room ${collapsedCall ? "" : "room--in-call"} ${callScenario === "direct" ? "room--direct-call" : ""} ${
            resizing ? "is-resizing" : ""
          } ${
            pickerOpen ? "is-call-picker-open" : ""
          }`}
          style={
            callPanelHeight === null
              ? undefined
              : ({
                  "--call-preview-call-height": `${callPanelHeight}px`,
                } as CSSProperties)
          }
        >
          <header className="room__header">
            <div className="room__heading">
              <Avatar name="Рабочая команда" size="md" />
              <div className="room__heading-text">
                <p className="room__brand">
                  {callScenario === "direct" ? "Личный звонок" : "Общий звонок"}
                </p>
                <p className="room__title">{callSummary}</p>
              </div>
            </div>
            <div className="room__call-chip">
              {collapsedCall ? (
                <HeaderCallChip
                  title={callScenario === "direct" ? "Алиса" : "Общий звонок"}
                  subtitle={
                    callScenario === "direct" ? "12:04 · экран" : "4 в канале · экран"
                  }
                  mark={callScenario === "direct" ? "call" : "voice"}
                  speaking
                  muted={muted}
                  onOpen={() => setCollapsedCall(false)}
                  onToggleMute={() => setMuted((value) => !value)}
                  onEnd={() => setCollapsedCall(false)}
                />
              ) : null}
            </div>
            <div className="room__meta">
              <button type="button" className="icon-btn" aria-label="Участники"><IconUsers size={18} /></button>
              <button type="button" className="icon-btn" aria-label="Поиск"><IconSearch size={18} /></button>
              <button type="button" className="icon-btn" aria-label="Ещё"><IconMoreVertical size={18} /></button>
            </div>
          </header>

          <div id="pulse-call-dock" className="room__call-dock is-screen" />

          {callScenario !== "direct" && !collapsedCall ? (
          <div
            className="call-preview__resize"
            role="separator"
            aria-label="Изменить высоту звонка и чата"
            aria-orientation="horizontal"
            tabIndex={0}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={() => setCallPanelHeight(null)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              const dock = event.currentTarget.previousElementSibling;
              const current =
                callPanelHeight ??
                (dock instanceof HTMLElement
                  ? dock.getBoundingClientRect().height
                  : 420);
              setCallPanelHeight(
                clampCallHeight(current + (event.key === "ArrowDown" ? 24 : -24)),
              );
            }}
          >
            <span aria-hidden />
          </div>
          ) : null}

          <div className="room__stage">
            <div className="call-preview__chat-column call-layout__chat">
              {callScenario !== "direct" ? (
              <header className="call-preview__chat-head">
                <IconHash size={16} />
                <span>
                  <strong>{activeChannel.title}</strong>
                  <em>{activeChannel.hint}</em>
                </span>
              </header>
              ) : null}
              <MessageList
                chatId={`preview-${activeTextChannel}`}
                messages={messages}
                people={people}
                account={account}
                othersTyping={[]}
                peerReadAt={previewNow}
              />
              <div
                ref={setComposerPortal}
                className="composer call-preview__composer"
              >
                <div className="composer__box">
                  <button type="button" className="composer__attach" aria-label="Прикрепить"><IconAttach size={20} /></button>
                  <textarea
                    className="composer__input"
                    aria-label="Написать сообщение"
                    placeholder={`Написать в #${activeChannel.title}…`}
                    value={draftText}
                    onChange={(event) => setDraftText(event.currentTarget.value)}
                  />
                  <UnifiedPicker
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                    portalRoot={compactLayout ? utilityPortal : composerPortal}
                    onEmojiPick={(emoji) => setDraftText((value) => `${value}${emoji}`)}
                    onGifPick={() => setPickerOpen(false)}
                    onStickerPick={() => setPickerOpen(false)}
                    userId="self"
                    token="preview"
                    stickerPacks={[]}
                    refreshStickerPacks={async () => []}
                    onCreateStickerPack={async () => ({ ok: false, error: "Предпросмотр" })}
                    onDeleteStickerPack={async () => false}
                    onRenameStickerPack={async () => false}
                    onAddSticker={async () => ({ ok: false, error: "Предпросмотр" })}
                    onRemoveSticker={async () => false}
                  />
                  <button type="button" className="composer__send is-ready" aria-label="Отправить"><IconSend size={19} /></button>
                </div>
              </div>
            </div>

            <aside
              className={`call-preview__utility call-layout__utility ${pickerOpen ? "is-picker" : ""}`}
              aria-label={pickerOpen ? "Эмодзи, стикеры и GIF" : "Текстовые каналы"}
            >
              <header className="call-preview__utility-head">
                <strong>{pickerOpen ? "Эмодзи, стикеры и GIF" : "Текстовые каналы"}</strong>
                <span>{pickerOpen ? "Выберите содержимое для сообщения" : "Рабочая команда"}</span>
              </header>
              <div ref={setUtilityPortal} className="call-preview__utility-body">
                {!pickerOpen && callScenario !== "direct" ? (
                  <nav className="call-preview__channels" aria-label="Текстовые каналы группы">
                    {previewTextChannels.map((channel) => (
                      <button
                        key={channel.id}
                        type="button"
                        className={channel.id === activeTextChannel ? "is-active" : ""}
                        onClick={() => setActiveTextChannel(channel.id)}
                      >
                        <IconHash size={18} />
                        <span>
                          <strong>{channel.title}</strong>
                          <em>{channel.hint}</em>
                        </span>
                      </button>
                    ))}
                  </nav>
                ) : null}
              </div>
            </aside>
          </div>
        </section>
      </div>

      <VoiceOverlay
        active={{ channelId: "preview-voice", groupId: "preview-group", title: "Общий звонок" }}
        peers={previewPeers}
        selfId="self"
        selfName="Артём"
        localStream={localStream}
        remoteStreams={previewRemoteStreams}
        muted={muted}
        deafened={deafened}
        cameraOff={cameraOff}
        sharingScreen={sharingScreen}
        minimized={collapsedCall}
        currentGroupId="preview-group"
        selfSpeaking={false}
        onLeave={() => undefined}
        onToggleMute={() => setMuted((value) => !value)}
        onToggleDeafen={() => setDeafened((value) => !value)}
        onToggleCamera={() => setCameraOff((value) => !value)}
        onToggleScreenShare={() => setSharingScreen((value) => !value)}
        onToggleMinimized={() => undefined}
      />
    </main>
  );
}
