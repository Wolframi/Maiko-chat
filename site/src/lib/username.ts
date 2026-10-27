/** Accept search queries with or without a leading @. */
export function nicknameValue(input: string) {
  return input.trim().replace(/^@/, "");
}

/** Validate a nickname after removing its optional @ prefix. */
export function validateNickname(nickname: string) {
  if (nickname.length < 3 || nickname.length > 24) {
    return "Никнейм от 3 до 24 символов";
  }
  if (!/^[\p{L}\p{N}_.-]+$/u.test(nickname)) {
    return "Только буквы, цифры, _ . -";
  }
  return null;
}

export function personSearchScore(
  user: { username: string; displayName: string },
  queryRaw: string,
) {
  const query = nicknameValue(queryRaw).toLowerCase();
  if (query.length < 2 || query.length > 64) return 99;
  const username = user.username.toLowerCase();
  const display = user.displayName.toLowerCase();
  if (username === query) return 0;
  if (username.startsWith(query)) return 1;
  if (username.includes(query)) return 3;
  if (!queryRaw.trim().startsWith("@")) {
    if (display === query) return 2;
    if (display.startsWith(query)) return 4;
    if (display.includes(query)) return 5;
  }
  return 99;
}
