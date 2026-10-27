import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createExternalStore, shallowEqual } from "../src/lib/externalStore";
import { useStoreSelector } from "../src/hooks/useStoreSelector";

test("stores isolate instances, keep fixed hydration snapshots and clean up subscriptions", () => {
  const initial = { count: 0 };
  const first = createExternalStore(initial, shallowEqual), second = createExternalStore(initial, shallowEqual);
  let notifications = 0;
  const stop = first.subscribe(() => notifications++);
  first.publish({ count: 0 });
  assert.equal(notifications, 0);
  assert.equal(first.getSnapshot(), initial);
  first.publish({ count: 1 });
  assert.equal(notifications, 1);
  assert.deepEqual(first.getSnapshot(), { count: 1 });
  assert.equal(second.getSnapshot(), initial);
  assert.equal(first.getServerSnapshot(), initial);
  stop(); stop(); first.publish({ count: 2 });
  assert.equal(notifications, 1);
});

test("selector SSR uses the fixed server snapshot, independently of client updates", () => {
  const store = createExternalStore({ label: "server" });
  store.publish({ label: "client" });
  function Label() {
    const selected = useStoreSelector(store, state => ({ label: state.label }), shallowEqual);
    return createElement("span", null, selected.label);
  }
  assert.equal(renderToString(createElement(Label)), "<span>server</span>");
});
