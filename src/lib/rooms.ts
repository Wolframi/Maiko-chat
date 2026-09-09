export function normalizeRoomId(input: string) {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 32);
  return value || "lobby";
}

export const DEFAULT_CHANNELS = [
  {
    id: "lobby",
    title: "Lobby",
    topic: "Общий канал для всех",
  },
  {
    id: "random",
    title: "Random",
    topic: "Свободные темы",
  },
] as const;

export function dmChatId(userIdA: string, userIdB: string) {
  const [a, b] = [userIdA, userIdB].sort();
  return `dm_${a}_${b}`;
}
