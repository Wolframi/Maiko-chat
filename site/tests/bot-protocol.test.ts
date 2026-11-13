import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_TOKEN_PREFIX,
  botTokenHash,
  commandAddressedTo,
  isBotTokenFormat,
  maskBotToken,
  normalizeBotButtons,
  normalizeBotCommands,
  parseBotCommand,
  sanitizeBotText,
} from "../src/server/botProtocol";

test("bot tokens are recognisable, hashed deterministically and masked safely", () => {
  const token = `${BOT_TOKEN_PREFIX}${"a".repeat(48)}`;
  assert.equal(isBotTokenFormat(token), true);
  for (const bad of [
    "",
    "maiko_bot_",
    `maiko_bot_${"a".repeat(47)}`,
    `maiko_bot_${"a".repeat(49)}`,
    `maiko_bot_${"A".repeat(48)}`,
    `maiko_bot_${"g".repeat(48)}`,
    `maiko_bot_${"a".repeat(48)}\n`,
    ` ${token}`,
    null,
    undefined,
    42,
  ]) {
    assert.equal(isBotTokenFormat(bad), false, JSON.stringify(bad));
  }

  assert.equal(botTokenHash(token), botTokenHash(token));
  assert.match(botTokenHash(token), /^[a-f0-9]{64}$/);
  assert.notEqual(botTokenHash(token), botTokenHash(`${BOT_TOKEN_PREFIX}${"b".repeat(48)}`));

  const masked = maskBotToken(token);
  assert.ok(masked.startsWith("maiko_bot_aaaa…"), masked);
  assert.ok(masked.endsWith("aaaa"), masked);
  assert.ok(!masked.includes("a".repeat(20)), "mask must not leak the secret");
  assert.equal(maskBotToken("short"), "…");
});

test("chat text parses as Telegram-like commands", () => {
  assert.deepEqual(parseBotCommand("/help"), { name: "help", args: "", target: null });
  assert.deepEqual(parseBotCommand("  /Roll  20 "), { name: "roll", args: "20", target: null });
  assert.deepEqual(parseBotCommand("/help@Echo_Bot"), {
    name: "help",
    args: "",
    target: "echo_bot",
  });
  assert.deepEqual(parseBotCommand("/echo@echo_bot привет мир"), {
    name: "echo",
    args: "привет мир",
    target: "echo_bot",
  });
  assert.deepEqual(parseBotCommand("/echo вторая\nстрока"), {
    name: "echo",
    args: "вторая\nстрока",
    target: null,
  });

  for (const text of [
    "help",
    "/",
    "//help",
    "текст /help",
    "/help@",
    "/help@a",
    `/${"x".repeat(33)}`,
    "/help-name",
    "/help\nworld",
  ]) {
    assert.equal(parseBotCommand(text), null, JSON.stringify(text));
  }
  assert.equal(parseBotCommand(undefined), null);
  assert.equal(parseBotCommand({ text: "/help" }), null);
});

test("targeted commands reach only the named bot", () => {
  const targeted = parseBotCommand("/help@echo_bot");
  assert.equal(commandAddressedTo(targeted, "echo_bot"), true);
  assert.equal(commandAddressedTo(targeted, "ECHO_BOT"), true);
  assert.equal(commandAddressedTo(targeted, "weather_bot"), false);
  assert.equal(commandAddressedTo(parseBotCommand("/help"), "echo_bot"), false);
  assert.equal(commandAddressedTo(null, "echo_bot"), false);
  assert.equal(commandAddressedTo(undefined, "echo_bot"), false);
});

test("bot text drops control characters and is clamped", () => {
  assert.equal(sanitizeBotText("  привет\u0000\u0007  "), "привет");
  assert.equal(sanitizeBotText("x".repeat(5000), 10), "x".repeat(10));
  assert.equal(sanitizeBotText(undefined), "");
  assert.equal(sanitizeBotText(null), "");
  assert.equal(sanitizeBotText(12345, 3), "123");
  assert.equal(sanitizeBotText("текст", 0), "т");
});

