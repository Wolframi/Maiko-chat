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
    const auth = require(${JSON.stringify(authFile)});
    const sessions = () => JSON.parse(fs.readFileSync('data/sessions.json', 'utf8'));
    const account = result => { assert.equal(result.ok, true, result.error); return result.account; };
    ${body}
  `], { cwd: folder, encoding: "utf8", windowsHide: true, timeout: 15_000 });
}

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
