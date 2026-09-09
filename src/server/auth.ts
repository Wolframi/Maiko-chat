import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  token?: string;
  tokenIssuedAt?: number;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  lastSeenAt?: number;
};

export type AuthAccount = {
  token: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bio: string;
};

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bio: string;
  lastSeenAt?: number;
};

type AuthResult =
  | { ok: true; account: AuthAccount }
  | { ok: false; error: string };

const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

const usersByName = new Map<string, StoredUser>();
const sessionsByToken = new Map<string, AuthAccount>();
const socketTokens = new Map<string, string>();

function displayOf(user: StoredUser) {
  return (user.displayName || user.username).trim() || user.username;
}

function toAccount(user: StoredUser, token: string): AuthAccount {
  return {
    token,
    userId: user.id,
    username: user.username,
    displayName: displayOf(user),
    avatarUrl: user.avatarUrl,
    bio: user.bio || "",
  };
}

function toPublic(user: StoredUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: displayOf(user),
    avatarUrl: user.avatarUrl,
    bio: user.bio || "",
    lastSeenAt: user.lastSeenAt,
  };
}

function isSessionExpired(issuedAt?: number) {
  if (!issuedAt) return false;
  return Date.now() - issuedAt > SESSION_TTL_MS;
}

function findUserById(userId: string) {
  for (const user of usersByName.values()) {
    if (user.id === userId) return user;
  }
  return null;
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Users file never stores live session tokens. */
function saveUsers() {
  ensureDataDir();
  const safe = [...usersByName.values()].map((user) => ({
    id: user.id,
    username: user.username,
    passwordHash: user.passwordHash,
    createdAt: user.createdAt,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    lastSeenAt: user.lastSeenAt,
  }));
  writeFileSync(USERS_FILE, JSON.stringify(safe, null, 2), "utf8");
}

function saveSessions() {
  ensureDataDir();
  const rows: { token: string; userId: string; issuedAt: number }[] = [];
  for (const user of usersByName.values()) {
    if (!user.token) continue;
    rows.push({
      token: user.token,
      userId: user.id,
      issuedAt: user.tokenIssuedAt || Date.now(),
    });
  }
  writeFileSync(SESSIONS_FILE, JSON.stringify(rows, null, 2), "utf8");
}

function persistAuth() {
  saveUsers();
  saveSessions();
}

function loadUsers() {
  if (!existsSync(USERS_FILE)) return false;
  let hadLegacyTokens = false;
  try {
    const raw = JSON.parse(readFileSync(USERS_FILE, "utf8")) as StoredUser[];
    for (const user of raw) {
      if (user.token) hadLegacyTokens = true;
      usersByName.set(user.username.toLowerCase(), user);
      if (user.token) {
        sessionsByToken.set(user.token, toAccount(user, user.token));
      }
    }
  } catch {
    /* ignore broken store */
  }
  return hadLegacyTokens;
}

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as {
      token?: string;
      userId?: string;
      issuedAt?: number;
    }[];
    for (const row of raw) {
      const token = String(row.token || "");
      const userId = String(row.userId || "");
      if (!token || !userId) continue;
      const user = findUserById(userId);
      if (!user) continue;
      if (isSessionExpired(row.issuedAt)) continue;
      user.token = token;
      user.tokenIssuedAt = row.issuedAt || Date.now();
      sessionsByToken.set(token, toAccount(user, token));
    }
  } catch {
    /* ignore */
  }
}

{
  const migrated = loadUsers();
  loadSessions();
  if (migrated) persistAuth();
}

export function normalizeUsername(input: string) {
  return stripControls(String(input || ""))
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function stripControls(value: string) {
  return value.replace(
    /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
    "",
  );
}

function validateUsername(username: string) {
  if (username.length < 3) {
    return "Имя от 3 символов";
  }
  if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    return "Только буквы, цифры, _ . -";
  }
  return null;
}

function normalizeDisplayName(input: string, fallback: string) {
  const value = stripControls(String(input || ""))
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
  return value || fallback;
}

function normalizeBio(input: string) {
  return stripControls(String(input || ""))
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, "hex");
  if (prev.length !== next.length) return false;
  return timingSafeEqual(prev, next);
}

type SessionRevokeHandler = (info: {
  userId: string;
  revokedToken: string;
}) => void;

let sessionRevokeHandler: SessionRevokeHandler | null = null;