test("inline keyboards accept only safe callback or https buttons", () => {  assert.equal(normalizeBotButtons(undefined), undefined);
  assert.equal(normalizeBotButtons(null), undefined);
  assert.equal(normalizeBotButtons([]), undefined);

  assert.deepEqual(normalizeBotButtons([[{ text: "Да", data: "yes" }]]), [
    [{ text: "Да", data: "yes" }],
  ]);
  assert.deepEqual(normalizeBotButtons([[{ text: "Сайт", url: "https://example.com/a?b=1" }]]), [
    [{ text: "Сайт", url: "https://example.com/a?b=1" }],
  ]);
  assert.deepEqual(
    normalizeBotButtons([
      [
        { text: "  Да\u0000  ", data: "  yes " },
        { text: "Нет", data: "no" },
      ],
      [{ text: "Ещё", data: "more" }],
    ]),
    [
      [
        { text: "Да", data: "yes" },
        { text: "Нет", data: "no" },
      ],
      [{ text: "Ещё", data: "more" }],
    ],
  );
  // Long captions and payloads are clamped, not rejected.
  const clamped = normalizeBotButtons([
    [{ text: "т".repeat(100), data: "d".repeat(100) }],
  ]);
  assert.equal(clamped?.[0][0].text.length, 64);
  assert.equal(clamped?.[0][0].data?.length, 64);

  for (const bad of [
    [[{ text: "x", data: "a" }, { text: "y" }, { text: "z" }, { text: "w" }, { text: "v" }]],
    [
      [{ text: "x", data: "a" }, { text: "y", data: "b" }, { text: "z", data: "c" },
        { text: "w", data: "d" }, { text: "v", data: "e" }],
    ],
    [[{ text: "x", data: "a", url: "https://example.com" }]],
    [[{ text: "x" }]],
    [[{ text: "", data: "a" }]],
    [[{ text: "x", url: "javascript:alert(1)" }]],
    [[{ text: "x", url: "ftp://example.com" }]],
    [[{ text: "x", url: "https://exa mple.com" }]],
    [[]],
    [[{ text: "x", data: "a" }], [], [{ text: "y", data: "b" }]],
    [Array.from({ length: 5 }, (_, i) => ({ text: `b${i}`, data: `d${i}` }))],
    Array.from({ length: 7 }, () => [{ text: "x", data: "a" }]),
    [{ text: "x", data: "a" }],
    "buttons",
    42,
  ]) {
    assert.equal(normalizeBotButtons(bad), null, JSON.stringify(bad));
  }
});

test("bot command lists are normalized, deduplicated and capped", () => {
  assert.deepEqual(
    normalizeBotCommands([{ command: "start", description: "Приветствие" }]),
    [{ command: "start", description: "Приветствие" }],
  );
  assert.deepEqual(
    normalizeBotCommands([{ command: "/HELP", description: "  Список   команд  " }]),
    [{ command: "help", description: "Список команд" }],
  );
  assert.deepEqual(normalizeBotCommands([{ command: "ping", description: "" }]), [
    { command: "ping", description: "" },
  ]);
  // Last declaration wins.
  assert.deepEqual(
    normalizeBotCommands([
      { command: "roll", description: "old" },
      { command: "roll", description: "new" },
    ]),
    [{ command: "roll", description: "new" }],
  );
  assert.deepEqual(normalizeBotCommands([]), []);
  const clamped = normalizeBotCommands([
    { command: "start", description: "d".repeat(500) },
  ]);
  assert.ok(clamped);
  assert.equal(clamped[0].description.length, 120);

  for (const bad of [
    undefined,
    null,
    "commands",
    {},
    [1],
    [{ command: "", description: "x" }],
    [{ command: "bad name", description: "x" }],
    [{ command: `x${"y".repeat(32)}`, description: "x" }],
    Array.from({ length: 33 }, (_, index) => ({ command: `c${index}`, description: "" })),
  ]) {
    assert.equal(normalizeBotCommands(bad), null, JSON.stringify(bad));
  }
});
