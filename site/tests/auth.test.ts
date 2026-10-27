import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const loader = require.resolve("tsx/cjs");
const authFile = fileURLToPath(new URL("../src/server/auth.ts", import.meta.url));
const ttl = 30 * 24 * 60 * 60 * 1000;

function fixture(t: TestContext) {
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-auth-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith("maiko-auth-test-"));
    rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

// Every invocation loads auth in a fresh process with disposable storage.
function runAuth(folder: string, body: string): void {
  execFileSync(process.execPath, ["--require", loader, "-e", `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    fs.mkdirSync('data', { recursive: true });
    if (!fs.existsSync('data/registration-invites.json')) fs.writeFileSync('data/registration-invites.json', JSON.stringify({ required: false, adminUserId: null, secret: 'a'.repeat(64) }));
    const auth = require(${JSON.stringify(authFile)});
    const sessions = () => JSON.parse(fs.readFileSync('data/sessions.json', 'utf8'));
    const account = result => { assert.equal(result.ok, true, result.error); return result.account; };
    ${body}
  `], { cwd: folder, encoding: "utf8", windowsHide: true, timeout: 15_000 });
}

test("invalid registrations and occupied names cannot exhaust the account creation quota", t => {
  runAuth(fixture(t), `
    const ip = 'registration-test-ip';
    const now = Date.now();
    for (let i = 0; i < 40; i++) assert.equal(auth.registerUser('', '', ip).ok, false);
    account(auth.registerUser('quota-one', 'Password123!', ip));
    for (let i = 0; i < 20; i++) assert.match(auth.registerUser('quota-one', 'Password123!', ip).error, /занят/);
    account(auth.registerUser('quota-two', 'Password123!', ip));
    account(auth.registerUser('quota-three', 'Password123!', ip));
    assert.match(auth.registerUser('quota-four', 'Password123!', ip).error, /Лимит/);
    Date.now = () => now + 61_000;
    account(auth.registerUser('quota-four', 'Password123!', ip));
    assert.equal(auth.authCredentialsError({}, 'Password123!'), 'Введите логин и пароль');
    assert.ok(auth.authCredentialsError('quota-one', 'x'.repeat(129)));
  `);
});