export function onSessionRevoked(handler: SessionRevokeHandler) {
  sessionRevokeHandler = handler;
}

export function socketIdsForToken(token: string) {
  const ids: string[] = [];
  for (const [socketId, bound] of socketTokens.entries()) {
    if (bound === token) ids.push(socketId);
  }
  return ids;
}

function clearSession(user: StoredUser) {
  if (user.token) {
    const revokedToken = user.token;
    sessionsByToken.delete(user.token);
    sessionRevokeHandler?.({
      userId: user.id,
      revokedToken,
    });
  }
  user.token = undefined;
  user.tokenIssuedAt = undefined;
}

function issueSession(user: StoredUser): AuthAccount {
  clearSession(user);

  const token = randomUUID();
  const account = toAccount(user, token);
  user.token = token;
  user.tokenIssuedAt = Date.now();
  usersByName.set(user.username.toLowerCase(), user);
  sessionsByToken.set(token, account);
  persistAuth();
  return account;
}

function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD) {
    return `Пароль от ${MIN_PASSWORD} символов`;
  }
  if (password.length > MAX_PASSWORD) {
    return `Пароль не длиннее ${MAX_PASSWORD} символов`;
  }
  return null;
}

function refreshSessionsForUser(user: StoredUser) {
  if (!user.token) return;
  const account = toAccount(user, user.token);
  sessionsByToken.set(user.token, account);
}

/** Fixed dummy hash so missing-user logins still spend scrypt time. */
const LOGIN_DUMMY_HASH = hashPassword(
  "pulse-timing-pad",
  "0123456789abcdef0123456789abcdef",
);

function isPlausibleAvatarUrl(url: string) {
  const bare = String(url || "").split("?")[0].split("#")[0];
  // New: /uploads/uuid.ext · legacy: /uploads/uuid_name.ext
  return (
    /^\/uploads\/[0-9a-f-]{36}(?:_[^/\\]+)?\.(png|jpe?g|gif|webp)$/i.test(
      bare,
    ) &&
    !bare.includes("..") &&
    bare.length <= 240
  );
}

export function registerUser(usernameRaw: string, passwordRaw: string): AuthResult {
  const username = normalizeUsername(usernameRaw);
  const password = String(passwordRaw || "");
  const usernameError = validateUsername(username);
  if (usernameError) return { ok: false, error: usernameError };
  const passwordError = validatePassword(password);
  if (passwordError) return { ok: false, error: passwordError };
  if (usersByName.has(username.toLowerCase())) {
    return { ok: false, error: "Такой логин уже занят" };
  }

  const user: StoredUser = {
    id: randomUUID(),
    username,
    displayName: username,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
    bio: "",
  };
  usersByName.set(username.toLowerCase(), user);
  persistAuth();
  return { ok: true, account: issueSession(user) };
}

/** Creates demo accounts if missing (for local/demo deploys). */
export function ensureDemoUsers() {
  const demos: {
    username: string;
    password: string;
    displayName: string;
    bio: string;
  }[] = [
    {
      username: "artem",
      password: "Artem1234!",
      displayName: "Artem",
      bio: "",
    },
    {
      username: "alice",
      password: "Alice1234!",
      displayName: "Алиса",
      bio: "",
    },
    {
      username: "bob",
      password: "Bob12345!",
      displayName: "Боб",
      bio: "",
    },
    {
      username: "kirill",
      password: "Kirill123!",
      displayName: "Кирилл",
      bio: "",
    },
  ];

  let changed = false;
  for (const demo of demos) {
    const existing = usersByName.get(demo.username.toLowerCase());
    if (existing) {
      // Keep demo passwords predictable for shared try-out links.
      if (!verifyPassword(demo.password, existing.passwordHash)) {
        existing.passwordHash = hashPassword(demo.password);
        existing.displayName = demo.displayName;
        existing.bio = demo.bio;
        changed = true;
      }
      continue;
    }
    const user: StoredUser = {
      id: randomUUID(),
      username: demo.username,
      displayName: demo.displayName,
      passwordHash: hashPassword(demo.password),
      createdAt: Date.now(),
      bio: demo.bio,
    };
    usersByName.set(demo.username.toLowerCase(), user);
    changed = true;
  }
  if (changed) persistAuth();
  return demos.map(({ username, password, displayName }) => ({
    username,
    password,
    displayName,
  }));
}

