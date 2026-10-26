import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
test("nested collaboration updates and their retry ledger commit or roll back together", () => {
  const store = new Store(":memory:");
  try {
    assert.throws(() =>
      store.transaction(() => {
        store.set("manager-event", "reserved");
        store.transaction(() => store.set("shared-change", "applied"));
        throw new Error("final acknowledgement failed");
      }),
    );
    assert.equal(store.setting("manager-event", null), null);
    assert.equal(store.setting("shared-change", null), null);
    store.transaction(() => {
      store.set("outer", true);
      try {
        store.transaction(() => {
          store.set("inner", true);
          throw new Error("cancel inner");
        });
      } catch {}
      store.set("event-committed", true);
    });
    assert.equal(store.setting("outer", false), true);
    assert.equal(store.setting("inner", false), false);
    assert.equal(store.setting("event-committed", false), true);
  } finally {
    store.close();
  }
});
