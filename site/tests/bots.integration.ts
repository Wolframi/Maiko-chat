import assert from "node:assert/strict";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

const GROUP = "security-group-0";
const ADMIN_SECRET = "bot-integration-secret-0123456789";

type Ack = Record<string, any>;

/** Manual bot: created through the local admin API, replies to a command and sends a file. */
test("manual bot answers commands and sends files", { timeout: 180000 }, async () => {
  const server = await securityServer({ botAdminSecret: ADMIN_SECRET });
  const clients: Socket[] = [];
  const call = (socket: Socket, event: string, payload: unknown): Promise<Ack> =>
    socket.timeout(15000).emitWithAck(event, payload) as Promise<Ack>;
  const rawConnect = (auth?: Record<string, unknown>) => {
    const socket = io(server.base, {
      path: "/api/socket",
      transports: ["websocket"],
      reconnection: false,
      ...(auth ? { auth } : {}),
    });
    clients.push(socket);
    return socket;
  };
  /** Connecting must fail: wrong or rotated bot token. */
  const expectRejected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("token was not rejected")), 15000);
      socket.once("connect_error", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        reject(new Error("unexpected connect"));
      });
    });

  try {
    const human = rawConnect();
    await new Promise<void>((resolve, reject) => {
      human.once("connect", resolve);
      human.once("connect_error", reject);
    });
    assert.equal((await call(human, "auth:restore", { token: server.token })).ok, true);
    assert.equal((await call(human, "chats:switch", { chatId: GROUP })).ok, true);

    // 1. Bots cannot be created without the machine-local admin secret.
    const denied = await fetch(`${server.base}/api/bots/admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", displayName: "Echo Bot" }),
    });
    assert.equal(denied.status, 403);

    // 2. Manual creation, immediately added to a group.
    const created = await fetch(`${server.base}/api/bots/admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bot-admin-secret": ADMIN_SECRET },
      body: JSON.stringify({
        action: "create",
        displayName: "Echo Bot",
        username: "echo_bot",
        groupId: GROUP,
      }),
    }).then((response) => response.json());
    assert.equal(created.ok, true, created.error);
    assert.match(created.token, /^maiko_bot_[a-f0-9]{48}$/);
    assert.equal(created.bot.username, "echo_bot");
    assert.equal(created.groupId, GROUP);
    const botId = created.bot.botId as string;

    // 3. A wrong token must be rejected at the handshake.
    const impostor = rawConnect({ botToken: `maiko_bot_${"0".repeat(48)}` });
    await expectRejected(impostor);

    // 4. The bot connects and is subscribed to the group.
    //    Attach listeners before awaiting `connect` so `bot:ready` cannot be missed.
    const bot = rawConnect({ botToken: created.token });
    const ready = new Promise<Ack>((resolve, reject) => {
      bot.once("bot:ready", resolve);
      bot.once("connect_error", reject);
    });
    const readyPayload = await ready;
    assert.equal(readyPayload.bot.username, "echo_bot");
    assert.ok(readyPayload.chats.some((chat: Ack) => chat.id === GROUP));

    // 5. A human command reaches the bot with parsed command metadata.
    const incoming = new Promise<Ack>((resolve) => bot.once("message", resolve));
    const humanSawReply = new Promise<Ack>((resolve) => {
      human.on("message", (message: Ack) => {
        if (message.authorId === botId && message.text === "Команды: /help, /file") resolve(message);
      });
    });
    assert.equal((await call(human, "message", { text: "/help@echo_bot" })).ok, true);
    const command = await incoming;
    assert.equal(command.text, "/help@echo_bot");
    assert.equal(command.command.name, "help");
    assert.equal(command.command.addressed, true);

    // 6. The bot answers with text, and the reply is threaded.
    const sent = await call(bot, "bot:send", {
      chatId: GROUP,
      text: "Команды: /help, /file",
      replyToId: command.id,
      clientId: "integration-reply-1",
    });
    assert.equal(sent.ok, true, sent.error);
    const reply = await humanSawReply;
    assert.equal(reply.authorId, botId);
    assert.equal(reply.author, "Echo Bot");
    assert.equal(reply.kind, "text");
    assert.equal(reply.replyTo?.id, command.id);

    // Retrying the same clientId must not create a second message.
    const duplicate = await call(bot, "bot:send", {
      chatId: GROUP,
      text: "Команды: /help, /file",
      clientId: "integration-reply-1",
    });
    assert.equal(duplicate.ok, true, duplicate.error);
    assert.equal(duplicate.duplicate, true);

    // 7. Files: upload with the bot token, then send through the socket.
    const form = new FormData();
    form.append("originalName", "bot-report.txt");
    form.append(
      "file",
      new Blob([Buffer.from("отчёт бота", "utf8")], { type: "text/plain" }),
      "bot-report.txt",
    );
    const upload = await fetch(`${server.base}/api/upload`, {
      method: "POST",
      headers: { "x-bot-token": created.token },
      body: form,
    }).then((response) => response.json());
    assert.equal(upload.ok, true, upload.error);
    assert.match(upload.file.url, /^\/uploads\/[0-9a-f-]{36}\.txt\?exp=/);
    assert.equal(upload.file.name, "bot-report.txt");

    const humanSawFile = new Promise<Ack>((resolve) => {
      human.on("message", (message: Ack) => {
        if (message.authorId === botId && message.kind === "file") resolve(message);
      });
    });
    const fileSent = await call(bot, "bot:sendFile", {
      chatId: GROUP,
      file: {
        url: upload.file.url,
        name: upload.file.name,
        size: upload.file.size,
        mime: upload.file.mime,
      },
      caption: "Отчёт",
    });
    assert.equal(fileSent.ok, true, fileSent.error);
    const file = await humanSawFile;
    assert.equal(file.authorId, botId);
    assert.equal(file.kind, "file");
    assert.equal(file.text, "Отчёт");
    assert.equal(file.file.name, "bot-report.txt");
    assert.match(file.file.url, /^\/uploads\/[0-9a-f-]{36}\.txt\?exp=\d+&sig=[a-f0-9]+$/);

    // 8. Inline buttons: click → bot:callback → bot edits the message.
    const menuOnHuman = new Promise<Ack>((resolve) => {
      human.on("message", (message: Ack) => {
        if (message.authorId === botId && message.text === "Меню") resolve(message);
      });
    });
    const menuSent = await call(bot, "bot:send", {
      chatId: GROUP,
      text: "Меню",
      buttons: [
        [{ text: "Ещё", data: "more" }],
        [{ text: "Сайт", url: "https://example.com/" }],
      ],
    });
    assert.equal(menuSent.ok, true, menuSent.error);
    const menu = await menuOnHuman;
    assert.deepEqual(menu.buttons, [
      [{ text: "Ещё", data: "more" }],
      [{ text: "Сайт", url: "https://example.com/" }],
    ]);

    const callbackPromise = new Promise<Ack>((resolve) => bot.once("bot:callback", resolve));
    const editedOnHuman = new Promise<Ack>((resolve) => {
      human.on("message:update", (message: Ack) => {
        if (message.id === menuSent.messageId && message.text === "Нажато: more") resolve(message);
      });
    });
    const pressed = await call(human, "message:button", {
      chatId: GROUP,
      messageId: menuSent.messageId,
      data: "more",
    });
    assert.equal(pressed.ok, true, pressed.error);
    const callback = await callbackPromise;
    assert.equal(callback.data, "more");
    assert.equal(callback.messageId, menuSent.messageId);
    assert.equal(callback.from.id, "security-user-0");
    assert.equal(callback.from.name, "Seed User 0");

    const edited = await call(bot, "bot:edit", {
      chatId: GROUP,
      messageId: menuSent.messageId,
      text: "Нажато: more",
      buttons: [],
    });
    assert.equal(edited.ok, true, edited.error);
    const updated = await editedOnHuman;
    assert.equal(updated.text, "Нажато: more");
    assert.equal(updated.buttons, undefined);

    // Unknown callback data and invalid buttons are rejected.
    const unknown = await call(human, "message:button", {
      chatId: GROUP,
      messageId: menuSent.messageId,
      data: "missing",
    });
    assert.equal(unknown.ok, false);
    const badButtons = await call(bot, "bot:send", {
      chatId: GROUP,
      text: "Плохие кнопки",
      buttons: [[{ text: "x", url: "javascript:alert(1)" }]],
    });
    assert.equal(badButtons.ok, false);

    // 9. Bots are registered users: searchable and marked as bots.
    const found = await call(human, "people:search", { query: "echo" });
    const hit = (found.users as Ack[]).find((user) => user.id === botId);
    assert.ok(hit, "bot must be findable in People");
    assert.equal(hit.isBot, true);

    const members = await call(human, "chats:members", { chatId: GROUP });
    assert.equal(
      (members.members as Ack[]).find((member) => member.id === botId)?.isBot,
      true,
    );

    // 10. Command list, description and avatar are set from the bot script.
    const commands = await call(bot, "bot:setCommands", {
      commands: [
        { command: "start", description: "Приветствие" },
        { command: "help", description: "Справка" },
      ],
    });
    assert.equal(commands.ok, true, commands.error);
    assert.deepEqual(
      (commands.commands as Ack[]).map((item) => item.command),
      ["start", "help"],
    );

    const avatarForm = new FormData();
    avatarForm.append("originalName", "avatar.png");
    avatarForm.append(
      "file",
      new Blob(
        [
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            "base64",
          ),
        ],
        { type: "image/png" },
      ),
      "avatar.png",
    );
    const avatarUpload = await fetch(`${server.base}/api/upload?kind=avatar`, {
      method: "POST",
      headers: { "x-bot-token": created.token },
      body: avatarForm,
    }).then((response) => response.json());
    assert.equal(avatarUpload.ok, true, avatarUpload.error);

    const profile = await call(bot, "bot:setProfile", {
      description: "Эхо-бот для тестов",
      avatarUrl: avatarUpload.file.url,
    });
    assert.equal(profile.ok, true, profile.error);
    assert.equal(profile.bot.description, "Эхо-бот для тестов");
    assert.match(profile.bot.avatarUrl, /^\/uploads\/[0-9a-f-]{36}\.png$/);

    const updatedHit = (await call(human, "people:search", { query: "echo" })).users.find(
      (user: Ack) => user.id === botId,
    );
    assert.equal(updatedHit.description, "Эхо-бот для тестов");
    assert.deepEqual(
      (updatedHit.commands as Ack[]).map((item) => item.command),
      ["start", "help"],
    );

    // DM metadata feeds the «Старт» button and the command menu in the UI.
    const dmChats = new Promise<Ack>((resolve) => {
      human.on("chats", (chats: Ack[]) => {
        const dm = chats.find((chat) => chat.type === "dm" && chat.peerId === botId);
        if (dm) resolve(dm);
      });
    });
    assert.equal((await call(human, "dm:open", { userId: botId })).ok, true);
    const dm = await dmChats;
    assert.equal(dm.peerIsBot, true);
    assert.equal(dm.peerDescription, "Эхо-бот для тестов");
    assert.deepEqual(
      (dm.peerCommands as Ack[]).map((item) => item.command),
      ["start", "help"],
    );

    // 11. Rotation invalidates the old token immediately.
    const rotated = await fetch(`${server.base}/api/bots/admin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bot-admin-secret": ADMIN_SECRET },
      body: JSON.stringify({ action: "rotate", botId: "echo_bot" }),
    }).then((response) => response.json());
    assert.equal(rotated.ok, true, rotated.error);
    assert.notEqual(rotated.token, created.token);
    const staleBot = rawConnect({ botToken: created.token });
    await expectRejected(staleBot);
  } finally {
    for (const socket of clients) socket.disconnect();
    await server.stop();
  }
});
