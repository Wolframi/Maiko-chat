import { format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";
import { ru } from "date-fns/locale";

export function formatMessageTime(value: number) {
  return format(value, "HH:mm", { locale: ru });
}

export function formatAudioSentAt(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const clock = format(value, "HH:mm", { locale: ru });
  if (isToday(value)) return `Сегодня в ${clock}`;
  if (isYesterday(value)) return `Вчера в ${clock}`;
  return format(value, "d MMM в HH:mm", { locale: ru });
}

export function formatDayChip(value: number) {
  if (isToday(value)) return "Сегодня";
  if (isYesterday(value)) return "Вчера";
  return format(value, "d MMMM", { locale: ru });
}

export function formatChatListTime(value: number) {
  if (isToday(value)) return format(value, "HH:mm", { locale: ru });
  if (isYesterday(value)) return "Вчера";
  return format(value, "d MMM", { locale: ru });
}

export function formatLastSeenLabel(value?: number | null) {
  if (!value) return "не в сети";
  const diff = Date.now() - value;
  if (diff < 60_000) return "только что";
  if (diff < 60 * 60_000) {
    return `был(а) ${formatDistanceToNowStrict(value, { locale: ru, addSuffix: true })}`;
  }
  if (isToday(value)) {
    return `был(а) сегодня в ${format(value, "HH:mm", { locale: ru })}`;
  }
  if (isYesterday(value)) {
    return `был(а) вчера в ${format(value, "HH:mm", { locale: ru })}`;
  }
  return `был(а) ${format(value, "d MMM в HH:mm", { locale: ru })}`;
}
