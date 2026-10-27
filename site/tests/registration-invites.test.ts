import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const loader = createRequire(import.meta.url).resolve("tsx/cjs");
const authPath = fileURLToPath(new URL("../src/server/auth.ts", import.meta.url));
const invitesPath = fileURLToPath(new URL("../src/server/registrationInvites.ts", import.meta.url));
const createdAt = Date.UTC(2026, 9, 20, 10, 25);
const week = 7 * 86400000;

function fixture(t: TestContext) {
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-registration-"));
  t.after(() => {
    assert.equal(path.dirname(folder), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith("maiko-registration-"));
    rmSync(folder, { recursive: true, force: true });
  });
  mkdirSync(path.join(folder, "data"));
  writeFileSync(path.join(folder, "data/users.json"), JSON.stringify([
    { id: "real-artem", username: "Artem", passwordHash: "unused", createdAt },
    { id: "member", username: "member", passwordHash: "unused", createdAt },
  ]));
  return folder;
}

function run(folder: string, body: string) {
  execFileSync(process.execPath, ["--require", loader, "-e", `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    Date.now = () => ${createdAt + 1000};
    const auth = require(${JSON.stringify(authPath)});
    const invites = require(${JSON.stringify(invitesPath)});
    ${body}
  `], { cwd: folder, windowsHide: true, encoding: "utf8", timeout: 20000 });
}

test("registration requires a current member code by default and records the inviter", t => {
  const folder = fixture(t);
  run(folder, `
    assert.deepEqual(invites.registrationPolicy(), {required:true});
    const member = auth.getUserById('member');
    const code = invites.memberRegistrationInvite(member).code;
    assert.match(code, /^[A-F0-9]{4}(-[A-F0-9]{4}){4}$/);
    for (const input of [undefined, null, {}, '', 'BAD', 'a'.repeat(1000)]) {
      assert.equal(auth.registerUser('new-user','Password123!', 'ip', input).ok, false);
    }
    const result = auth.registerUser('new-user','Password123!', 'ip', ' '+code.toLowerCase()+' ');
    assert.equal(result.ok,true,result.error);
    assert.equal(auth.getUserById(result.account.userId).invitedBy,'member');
    assert.equal(auth.listUsers().find(u=>u.id===result.account.userId).invitedBy,undefined);
    assert.equal(invites.memberRegistrationInvite(auth.getUserById(result.account.userId)).expiresAt, Date.now()+${week});
    fs.writeFileSync('code.txt',code);
  `);
  run(folder, `
    const code = fs.readFileSync('code.txt','utf8');
    assert.equal(invites.memberRegistrationInvite(auth.getUserById('member')).code,code);
    assert.equal(auth.registerUser('after-restart','Password123!',undefined,code).ok,true);
    const user = JSON.parse(fs.readFileSync('data/users.json')).find(u=>u.username==='new-user');
    assert.equal(user.invitedBy,'member');
  `);
});

test("codes rotate exactly after seven days and cannot be used by a deleted member", t => {
  run(fixture(t), `
    const members = [auth.getUserById('member'),auth.getUserById('real-artem')];
    const start = ${createdAt};
    const first = invites.memberRegistrationInvite(members[0],start);
    assert.equal(first.expiresAt,start+${week});
    for (let day = 0; day < 7; day++) assert.equal(invites.memberRegistrationInvite(members[0],start+day*86400000).code,first.code);
    assert.equal(invites.memberRegistrationInvite(members[0],first.expiresAt-1).code,first.code);
    const next = invites.memberRegistrationInvite(members[0],first.expiresAt);
    assert.notEqual(next.code,first.code);
    assert.equal(next.expiresAt,first.expiresAt+${week});
    assert.equal(invites.registrationInviter(first.code,members,first.expiresAt),null);
    assert.equal(invites.registrationInviter(next.code,members,first.expiresAt).id,'member');
    assert.equal(invites.registrationInviter(next.code,[members[1]],first.expiresAt),null);
    assert.notEqual(invites.memberRegistrationInvite(members[1],start).code,first.code);
  `);
});

test("only the pinned Artem account can toggle registration, including after rename and restart", t => {
  const folder = fixture(t);
  run(folder, `
    assert.equal(invites.setRegistrationPolicy('member',false).ok,false);
    assert.equal(invites.setRegistrationPolicy('real-artem','false').ok,false);
    assert.equal(invites.setRegistrationPolicy('real-artem',false).ok,true);
    assert.equal(auth.registerUser('open-user','Password123!').ok,true);
    assert.equal(auth.updateProfile('real-artem',{username:'renamed'}).ok,true);
    const impostor=auth.registerUser('artem','Password123!');
    assert.equal(impostor.ok,true);
    assert.equal(invites.canManageRegistration(impostor.account.userId),false);
    assert.equal(invites.canManageRegistration('real-artem'),true);
  `);
  run(folder, `
    assert.equal(invites.registrationPolicy().required,false);
    assert.equal(invites.canManageRegistration('real-artem'),true);
    assert.equal(invites.canManageRegistration(auth.listUsers().find(u=>u.username==='artem').id),false);
    assert.equal(invites.setRegistrationPolicy('real-artem',true).ok,true);
    assert.equal(auth.registerUser('closed-user','Password123!').ok,false);
  `);
});

test("corrupt settings fail closed without enabling public registration", t => {
  const folder = fixture(t);
  writeFileSync(path.join(folder,"data/registration-invites.json"), '{"required":false}');
  assert.throws(() => run(folder, ""), /Invalid registration invite settings/);
});
