import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import {
  Camera,
  CameraOff,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Trash2,
  Upload,
  Eye,
  EyeOff,
  Forward,
  Hash,
  Image as ImageIcon,
  LogOut,
  Maximize2,
  Menu,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  MoreVertical,
  Paperclip,
  Pencil,
  Play,
  Pause,
  Phone,
  PhoneOff,
  Pin,
  Plus,
  Reply,
  ScreenShare,
  Search,
  Send,
  Settings,
  Smile,
  User,
  UserPlus,
  Users,
  Video,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
  Headphones,
  Sparkles,
  X,
} from "lucide-react";

type IconProps = {
  size?: number;
  className?: string;
};

const defaults: Pick<LucideProps, "strokeWidth"> = {
  strokeWidth: 1.8,
};

function wrap(LucideIcon: ComponentType<LucideProps>, props: IconProps) {
  return (
    <LucideIcon
      size={props.size ?? 18}
      className={props.className}
      aria-hidden
      {...defaults}
    />
  );
}

export function IconMenu(props: IconProps) {
  return wrap(Menu, props);
}
export function IconClose(props: IconProps) {
  return wrap(X, props);
}
export function IconPhone(props: IconProps) {
  return wrap(Phone, props);
}
export function IconPlay(props: IconProps) {
  return wrap(Play, props);
}
export function IconPause(props: IconProps) {
  return wrap(Pause, props);
}
export function IconVideo(props: IconProps) {
  return wrap(Video, props);
}
export function IconMic(props: IconProps) {
  return wrap(Mic, props);
}
export function IconMicOff(props: IconProps) {
  return wrap(MicOff, props);
}
export function IconCamera(props: IconProps) {
  return wrap(Camera, props);
}
export function IconCameraOff(props: IconProps) {
  return wrap(CameraOff, props);
}
export function IconPhoneOff(props: IconProps) {
  return wrap(PhoneOff, props);
}
export function IconAttach(props: IconProps) {
  return wrap(Paperclip, props);
}
export function IconSend(props: IconProps) {
  return wrap(Send, props);
}
export function IconSettings(props: IconProps) {
  return wrap(Settings, props);
}
export function IconLogout(props: IconProps) {
  return wrap(LogOut, props);
}
export function IconUser(props: IconProps) {
  return wrap(User, props);
}
export function IconUserPlus(props: IconProps) {
  return wrap(UserPlus, props);
}
export function IconChats(props: IconProps) {
  return wrap(MessageSquare, props);
}
export function IconUsers(props: IconProps) {
  return wrap(Users, props);
}
export function IconHash(props: IconProps) {
  return wrap(Hash, props);
}
export function IconVolume(props: IconProps) {
  return wrap(Volume2, props);
}
export function IconVolumeOff(props: IconProps) {
  return wrap(VolumeX, props);
}
export function IconSkipBack(props: IconProps) {
  return wrap(SkipBack, props);
}
export function IconSkipForward(props: IconProps) {
  return wrap(SkipForward, props);
}
export function IconHeadphones(props: IconProps) {
  return wrap(Headphones, props);
}
export function IconNoise(props: IconProps) {
  return wrap(Sparkles, props);
}
export function IconImage(props: IconProps) {
  return wrap(ImageIcon, props);
}
export function IconCheck(props: IconProps) {
  return wrap(Check, props);
}
export function IconPlus(props: IconProps) {
  return wrap(Plus, props);
}
export function IconMore(props: IconProps) {
  return wrap(MoreVertical, props);
}
export function IconScreen(props: IconProps) {
  return wrap(ScreenShare, props);
}
export function IconMinimize(props: IconProps) {
  return wrap(Minimize2, props);
}
export function IconExpand(props: IconProps) {
  return wrap(Maximize2, props);
}
export function IconDownload(props: IconProps) {
  return wrap(Download, props);
}
export function IconUpload(props: IconProps) {
  return wrap(Upload, props);
}
export function IconFile(props: IconProps) {
  return wrap(File, props);
}
export function IconFileText(props: IconProps) {
  return wrap(FileText, props);
}
export function IconFileArchive(props: IconProps) {
  return wrap(FileArchive, props);
}
export function IconFileCode(props: IconProps) {
  return wrap(FileCode, props);
}
export function IconFileSheet(props: IconProps) {
  return wrap(FileSpreadsheet, props);
}
export function IconFileAudio(props: IconProps) {
  return wrap(FileAudio, props);
}
export function IconFileVideo(props: IconProps) {
  return wrap(FileVideo, props);
}
export function IconFileImage(props: IconProps) {
  return wrap(FileImage, props);
}

