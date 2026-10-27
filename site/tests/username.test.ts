import assert from "node:assert/strict";
import { test } from "node:test";
import { personSearchScore } from "../src/lib/username";

test("nickname search accepts @, case and partial names; exact nickname ranks first", () => {
  const users = [
    { username: "other", displayName: "Alice" },
    { username: "xalice", displayName: "Other" },
    { username: "alice_2", displayName: "Other" },
    { username: "Alice", displayName: "Алиса" },
  ];
  const search = (query: string) => users.filter(user => personSearchScore(user, query) < 99)
    .sort((a, b) => personSearchScore(a, query) - personSearchScore(b, query))
    .map(user => user.username);
  assert.deepEqual(search(" @ALICE "), ["Alice", "alice_2", "xalice"]);
  assert.deepEqual(search("alice"), ["Alice", "alice_2", "other", "xalice"]);
  assert.deepEqual(search("Алиса"), ["Alice"]);
  for (const query of ["", "@", "@a", "x".repeat(65), "@@alice"]) assert.deepEqual(search(query), []);
});
