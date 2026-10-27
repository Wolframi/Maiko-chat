import assert from "node:assert/strict";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

test("Socket.IO enforces invite registration, admin rights and live policy updates", { timeout: 120000 }, async () => {
  const server = await securityServer({ registrationRequired: true });
  const clients: Socket[] = [];
  const emit = (socket: Socket, event: string, payload: unknown): Promise<any> => socket.timeout(10000).emitWithAck(event, payload);
  const connect = async () => {
    const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false });
    clients.push(socket);
    await new Promise<void>((resolve,reject) => { socket.once("connect",resolve); socket.once("connect_error",reject); });
    return socket;
  };
  try {
    const admin = await connect(), member = await connect(), guest = await connect();
    assert.equal((await emit(guest,"registration:invite",{})).ok,false);
    assert.equal((await emit(guest,"registration:configure",{required:false})).ok,false);
    assert.equal((await emit(admin,"auth:restore",{token:server.token})).ok,true);
    assert.equal((await emit(member,"auth:login",{username:"seeduser1",password:server.password})).ok,true);
    assert.equal((await emit(member,"registration:configure",{required:false})).ok,false);
    const invitation = await emit(member,"registration:invite",{});
    assert.equal(invitation.ok,true);
    assert.equal(invitation.canManage,false);
    assert.equal((await emit(admin,"registration:invite",{})).canManage,true);
    for (const invitationCode of [undefined,"BAD",{code:invitation.code}]) {
      assert.equal((await emit(guest,"auth:register",{username:"newguest",password:server.password,invitationCode})).ok,false);
    }
    assert.equal((await emit(guest,"auth:register",{username:"newguest",password:server.password,invitationCode:invitation.code})).ok,true);
    assert.equal((await emit(guest,"registration:invite",{})).ok,true);
    assert.equal((await emit(guest,"registration:configure",{required:false})).ok,false);
    const changed = new Promise<{required:boolean}>(resolve=>guest.once("registration:policy",resolve));
    assert.equal((await emit(admin,"registration:configure",{required:false})).ok,true);
    assert.deepEqual(await changed,{required:false});
    assert.equal((await emit(guest,"auth:register",{username:"openregistration",password:server.password})).ok,true);
    assert.equal((await emit(admin,"registration:configure",{required:true})).ok,true);
    assert.equal((await emit(guest,"auth:register",{username:"mustbeclosed",password:server.password})).ok,false);
  } finally { clients.forEach(socket=>socket.disconnect()); await server.stop(); }
});