export function loginUser(usernameRaw: string, passwordRaw: string): AuthResult {
  const username = normalizeUsername(usernameRaw);
  const password = String(passwordRaw || "");
  const user = usersByName.get(username.toLowerCase());
  if (!user) {
    verifyPassword(password, LOGIN_DUMMY_HASH);
    return { ok: false, error: "Неверный логин или пароль" };
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return { ok: false, error: "Неверный логин или пароль" };
  }
  return { ok: true, account: issueSession(user) };
}

export function restoreSession(token?: string): AuthResult {
  if (!token) return { ok: false, error: "Нет сессии" };

  const live = sessionsByToken.get(token);
  if (live) {
    const user = findUserById(live.userId);
    if (user && user.token === token) {
      if (isSessionExpired(user.tokenIssuedAt)) {
        clearSession(user);
        persistAuth();
        return { ok: false, error: "Сессия устарела" };
      }
      if (!user.tokenIssuedAt) {
        user.tokenIssuedAt = Date.now();
        persistAuth();
      }
      return { ok: true, account: toAccount(user, token) };
    }
    sessionsByToken.delete(token);
  }

  for (const user of usersByName.values()) {
    if (user.token === token) {
      if (isSessionExpired(user.tokenIssuedAt)) {
        clearSession(user);
        persistAuth();
        return { ok: false, error: "Сессия устарела" };
      }
      if (!user.tokenIssuedAt) {
        user.tokenIssuedAt = Date.now();
        persistAuth();
      }
      const account = toAccount(user, token);
      sessionsByToken.set(token, account);
      return { ok: true, account };
    }
  }

  return { ok: false, error: "Сессия устарела" };
}

export function updateProfile(
  userId: string,
  patch: {
    displayName?: string;
    bio?: string;
    avatarUrl?: string | null;
  },
): AuthResult {
  const user = findUserById(userId);
  if (!user) return { ok: false, error: "Пользователь не найден" };

  if (patch.displayName !== undefined) {
    const displayName = normalizeDisplayName(patch.displayName, user.username);
    if (displayName.length < 2) {
      return { ok: false, error: "Имя от 2 символов" };
    }
    user.displayName = displayName;
  }

  if (patch.bio !== undefined) {
    user.bio = normalizeBio(patch.bio);
  }

  if (patch.avatarUrl !== undefined) {
    if (patch.avatarUrl === null || patch.avatarUrl === "") {
      delete user.avatarUrl;
    } else if (
      typeof patch.avatarUrl === "string" &&
      isPlausibleAvatarUrl(patch.avatarUrl)
    ) {
      user.avatarUrl = patch.avatarUrl;
    } else {
      return { ok: false, error: "Некорректный аватар" };
    }
  }

  usersByName.set(user.username.toLowerCase(), user);
  refreshSessionsForUser(user);
  persistAuth();

  if (!user.token) {
    return {
      ok: true,
      account: toAccount(user, ""),
    };
  }

  return { ok: true, account: toAccount(user, user.token) };
}

export function bindSocketAuth(socketId: string, token: string) {
  socketTokens.set(socketId, token);
}

export function unbindSocketAuth(socketId: string) {
  socketTokens.delete(socketId);
}

export function getSocketAccount(socketId: string): AuthAccount | null {
  const token = socketTokens.get(socketId);
  if (!token) return null;
  const result = restoreSession(token);
  if (!result.ok) {
    socketTokens.delete(socketId);
    return null;
  }
  return result.account;
}

export function logoutToken(token?: string) {
  if (!token) return;
  sessionsByToken.delete(token);
  for (const [key, user] of usersByName.entries()) {
    if (user.token === token) {
      clearSession(user);
      usersByName.set(key, user);
      persistAuth();
      break;
    }
  }
}

export function getUserById(userId: string) {
  return findUserById(userId);
}

export function listUsers() {
  return [...usersByName.values()].map(toPublic);
}

export function getUsernameById(userId: string) {
  return getUserById(userId)?.username ?? "Пользователь";
}

export function getDisplayNameById(userId: string) {
  const user = getUserById(userId);
  if (!user) return "Пользователь";
  return displayOf(user);
}

export function touchLastSeen(userId: string) {
  const user = getUserById(userId);
  if (!user) return;
  user.lastSeenAt = Date.now();
  usersByName.set(user.username.toLowerCase(), user);
  saveUsers();
}