test("multiple logins survive restart; logout revokes only its token", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const first = account(auth.registerUser('multi-user', 'Password123!'));
    auth.bindSocketAuth('first', first.token);
    const revoked = [];
    auth.onSessionRevoked(info => revoked.push(info));
    const second = account(auth.loginUser('multi-user', 'Password123!'));
    const third = account(auth.loginUser('multi-user', 'Password123!'));
    auth.bindSocketAuth('second', second.token);
    assert.equal(new Set([first.token, second.token, third.token]).size, 3);
    assert.equal(revoked.length, 0);
    assert.equal(auth.getSocketAccount('first').token, first.token);
    assert.equal(auth.getSocketAccount('second').token, second.token);
    assert.equal(auth.loginUser('multi-user', 'wrong-password').ok, false);
    assert.equal(sessions().length, 3);
    fs.writeFileSync('tokens.json', JSON.stringify({first, second, third}));
  `);
  runAuth(folder, `
    const {first, second, third} = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));
    for (const original of [first, second, third]) {
      assert.deepEqual(account(auth.restoreSession(original.token)), { ...original, avatarUrl: original.avatarUrl });
    }
    auth.bindSocketAuth('first', first.token);
    auth.bindSocketAuth('first-tab', first.token);
    auth.bindSocketAuth('second', second.token);
    const revoked = [];
    auth.onSessionRevoked(info => revoked.push(info));
    auth.logoutToken(first.token);
    assert.deepEqual(revoked, [{userId: first.userId, revokedToken: first.token}]);
    assert.equal(auth.restoreSession(first.token).ok, false);
    assert.equal(auth.getSocketAccount('first'), null);
    assert.equal(auth.getSocketAccount('first-tab'), null);
    assert.equal(auth.getSocketAccount('second').token, second.token);
    assert.equal(account(auth.restoreSession(third.token)).token, third.token);
    auth.logoutToken(first.token);
    auth.logoutToken('unknown-token');
    auth.logoutToken();
    assert.equal(revoked.length, 1);
    assert.equal(sessions().length, 2);
  `);
  runAuth(folder, `
    const {first, second, third} = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));
    assert.equal(auth.restoreSession(first.token).ok, false);
    assert.equal(account(auth.restoreSession(second.token)).userId, second.userId);
    assert.equal(account(auth.restoreSession(third.token)).userId, third.userId);
  `);
});

test("profile edits preserve the requesting token and update every session", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const first = account(auth.registerUser('profile-user', 'Password123!'));
    const second = account(auth.loginUser('profile-user', 'Password123!'));
    const other = account(auth.registerUser('another-user', 'Password123!'));
    auth.bindSocketAuth('second', second.token);
    const avatarUrl = '/uploads/12345678-1234-1234-1234-123456789abc.png';
    const updated = account(auth.updateProfile(first.userId, {
      displayName: 'New name', bio: 'New bio', avatarUrl,
    }, first.token));
    assert.equal(updated.token, first.token);
    for (const token of [first.token, second.token]) {
      const restored = account(auth.restoreSession(token));
      assert.equal(restored.token, token);
      assert.equal(restored.displayName, 'New name');
      assert.equal(restored.username, 'profile-user');
      assert.equal(restored.bio, 'New bio');
      assert.equal(restored.avatarUrl, avatarUrl);
    }
    assert.equal(auth.getSocketAccount('second').displayName, 'New name');
    assert.equal(account(auth.updateProfile(first.userId, { bio: 'Second edit' }, second.token)).token, second.token);
    assert.equal(auth.updateProfile(first.userId, { bio: 'Forbidden' }, other.token).ok, false);
    auth.logoutToken(first.token);
    assert.equal(auth.updateProfile(first.userId, { bio: 'Expired' }, first.token).ok, false);
    assert.equal(account(auth.restoreSession(second.token)).bio, 'Second edit');
    assert.equal(account(auth.restoreSession(other.token)).bio, '');
  `);
  runAuth(folder, `
    const token = sessions().find(row => account(auth.restoreSession(row.token)).username === 'profile-user').token;
    assert.equal(account(auth.restoreSession(token)).bio, 'Second edit');
  `);
});

test("nickname changes preserve identity and sessions, validate uniqueness and survive restart", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const first = account(auth.registerUser('old-nickname', 'Password123!'));
    const second = account(auth.loginUser('old-nickname', 'Password123!'));
    const other = account(auth.registerUser('occupied', 'Password123!'));
    auth.bindSocketAuth('second', second.token);
    const updated = account(auth.updateProfile(first.userId, { username: ' @New.Name ' }, first.token));
    assert.equal(updated.username, 'New.Name');
    assert.equal(updated.userId, first.userId);
    assert.equal(updated.token, first.token);
    assert.equal(updated.displayName, first.displayName);
    assert.equal(auth.loginUser('old-nickname', 'Password123!').ok, false);
    assert.equal(account(auth.loginUser('NEW.NAME', 'Password123!')).userId, first.userId);
    for (const token of [first.token, second.token]) {
      assert.equal(account(auth.restoreSession(token)).username, 'New.Name');
    }
    assert.equal(auth.getSocketAccount('second').username, 'New.Name');
    assert.equal(auth.listUsers().filter(user => user.id === first.userId).length, 1);
    const before = fs.readFileSync('data/users.json', 'utf8');
    for (const username of ['OCCUPIED', '', 'ab', 'a'.repeat(25), 'has space', '@@invalid', 'bad/name', null, 123]) {
      const rejected = auth.updateProfile(first.userId, { username, bio: 'must not save' }, first.token);
      assert.equal(rejected.ok, false, String(username));
      assert.equal(account(auth.restoreSession(first.token)).username, 'New.Name');
      assert.equal(account(auth.restoreSession(first.token)).bio, '');
      assert.equal(fs.readFileSync('data/users.json', 'utf8'), before);
    }
    assert.equal(auth.updateProfile(first.userId, { username: 'stolen' }, other.token).ok, false);
    assert.equal(account(auth.updateProfile(first.userId, { username: 'new.name' }, second.token)).username, 'new.name');
    assert.equal(auth.listUsers().filter(user => user.id === first.userId).length, 1);
    fs.writeFileSync('rename.json', JSON.stringify({ first, second }));
  `);
  runAuth(folder, `
    const {first, second} = JSON.parse(fs.readFileSync('rename.json', 'utf8'));
    for (const token of [first.token, second.token]) {
      assert.equal(account(auth.restoreSession(token)).username, 'new.name');
    }
    assert.equal(auth.loginUser('old-nickname', 'Password123!').ok, false);
    assert.equal(account(auth.loginUser('new.name', 'Password123!')).userId, first.userId);
    assert.equal(auth.listUsers().filter(user => user.id === first.userId).length, 1);
    assert.equal(account(auth.registerUser('old-nickname', 'Password123!')).username, 'old-nickname');
  `);
});

test("failed nickname persistence restores the previous name and login index", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const first = account(auth.registerUser('before-save', 'Password123!'));
    const write = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk unavailable'); };
    try {
      assert.throws(() => auth.updateProfile(first.userId, { username: 'after-save' }, first.token), /disk unavailable/);
    } finally { fs.writeFileSync = write; }
    assert.equal(account(auth.restoreSession(first.token)).username, 'before-save');
    assert.equal(auth.loginUser('after-save', 'Password123!').ok, false);
    assert.equal(account(auth.loginUser('before-save', 'Password123!')).userId, first.userId);
    assert.equal(auth.listUsers().filter(user => user.id === first.userId).length, 1);
  `);
});

