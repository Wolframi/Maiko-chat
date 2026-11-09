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
function runAuth(folder: string, body: string, setup = ""): void {
  execFileSync(process.execPath, ["--require", loader, "-e", `
    (async () => {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    fs.mkdirSync('data', { recursive: true });
    if (!fs.existsSync('data/registration-invites.json')) fs.writeFileSync('data/registration-invites.json', JSON.stringify({ required: false, adminUserId: null, secret: 'a'.repeat(64) }));
    ${setup}
    const auth = require(${JSON.stringify(authFile)});
    const sessions = () => JSON.parse(fs.readFileSync('data/sessions.json', 'utf8'));
    const account = result => { assert.equal(result.ok, true, result.error); return result.account; };
    ${body}
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: folder, encoding: "utf8", windowsHide: true, timeout: 15_000 });
}

test("invalid registrations and occupied names cannot exhaust the account creation quota", t => {
  runAuth(fixture(t), `
    const ip = 'registration-test-ip';
    const now = Date.now();
    for (let i = 0; i < 40; i++) assert.equal((await auth.registerUser('', '', ip)).ok, false);
    account((await auth.registerUser('quota-one', 'Password123!', ip)));
    for (let i = 0; i < 20; i++) assert.match((await auth.registerUser('quota-one', 'Password123!', ip)).error, /занят/);
    account((await auth.registerUser('quota-two', 'Password123!', ip)));
    account((await auth.registerUser('quota-three', 'Password123!', ip)));
    assert.match((await auth.registerUser('quota-four', 'Password123!', ip)).error, /Лимит/);
    Date.now = () => now + 61_000;
    account((await auth.registerUser('quota-four', 'Password123!', ip)));
    assert.equal(auth.authCredentialsError({}, 'Password123!'), 'Введите логин и пароль');
    assert.ok(auth.authCredentialsError('quota-one', 'x'.repeat(129)));
  `);
});

test("password derivation lets the event loop run during registration and login", t => {
  runAuth(fixture(t), `
    const yields = async operation => {
      let completed = false;
      const pending = operation().then(result => { completed = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(completed, false, 'password derivation must yield to other work');
      return pending;
    };
    account(await yields(() => auth.registerUser('async-user', 'Password123!')));
    account(await yields(() => auth.loginUser('async-user', 'Password123!')));
    assert.equal((await yields(() => auth.loginUser('async-user', 'wrong-password'))).ok, false);
    assert.equal((await yields(() => auth.loginUser('missing-user', 'Password123!'))).ok, false);
    assert.equal(sessions().length, 2);
  `);
});

test("concurrent registrations preserve one account and do not exhaust the creation quota", t => {
  runAuth(fixture(t), `
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      auth.registerUser(i % 2 ? 'Race-User' : 'race-user', 'Password123!', 'race-ip')));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.ok(results.filter(result => !result.ok).every(result => /занят/.test(result.error)));
    const winner = account(results.find(result => result.ok));
    assert.equal(account(await auth.loginUser('RACE-USER', 'Password123!')).userId, winner.userId);
    account(await auth.registerUser('race-two', 'Password123!', 'race-ip'));
    account(await auth.registerUser('race-three', 'Password123!', 'race-ip'));
    assert.match((await auth.registerUser('race-four', 'Password123!', 'race-ip')).error, /Лимит/);
    const users = JSON.parse(fs.readFileSync('data/users.json', 'utf8'));
    assert.equal(users.filter(user => user.username.toLowerCase() === 'race-user').length, 1);
  `);
});

test("registration cannot overwrite a name claimed by a profile edit while hashing", t => {
  runAuth(fixture(t), `
    const first = account(await auth.registerUser('rename-source', 'Password123!'));
    const pending = auth.registerUser('rename-target', 'OtherPassword123!');
    account(auth.updateProfile(first.userId, { username: 'rename-target' }, first.token));
    assert.match((await pending).error, /занят/);
    assert.equal(account(await auth.loginUser('rename-target', 'Password123!')).userId, first.userId);
  `);
});

test("async passwords remain compatible with existing scrypt hashes", t => {
  const folder = fixture(t);
  mkdirSync(path.join(folder, "data"));
  writeFileSync(path.join(folder, "data/users.json"), JSON.stringify([{
    id: "legacy-password", username: "legacy-password", createdAt: Date.now(),
    passwordHash: "0123456789abcdef0123456789abcdef:58477333fd8923d094d7821847edd4f1cc0c980195a964ac280ed0f97f33e8ad7324e3a15ae683c9262de3a8e69ca7642881debf3aaa601cc87397c410d8b175",
  }]));
  runAuth(folder, `
    assert.equal(account(await auth.loginUser('legacy-password', 'pulse-timing-pad')).userId, 'legacy-password');
    assert.equal((await auth.loginUser('legacy-password', 'wrong-password')).ok, false);
    account(await auth.registerUser('new-password', 'Password123!'));
    const { passwordHash } = JSON.parse(fs.readFileSync('data/users.json', 'utf8')).find(user => user.username === 'new-password');
    const [salt, hash] = passwordHash.split(':');
    assert.equal(salt.length, 32);
    assert.equal(hash, require('node:crypto').scryptSync('Password123!', salt, 64).toString('hex'));
  `);
});

test("demo passwords are ready after seeding and existing accounts are reused", t => {
  runAuth(fixture(t), `
    const demos = await auth.ensureDemoUsers();
    const first = account(await auth.loginUser(demos[0].username, demos[0].password));
    assert.deepEqual(await auth.ensureDemoUsers(), demos);
    assert.equal(auth.listUsers().length, demos.length);
    assert.equal(account(await auth.loginUser(demos[0].username, demos[0].password)).userId, first.userId);
  `);
});

test("multiple logins survive restart; logout revokes only its token", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const first = account((await auth.registerUser('multi-user', 'Password123!')));
    auth.bindSocketAuth('first', first.token);
    const revoked = [];
    auth.onSessionRevoked(info => revoked.push(info));
    const second = account((await auth.loginUser('multi-user', 'Password123!')));
    const third = account((await auth.loginUser('multi-user', 'Password123!')));
    auth.bindSocketAuth('second', second.token);
    assert.equal(new Set([first.token, second.token, third.token]).size, 3);
    assert.equal(revoked.length, 0);
    assert.equal(auth.getSocketAccount('first').token, first.token);
    assert.equal(auth.getSocketAccount('second').token, second.token);
    assert.equal((await auth.loginUser('multi-user', 'wrong-password')).ok, false);
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
    const first = account((await auth.registerUser('profile-user', 'Password123!')));
    const second = account((await auth.loginUser('profile-user', 'Password123!')));
    const other = account((await auth.registerUser('another-user', 'Password123!')));
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
    const first = account((await auth.registerUser('old-nickname', 'Password123!')));
    const second = account((await auth.loginUser('old-nickname', 'Password123!')));
    const other = account((await auth.registerUser('occupied', 'Password123!')));
    auth.bindSocketAuth('second', second.token);
    const updated = account(auth.updateProfile(first.userId, { username: ' @New.Name ' }, first.token));
    assert.equal(updated.username, 'New.Name');
    assert.equal(updated.userId, first.userId);
    assert.equal(updated.token, first.token);
    assert.equal(updated.displayName, first.displayName);
    assert.equal((await auth.loginUser('old-nickname', 'Password123!')).ok, false);
    assert.equal(account((await auth.loginUser('NEW.NAME', 'Password123!'))).userId, first.userId);
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
    assert.equal((await auth.loginUser('old-nickname', 'Password123!')).ok, false);
    assert.equal(account((await auth.loginUser('new.name', 'Password123!'))).userId, first.userId);
    assert.equal(auth.listUsers().filter(user => user.id === first.userId).length, 1);
    assert.equal(account((await auth.registerUser('old-nickname', 'Password123!'))).username, 'old-nickname');
  `);
});

