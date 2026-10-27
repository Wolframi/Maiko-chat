import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { weeklyGroupInviteCode, normalizeGroupInviteCode } from "../src/server/groupInviteCode";

test("weekly codes expire exactly on Monday at midnight in Yekaterinburg and are bound to the group", () => {
  const secret = "a".repeat(64);
  const midnight = Date.UTC(2026, 9, 18, 19);
  const previous = weeklyGroupInviteCode("private-one", midnight - 1, secret);
  assert.match(previous.code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$/);
  assert.equal(previous.expiresAt, midnight);
  assert.equal(previous.code, weeklyGroupInviteCode("private-one", midnight - 20 * 60 * 60 * 1000, secret).code);
  const next = weeklyGroupInviteCode("private-one", midnight, secret);
  assert.notEqual(previous.code, next.code);
  assert.equal(next.expiresAt, midnight + 7 * 24 * 60 * 60 * 1000);
  for (let day = 0; day < 7; day++) {
    assert.deepEqual(weeklyGroupInviteCode("private-one", midnight + day * 86400000, secret), { ...next, serverTime: midnight + day * 86400000 });
  }
  assert.notEqual(next.code, weeklyGroupInviteCode("private-one", next.expiresAt, secret).code);
  assert.notEqual(next.code, weeklyGroupInviteCode("private-two", midnight, secret).code);
  assert.equal(normalizeGroupInviteCode(` ${next.code.toLowerCase()} `), next.code.replaceAll("-", ""));
});

test("private invitations check membership, reject last week's code and survive restart", t => {
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-group-code-"));
  t.after(() => {
    assert.equal(path.dirname(folder), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith("maiko-group-code-"));
    rmSync(folder, { recursive: true, force: true });
  });
  const loader = createRequire(import.meta.url).resolve("tsx/cjs");
  const auth = fileURLToPath(new URL("../src/server/auth.ts", import.meta.url));
  const chats = fileURLToPath(new URL("../src/server/chats.ts", import.meta.url));
  const run = (body: string) => execFileSync(process.execPath, ["--require", loader, "-e", `
    const assert=require('node:assert/strict');const fs=require('node:fs');
    fs.mkdirSync('data', { recursive: true });
    if (!fs.existsSync('data/registration-invites.json')) fs.writeFileSync('data/registration-invites.json', JSON.stringify({ required: false, adminUserId: null, secret: 'a'.repeat(64) }));
    const auth=require(${JSON.stringify(auth)});const chats=require(${JSON.stringify(chats)});
    const account=result=>{assert.equal(result.ok,true,result.error);return result.account;};
    ${body}
  `], { cwd: folder, encoding: "utf8", windowsHide: true, timeout: 20000 });
  run(`
    const midnight=Date.UTC(2026,9,18,19);
    let now=midnight-1000;Date.now=()=>now;
    const owner=account(auth.registerUser('code-owner','Password123!'));
    const guest=account(auth.registerUser('code-guest','Password123!'));
    const later=account(auth.registerUser('code-later','Password123!'));
    const group=chats.createGroup(owner.userId,'Hidden group','',[],'private').chat;
    const before=chats.getGroupInviteCode(group.id,owner.userId,now);
    assert.equal(before.ok,true);
    assert.equal(chats.getGroupInviteCode(group.id,guest.userId,now).ok,false);
    assert.equal(chats.joinPublicGroup(guest.userId,group.id).ok,false);
    assert.equal(chats.searchPublicGroups(guest.userId,'').length,0);
    assert.equal(chats.joinGroupByCode(guest.userId,'AAAAAAAAAAAA',now).ok,false);
    assert.equal(chats.joinGroupByCode(guest.userId,before.invite.code.toLowerCase(),now).ok,true);
    assert.equal(chats.getGroupInviteCode(group.id,guest.userId,now).invite.code,before.invite.code);
    now=midnight;
    assert.equal(chats.joinGroupByCode(later.userId,before.invite.code,now).ok,false);
    const current=chats.getGroupInviteCode(group.id,owner.userId,now).invite;
    assert.notEqual(current.code,before.invite.code);
    assert.equal(chats.joinGroupByCode(later.userId,current.code,now).ok,true);
    assert.equal(chats.joinGroupByCode(later.userId,current.code,now).already,true);
    assert.equal(group.memberIds.length,3);
    assert.match(fs.readFileSync('data/group-invite-secret.txt','utf8'),/^[a-f0-9]{64}$/);
    fs.writeFileSync('state.json',JSON.stringify({owner,groupId:group.id,current,now}));
  `);
  run(`
    const state=JSON.parse(fs.readFileSync('state.json','utf8'));Date.now=()=>state.now;
    const current=chats.getGroupInviteCode(state.groupId,state.owner.userId,state.now);
    assert.equal(current.invite.code,state.current.code);
    const guest=account(auth.registerUser('over-capacity','Password123!'));
    const group=chats.getChat(state.groupId);
    group.memberIds=[state.owner.userId,...Array.from({length:49},(_,i)=>'fixture-'+i)];
    assert.equal(chats.joinGroupByCode(guest.userId,current.invite.code,state.now).ok,false);
    assert.equal(chats.deleteGroup(state.groupId,state.owner.userId).ok,true);
    assert.equal(chats.joinGroupByCode(guest.userId,current.invite.code,state.now).ok,false);
  `);
});
