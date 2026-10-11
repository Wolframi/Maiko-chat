export type FileAttachment = {
  url: string;
  name: string;
  size: number;
  mime: string;
  /** Pixel size — used for Telegram-style album mosaic. */
  width?: number;
  height?: number;
};

export type ReplyPreview = {
  id: string;
  author: string;
  text: string;
};

export type MessageReaction = {
  emoji: string;
  userIds: string[];
};

export type MessageStatus = "pending" | "failed";

export type GroupInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired";

export type GroupInvite = {
  groupId: string;
  groupTitle: string;
  status: GroupInviteStatus;
};

export type ChatMessage = {
  id: string;
  /** Stable list key for optimistic → server id remaps (avoids remount jump). */
  clientKey?: string;
  /** Sender-generated idempotency key — survives server restarts. */
  clientId?: string;
  room: string;
  author: string;
  authorId?: string;
  text: string;
  createdAt: number;
  editedAt?: number;
  pinned?: boolean;
  kind?: "text" | "system" | "file" | "call" | "invite" | "sticker";
  sticker?: MessageSticker;
  /** Primary / first attachment (legacy + album[0]). */
  file?: FileAttachment;
  /** Media album (Telegram-style). When set, `file` mirrors the first item. */
  files?: FileAttachment[];
  replyTo?: ReplyPreview;
  forwardedFrom?: {
    author: string;
    text?: string;
  };
  invite?: GroupInvite;
  reactions?: MessageReaction[];
  status?: MessageStatus;
  /** Client-only: 0..1 while attachments are uploading from this device. */
  uploadProgress?: number;
  /** Client-only: per-attachment 0..1 (same order as `files`), 1 = that file is done. */
  uploadFileProgress?: number[];
  /** Whisper transcript for voice notes. */
  transcription?: string;
  transcriptionStatus?: "pending" | "ready" | "error";
};

export type TypingEvent = {
  name: string;
  isTyping: boolean;
};

export type ChatType = "channel" | "dm" | "group";

export type GroupVisibility = "public" | "private";

/** Public group hit for discovery / join UI. */
export type PublicGroupHit = {
  id: string;
  title: string;
  topic: string;
  members: number;
  avatarUrl?: string;
  joined: boolean;
};

export type VoiceChannelUser = {
  userId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  speaking?: boolean;
  avatarUrl?: string;
  cameraOff?: boolean;
  sharingScreen?: boolean;
  mediaRevision?: number;
};

export type VoiceChannelInfo = {
  id: string;
  title: string;
  users: VoiceChannelUser[];
};

export type TextChannelInfo = {
  id: string;
  title: string;
  unreadCount: number;
};

export type ChatLastMessage = {
  author: string;
  authorId?: string;
  text: string;
  createdAt: number;
  kind?: ChatMessage["kind"];
  thumbUrl?: string;
  thumbAnimated?: boolean;
};

export type ChatInfo = {
  id: string;
  type: ChatType;
  title: string;
  topic: string;
  online: number;
  messages: number;
  members: number;
  unreadCount: number;
  pinned: boolean;
  peerId?: string;
  avatarUrl?: string;
  createdBy?: string;
  /** Group member ids (for invite UI). */
  memberIds?: string[];
  /** Groups only. Missing/legacy → treat as private. */
  visibility?: GroupVisibility;
  lastMessage: ChatLastMessage | null;
  createdAt: number;
  /** Discord-style voice channels (groups only). */
  voiceChannels?: VoiceChannelInfo[];
  /** Extra text chats. #general is the group id and is not listed here. */
  textChannels?: TextChannelInfo[];
};

export type RoomMediaCategory = "media" | "file" | "audio";

export type RoomMediaItem = {
  messageId: string;
  createdAt: number;
  author: string;
  category: RoomMediaCategory;
  kind: "image" | "video" | "file";
  file: FileAttachment;
};

/** @deprecated use ChatInfo */
export type RoomInfo = ChatInfo;

export type Session = {
  name: string;
  room: string;
};

export type AuthAccount = {
  token: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bio: string;
};

export type PeopleUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bio: string;
  online: boolean;
  lastSeenAt?: number;
};

export type CallMode = "audio" | "video";

export type IncomingCall = {
  callId: string;
  fromUserId: string;
  fromName: string;
  mode: CallMode;
  chatId: string;
  reconnect?: boolean;
};


export type Sticker = {
  id: string;
  url: string;
  name?: string;
  emoji?: string;
  animated?: boolean;
  width?: number;
  height?: number;
  size: number;
  addedAt: number;
};

export type StickerPack = {
  id: string;
  title: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  stickers: Sticker[];
  stickerCount: number;
  coverUrl?: string;
  installed: boolean;
  canEdit: boolean;
  ownerName?: string;
};

export type MessageSticker = {
  packId: string;
  stickerId: string;
  url: string;
  animated?: boolean;
  width?: number;
  height?: number;
};