export type FileIconKind =
  | "pdf"
  | "doc"
  | "sheet"
  | "archive"
  | "code"
  | "audio"
  | "video"
  | "image"
  | "file";

export function fileIconKind(name?: string | null, mime?: string | null): FileIconKind {
  const n = String(name || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf") || n.endsWith(".pdf")) return "pdf";
  if (
    m.includes("zip") ||
    m.includes("rar") ||
    m.includes("7z") ||
    m.includes("compress") ||
    /\.(zip|rar|7z|tar|gz|bz2)$/i.test(n)
  ) {
    return "archive";
  }
  if (
    m.includes("sheet") ||
    m.includes("excel") ||
    /\.(xlsx?|csv|ods)$/i.test(n)
  ) {
    return "sheet";
  }
  if (
    m.includes("word") ||
    m.includes("document") ||
    m === "text/plain" ||
    /\.(docx?|rtf|odt|txt|md)$/i.test(n)
  ) {
    return "doc";
  }
  if (
    m.includes("javascript") ||
    m.includes("json") ||
    m.includes("typescript") ||
    /\.(js|ts|tsx|jsx|json|py|rs|go|java|c|cpp|h|css|html|xml|yml|yaml)$/i.test(n)
  ) {
    return "code";
  }
  if (m.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|opus|weba)$/i.test(n)) {
    return "audio";
  }
  if (m.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(n)) {
    return "video";
  }
  if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(n)) {
    return "image";
  }
  return "file";
}

export function IconFileKind({
  kind,
  size = 20,
  className,
}: {
  kind: FileIconKind;
  size?: number;
  className?: string;
}) {
  const props = { size, className };
  switch (kind) {
    case "pdf":
    case "doc":
      return <IconFileText {...props} />;
    case "sheet":
      return <IconFileSheet {...props} />;
    case "archive":
      return <IconFileArchive {...props} />;
    case "code":
      return <IconFileCode {...props} />;
    case "audio":
      return <IconFileAudio {...props} />;
    case "video":
      return <IconFileVideo {...props} />;
    case "image":
      return <IconFileImage {...props} />;
    default:
      return <IconFile {...props} />;
  }
}
export function IconSearch(props: IconProps) {
  return wrap(Search, props);
}
export function IconReply(props: IconProps) {
  return wrap(Reply, props);
}
export function IconCopy(props: IconProps) {
  return wrap(Copy, props);
}

export function IconTrash(props: IconProps) {
  return wrap(Trash2, props);
}
export function IconPin(props: IconProps) {
  return wrap(Pin, props);
}
export function IconEdit(props: IconProps) {
  return wrap(Pencil, props);
}
export function IconForward(props: IconProps) {
  return wrap(Forward, props);
}
export function IconCheckDouble(props: IconProps) {
  return wrap(CheckCheck, props);
}
export function IconSmile(props: IconProps) {
  return wrap(Smile, props);
}
export function IconChevronUp(props: IconProps) {
  return wrap(ChevronUp, props);
}
export function IconChevronDown(props: IconProps) {
  return wrap(ChevronDown, props);
}
export function IconChevronLeft(props: IconProps) {
  return wrap(ChevronLeft, props);
}
export function IconChevronRight(props: IconProps) {
  return wrap(ChevronRight, props);
}
export function IconEye(props: IconProps) {
  return wrap(Eye, props);
}
export function IconEyeOff(props: IconProps) {
  return wrap(EyeOff, props);
}