test("failed nickname persistence restores the previous name and login index", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const first = account((await auth.registerUser('before-save', 'Password123!')));
    const write = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk unavailable'); };
    try {
      assert.throws(() => auth.updateProfile(first.userId, { username: 'after-save' }, first.token), /disk unavailable/);
    } finally { fs.writeFileSync = write; }
    assert.equal(account(auth.restoreSession(first.token)).username, 'before-save');
    assert.equal((await auth.loginUser('after-save', 'Password123!')).ok, false);
    assert.equal(account((await auth.loginUser('before-save', 'Password123!'))).userId, first.userId);
    assert.equal(auth.listUsers().filter(user => user.id === first.userId).length, 1);
  `);
});

test("sessions expire independently and cannot return after restart", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const now = Date.now();
    Date.now = () => now;
    const first = account((await auth.registerUser('expiry-user', 'Password123!')));
    Date.now = () => now + 24 * 60 * 60 * 1000;
    const second = account((await auth.loginUser('expiry-user', 'Password123!')));
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

test("device sessions keep login details private, enforce ownership and persist remote logout", t => {
  const folder = fixture(t);
  runAuth(folder, `
    const first = account(await auth.registerUser('devices-user', 'Password123!'));
    const second = account(await auth.loginUser('devices-user', 'Password123!'));
    const other = account(await auth.registerUser('devices-other', 'Password123!'));
    await auth.recordSessionAccess(first.token, {ip:'8.8.8.8',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36'});
    await auth.recordSessionAccess(second.token, {ip:'192.168.1.2',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1'});
    // Reconnects do not replace the original device or location.
    await auth.recordSessionAccess(first.token, {ip:'1.1.1.1',userAgent:'Changed'});
    const list = auth.listDeviceSessions(first.token);
    assert.equal(list.ok, true);
    assert.equal(list.sessions.length, 2);
    assert.equal(list.sessions[0].current, true);
    assert.equal(list.sessions[0].ip, '8.8.8.8');
    assert.equal(list.sessions[0].browser, 'Chrome');
    assert.equal(list.sessions[0].os, 'Windows');
    assert.match(list.sessions[0].location, /Екатеринбург/);
    const mobile = list.sessions.find(row => !row.current);
    assert.equal(mobile.os, 'iOS');
    assert.equal(mobile.device, 'mobile');
    assert.equal(mobile.location, 'Локальная или частная сеть');
    assert.ok(!JSON.stringify(list).includes(first.token));
    assert.ok(!JSON.stringify(list).includes(second.token));
    assert.ok(list.sessions.every(row => !('userAgent' in row) && !('userId' in row) && !('token' in row)));
    assert.equal(auth.listDeviceSessions('unknown').ok, false);
    assert.equal(auth.revokeDeviceSession(other.token, mobile.id).ok, false);
    assert.equal(auth.revokeDeviceSession(first.token, list.sessions[0].id).ok, false);
    for (const id of [null, {}, second.token, 'x'.repeat(500)]) assert.equal(auth.revokeDeviceSession(first.token, id).ok, false);
    fs.writeFileSync('devices.json', JSON.stringify({first,second,other,mobileId:mobile.id}));
  `, `global.fetch = async () => ({ ok: true, json: async () => ({ success: true, city: 'Екатеринбург', region: 'Свердловская область', country: 'Россия' }) });`);
  runAuth(folder, `
    const {first,second,other,mobileId} = JSON.parse(fs.readFileSync('devices.json','utf8'));
    assert.equal(auth.listDeviceSessions(first.token).sessions[0].ip, '8.8.8.8');
    assert.equal(auth.listDeviceSessions(second.token).sessions[0].id, mobileId);
    const revoked = [];
    auth.onSessionRevoked(info => revoked.push(info.revokedToken));
    assert.equal(auth.revokeDeviceSession(first.token, mobileId).ok, true);
    assert.deepEqual(revoked, [second.token]);
    assert.equal(auth.restoreSession(second.token).ok, false);
    assert.equal(auth.restoreSession(first.token).ok, true);
    assert.equal(auth.restoreSession(other.token).ok, true);
  `);
  runAuth(folder, `
    const {first,second,other} = JSON.parse(fs.readFileSync('devices.json','utf8'));
    assert.equal(auth.restoreSession(second.token).ok, false);
    const third = account(await auth.loginUser('devices-user', 'Password123!'));
    const fourth = account(await auth.loginUser('devices-user', 'Password123!'));
    const revoked = [];
    auth.onSessionRevoked(info => revoked.push(info.revokedToken));
    const result = auth.revokeOtherDeviceSessions(first.token);
    assert.equal(result.ok, true);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].current, true);
    assert.deepEqual(revoked, [third.token, fourth.token]);
    assert.equal(auth.restoreSession(other.token).ok, true);
    assert.equal(auth.revokeOtherDeviceSessions('unknown').ok, false);
  `);
});

test("device revocation rolls back if saving sessions fails", t => {
  runAuth(fixture(t), `
    const first = account(await auth.registerUser('device-save', 'Password123!'));
    const second = account(await auth.loginUser('device-save', 'Password123!'));
    const id = auth.listDeviceSessions(first.token).sessions.find(row => !row.current).id;
    auth.restoreSession(second.token);
    const revoked = [];
    auth.onSessionRevoked(info => revoked.push(info.revokedToken));
    const write = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('disk unavailable'); };
    try {
      assert.throws(() => auth.revokeDeviceSession(first.token, id), /disk unavailable/);
      assert.throws(() => auth.revokeOtherDeviceSessions(first.token), /disk unavailable/);
    } finally { fs.writeFileSync = write; }
    assert.equal(auth.restoreSession(second.token).ok, true);
    assert.deepEqual(revoked, []);
  `);
});
