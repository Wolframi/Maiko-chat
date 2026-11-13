import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandQueryFromDraft,
  filterBotCommands,
  splitCommandText,
} from "../src/lib/botCommands";

test("declared /commands become clickable fragments", () => {
  assert.deepEqual(splitCommandText("/start", ["start"]), [
    { type: "command", value: "/start" },
  ]);
  assert.deepEqual(splitCommandText("Нажмите /start или /help@echo_bot.", ["start", "help"]), [
    { type: "text", value: "Нажмите " },
    { type: "command", value: "/start" },
    { type: "text", value: " или " },
    { type: "command", value: "/help@echo_bot" },
    { type: "text", value: "." },
  ]);
  assert.deepEqual(splitCommandText("( /roll 20)", ["roll"]), [
    { type: "text", value: "( " },
    { type: "command", value: "/roll" },
    { type: "text", value: " 20)" },
  ]);
  assert.deepEqual(splitCommandText("/start\n/help", ["start", "help"]), [
    { type: "command", value: "/start" },
    { type: "text", value: "\n" },
    { type: "command", value: "/help" },
  ]);
  // Case-insensitive names, the token keeps its original casing.
  assert.deepEqual(splitCommandText("/START", ["start"]), [
    { type: "command", value: "/START" },
  ]);
});

test("unknown commands, URLs and plain text are left alone", () => {  assert.deepEqual(splitCommandText("/unknown", ["start"]), [
    { type: "text", value: "/unknown" },
  ]);
  assert.deepEqual(splitCommandText("https://example.com/start", ["start"]), [
    { type: "text", value: "https://example.com/start" },
  ]);
  assert.deepEqual(splitCommandText("say /unknown /help", ["help"]), [
    { type: "text", value: "say /unknown " },
    { type: "command", value: "/help" },
  ]);
  assert.deepEqual(splitCommandText("обычный текст", ["start"]), [
    { type: "text", value: "обычный текст" },
  ]);
  // Repeated calls must not leak the global regex state.
  assert.deepEqual(splitCommandText("/help", ["help"]), [
    { type: "command", value: "/help" },
  ]);
  assert.deepEqual(splitCommandText("/help", ["help"]), [
    { type: "command", value: "/help" },
  ]);
});

test("autocomplete opens only while a /command is being typed", () => {
  assert.equal(commandQueryFromDraft("/"), "");
  assert.equal(commandQueryFromDraft("/he"), "he");
  assert.equal(commandQueryFromDraft("/ROLL"), "ROLL");
  for (const text of [
    "",
    "hello",
    "hello /he",
    "/help ",
    "/help arg",
    "//x",
    "/he!",
    "/he@bot",
  ]) {
    assert.equal(commandQueryFromDraft(text), undefined, JSON.stringify(text));
  }
});

test("autocomplete filters commands by prefix and caps the list", () => {
  const commands = [
    { command: "start" },
    { command: "help" },
    { command: "roll" },
    { command: "image" },
    { command: "status" },
  ];
  assert.deepEqual(
    filterBotCommands(commands, "").map((item) => item.command),
    ["start", "help", "roll", "image", "status"],
  );
  assert.deepEqual(
    filterBotCommands(commands, "st").map((item) => item.command),
    ["start", "status"],
  );
  assert.deepEqual(
    filterBotCommands(commands, "HE").map((item) => item.command),
    ["help"],
  );
  assert.deepEqual(filterBotCommands(commands, "zzz"), []);
  assert.deepEqual(
    filterBotCommands(commands, "", 2).map((item) => item.command),
    ["start", "help"],
  );
});