test("sessions expire independently and cannot return after restart", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const now = Date.now();
    Date.now = () => now;
    const first = account(auth.registerUser('expiry-user', 'Password123!'));
    Date.now = () => now + 24 * 60 * 60 * 1000;
    const second = account(auth.loginUser('expiry-user', 'Password123!'));
    const revoked = [];
    auth.onSessionRevoked(info => revoked.push(info.revokedToken));
    Date.now = () => now + ${ttl} + 1;
    assert.equal(auth.restoreSession(first.token).ok, false);
    assert.equal(account(auth.restoreSession(second.token)).token, second.token);
    assert.deepEqual(revoked, [first.token]);
    assert.deepEqual(sessions().map(row => row.token), [second.token]);
    fs.writeFileSync('tokens.json', JSON.stringify({first, second}));
  `);
  runAuth(folder, `
    const {first, second} = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));
    assert.equal(auth.restoreSession(first.token).ok, false);
    assert.equal(account(auth.restoreSession(second.token)).token, second.token);
  `);
});

test("legacy tokens and existing session rows migrate without losing active sessions", t => {
  const folder = fixture(t);
  mkdirSync(path.join(folder, "data"));
  const now = Date.now();
  const user = { id: "legacy-user", username: "legacy", passwordHash: "unused", createdAt: now };
  writeFileSync(path.join(folder, "data/users.json"), JSON.stringify([
    { ...user, token: "legacy-token", tokenIssuedAt: now },
    { ...user, id: "expired-user", username: "expired", token: "expired-token", tokenIssuedAt: now - ttl - 1000 },
  ]));
  writeFileSync(path.join(folder, "data/sessions.json"), JSON.stringify([
    { token: "saved-first", userId: user.id, issuedAt: now - 1000 },
    { token: "saved-second", userId: user.id, issuedAt: now },
    { token: "no-date", userId: user.id },
    { token: "expired-row", userId: user.id, issuedAt: now - ttl - 1000 },
    { token: "missing-user", userId: "missing", issuedAt: now },
  ]));
  const verify = `
    for (const token of ['legacy-token', 'saved-first', 'saved-second', 'no-date']) {
      assert.equal(account(auth.restoreSession(token)).userId, 'legacy-user');
    }
    for (const token of ['expired-token', 'expired-row', 'missing-user']) {
      assert.equal(auth.restoreSession(token).ok, false);
    }
    assert.equal(auth.restoreSession().ok, false);
    const users = JSON.parse(fs.readFileSync('data/users.json', 'utf8'));
    assert.ok(users.every(user => !('token' in user) && !('tokenIssuedAt' in user)));
    assert.equal(sessions().length, 4);
  `;
  runAuth(folder, verify);
  runAuth(folder, verify);
});
