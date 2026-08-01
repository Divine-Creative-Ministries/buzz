/**
 * Integration tests for useObservedUnreadPersistence.
 *
 * These tests mount the REAL production hook via createRoot + act to exercise
 * the actual lifecycle: pagehide flush, unmount cleanup, scope fence, timer
 * ownership, and marker prune wiring. Storage-primitive behavior is covered
 * separately in observedUnreadStorage.test.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ── DOM shim ──────────────────────────────────────────────────────────────────

function installDOMShim() {
  class ET {
    constructor() {
      this._ls = {};
    }
    addEventListener(t, fn) {
      this._ls[t] ??= [];
      this._ls[t].push(fn);
    }
    removeEventListener(t, fn) {
      this._ls[t] = (this._ls[t] ?? []).filter((f) => f !== fn);
    }
    dispatchEvent(e) {
      for (const fn of this._ls[e.type] ?? []) fn(e);
      return true;
    }
  }
  class Node extends ET {
    constructor(tag) {
      super();
      this.tagName = tag;
      this.children = [];
      this.childNodes = [];
      this.style = {};
      this.nodeType = 1;
      this.parentNode = null;
    }
    get ownerDocument() {
      return globalThis.document;
    }
    get firstChild() {
      return this.children[0] ?? null;
    }
    get lastChild() {
      return this.children[this.children.length - 1] ?? null;
    }
    get nextSibling() {
      return null;
    }
    get nodeValue() {
      return null;
    }
    appendChild(c) {
      this.children.push(c);
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    }
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      this.childNodes = this.childNodes.filter((x) => x !== c);
      return c;
    }
    insertBefore(n, r) {
      if (!r) return this.appendChild(n);
      const i = this.children.indexOf(r);
      if (i < 0) return this.appendChild(n);
      this.children.splice(i, 0, n);
      this.childNodes.splice(i, 0, n);
      n.parentNode = this;
      return n;
    }
    contains(n) {
      return this === n || this.children.some((c) => c?.contains?.(n));
    }
  }
  class Doc extends ET {
    constructor() {
      super();
      this.nodeType = 9;
    }
    createElement(t) {
      return new Node(t);
    }
    createTextNode(v) {
      const n = new Node("#text");
      n.nodeType = 3;
      n.nodeValue = v;
      return n;
    }
    createComment(v) {
      const n = new Node("#comment");
      n.nodeType = 8;
      n.nodeValue = v;
      return n;
    }
    get activeElement() {
      return null;
    }
    contains(n) {
      return n != null;
    }
  }

  // Window-level event target for pagehide.
  const windowET = new ET();

  globalThis.document = new Doc();
  globalThis.HTMLIFrameElement = Node;
  globalThis.HTMLElement = Node;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  process.env.IS_REACT_ACT_ENVIRONMENT = "true";
  if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: globalThis,
      configurable: true,
    });
  }
  // Expose window event target methods (used by pagehide listener).
  globalThis.addEventListener = windowET.addEventListener.bind(windowET);
  globalThis.removeEventListener = windowET.removeEventListener.bind(windowET);
  globalThis.dispatchEvent = windowET.dispatchEvent.bind(windowET);
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

installDOMShim();

// ── localStorage shim ─────────────────────────────────────────────────────────

function makeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    _store: store,
  };
}

function installFreshStorage() {
  const ls = makeLocalStorage();
  Object.defineProperty(globalThis, "localStorage", {
    get: () => ls,
    configurable: true,
  });
  return ls;
}

// Install once at module level.
installFreshStorage();

// ── Imports (after shims) ─────────────────────────────────────────────────────

import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { useObservedUnreadPersistence } from "./useObservedUnreadPersistence.ts";
import {
  readObservedUnreadFromStorage,
  writeObservedUnreadToStorage,
} from "./observedUnreadStorage.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PUBKEY = "aabbcc";
const RELAY = "wss://relay.example.com";
// Use a recent timestamp so age-pruning doesn't discard events before writing.
// 7-day horizon: events must be newer than (now - 604800 seconds).
const NOW_S = Math.floor(Date.now() / 1_000);

function makeEvent(id, _channelId, createdAt = NOW_S) {
  return {
    id,
    createdAt,
    rootId: `root-${id}`,
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
}

function makeRefs() {
  const eventsRef = { current: new Map() };
  const latestRef = { current: new Map() };
  // Seed an event in channel-1 with a recent timestamp.
  const inner = new Map();
  inner.set("evt-1", makeEvent("evt-1", "channel-1", NOW_S));
  eventsRef.current.set("channel-1", inner);
  latestRef.current.set("channel-1", NOW_S);
  return { eventsRef, latestRef };
}

/**
 * Mounts useObservedUnreadPersistence in a harness component and returns
 * controls to inspect and manipulate the hook's API.
 */
async function mountHook(props, refs) {
  const apiRef = { current: null };

  function Harness({
    pubkey,
    relay,
    isReady,
    readStateVersion,
    getTs,
    getOwn,
    onPruned,
  }) {
    apiRef.current = useObservedUnreadPersistence(
      pubkey,
      relay,
      isReady,
      readStateVersion,
      getTs,
      getOwn,
      refs.eventsRef,
      refs.latestRef,
      { onPruned: onPruned ?? (() => {}) },
    );
    return null;
  }

  const root = createRoot(document.createElement("div"));
  const render = async (p) => {
    await act(async () => {
      root.render(React.createElement(Harness, p));
    });
  };
  await render(props);

  return {
    get api() {
      return apiRef.current;
    },
    render,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("pagehide flush: event recorded within debounce window survives reload", async () => {
  installFreshStorage();
  const refs = makeRefs();
  const harness = await mountHook(
    {
      pubkey: PUBKEY,
      relay: RELAY,
      isReady: true,
      readStateVersion: 0,
      getTs: () => null,
      getOwn: () => null,
    },
    refs,
  );

  // Add a new event after mount (simulates a live message arriving mid-debounce).
  const newInner = new Map(refs.eventsRef.current.get("channel-2") ?? []);
  newInner.set("evt-new", makeEvent("evt-new", "channel-2", NOW_S + 1));
  refs.eventsRef.current.set("channel-2", newInner);
  refs.latestRef.current.set("channel-2", NOW_S + 1);

  harness.api.schedule(harness.api.currentScope);

  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(stored !== null, "storage should not be null after pagehide flush");
  assert.ok(stored.has("channel-2"), "channel-2 must be in persisted storage");
  assert.ok(
    stored.get("channel-2")?.has("evt-new"),
    "evt-new must be in channel-2's persisted events",
  );

  await harness.unmount();
});

test("unmount with pending write flushes before teardown", async () => {
  installFreshStorage();
  const refs = makeRefs();
  const harness = await mountHook(
    {
      pubkey: PUBKEY,
      relay: RELAY,
      isReady: true,
      readStateVersion: 0,
      getTs: () => null,
      getOwn: () => null,
    },
    refs,
  );

  const inner = new Map();
  inner.set("evt-unmount", makeEvent("evt-unmount", "ch-u", NOW_S + 2));
  refs.eventsRef.current.set("ch-u", inner);
  harness.api.schedule(harness.api.currentScope);

  await harness.unmount();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(stored !== null, "storage must not be null after unmount flush");
  assert.ok(stored.has("ch-u"), "ch-u must be persisted after unmount");
});

test("clearAll cancels pending debounce so no resurrection after reload", async () => {
  installFreshStorage();
  const refs = makeRefs();
  const harness = await mountHook(
    {
      pubkey: PUBKEY,
      relay: RELAY,
      isReady: true,
      readStateVersion: 0,
      getTs: () => null,
      getOwn: () => null,
    },
    refs,
  );

  harness.api.schedule(harness.api.currentScope);
  harness.api.clearAll();

  // Simulate parent reassigning refs after markAllChannelsRead.
  refs.eventsRef.current = new Map();
  refs.latestRef.current = new Map();

  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  assert.equal(
    readObservedUnreadFromStorage(PUBKEY, RELAY),
    null,
    "storage must be null after clearAll + empty flush",
  );

  await harness.unmount();
});

test("removeChannel replaces pending snapshot so sibling channel B survives reload", async () => {
  installFreshStorage();

  // Seed both channels so hydration loads them; removeChannel(ch1) mid-debounce
  // must replace the snapshot so ch2 survives the next pagehide flush.
  const seedMap = new Map();
  const ch1 = new Map();
  ch1.set("evt-1", makeEvent("evt-1", "channel-1", NOW_S));
  seedMap.set("channel-1", ch1);
  const ch2 = new Map();
  ch2.set("evt-2", makeEvent("evt-2", "channel-2", NOW_S + 1));
  seedMap.set("channel-2", ch2);
  writeObservedUnreadToStorage(PUBKEY, RELAY, seedMap);

  const refs = {
    eventsRef: { current: new Map() },
    latestRef: { current: new Map() },
  };
  const harness = await mountHook(
    {
      pubkey: PUBKEY,
      relay: RELAY,
      isReady: true,
      readStateVersion: 0,
      getTs: () => null,
      getOwn: () => null,
    },
    refs,
  );

  assert.ok(
    refs.eventsRef.current.has("channel-1"),
    "hydration must restore channel-1",
  );
  assert.ok(
    refs.eventsRef.current.has("channel-2"),
    "hydration must restore channel-2",
  );

  harness.api.schedule(harness.api.currentScope);
  harness.api.removeChannel("channel-1");

  assert.ok(
    !refs.eventsRef.current.has("channel-1"),
    "channel-1 removed from refs",
  );
  assert.ok(
    refs.eventsRef.current.has("channel-2"),
    "channel-2 still in refs after removeChannel",
  );

  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored !== null,
    "storage must not be null — channel-2 events survive",
  );
  assert.ok(
    !stored.has("channel-1"),
    "channel-1 must not appear after removeChannel",
  );
  assert.ok(
    stored.has("channel-2"),
    "channel-2 must survive removeChannel(channel-1)",
  );

  await harness.unmount();
});

test("marker prune: thread and channel markers prune covered events; sibling channels survive", async () => {
  installFreshStorage();

  const eventsRef = { current: new Map() };
  const latestRef = { current: new Map() };
  // channel-1: evt-a covered by thread:root-a marker; evt-b NOT covered (newer).
  // channel-a: two events covered by channel marker at NOW_S-5.
  // channel-b: event at NOW_S+10 (survives).
  const evtA = {
    id: "evt-a",
    createdAt: NOW_S - 10,
    rootId: "root-a",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
  const evtB = {
    id: "evt-b",
    createdAt: NOW_S + 10,
    rootId: "root-b",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
  const evtOld = {
    id: "evt-old",
    createdAt: NOW_S - 20,
    rootId: "root-old",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
  const evtMid = {
    id: "evt-mid",
    createdAt: NOW_S - 10,
    rootId: "root-mid",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
  const evtSurvivor = {
    id: "evt-survivor",
    createdAt: NOW_S + 10,
    rootId: "root-sv",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };

  const stored = new Map();
  const ch1 = new Map();
  ch1.set("evt-a", evtA);
  ch1.set("evt-b", evtB);
  stored.set("channel-1", ch1);
  const chA = new Map();
  chA.set("evt-old", evtOld);
  chA.set("evt-mid", evtMid);
  stored.set("channel-a", chA);
  const chB = new Map();
  chB.set("evt-survivor", evtSurvivor);
  stored.set("channel-b", chB);
  writeObservedUnreadToStorage(PUBKEY, RELAY, stored);

  let pruneCount = 0;
  const harness = await mountHook(
    {
      pubkey: PUBKEY,
      relay: RELAY,
      isReady: false,
      readStateVersion: 0,
      getTs: () => null,
      getOwn: () => null,
    },
    { eventsRef, latestRef },
  );

  await harness.render({
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 1,
    getTs: (channelId) => (channelId === "channel-a" ? NOW_S - 5 : null),
    getOwn: (ctx) => (ctx === "thread:root-a" ? NOW_S - 5 : null),
    onPruned: () => {
      pruneCount += 1;
    },
  });

  // Thread marker: evt-a pruned from channel-1; evt-b survives.
  assert.ok(
    !eventsRef.current.get("channel-1")?.has("evt-a"),
    "evt-a must be pruned by thread marker",
  );
  assert.ok(
    eventsRef.current.get("channel-1")?.has("evt-b"),
    "evt-b must survive (newer than marker)",
  );
  // Channel marker: channel-a fully cleared.
  assert.ok(
    !eventsRef.current.has("channel-a"),
    "channel-a must be fully pruned by channel marker",
  );
  // Sibling: channel-b unaffected.
  assert.ok(eventsRef.current.has("channel-b"), "channel-b must survive");
  assert.equal(pruneCount, 1, "onPruned must fire exactly once");

  await harness.unmount();
});

test("isScopeLoaded returns false before identity-reset effect commits, true after", async () => {
  installFreshStorage();
  const refs = makeRefs();
  const harness = await mountHook(
    {
      pubkey: PUBKEY,
      relay: RELAY,
      isReady: false,
      readStateVersion: 0,
      getTs: () => null,
      getOwn: () => null,
    },
    refs,
  );
  assert.ok(
    harness.api.isScopeLoaded(),
    "isScopeLoaded must be true after mount+effects",
  );

  const PUBKEY_B = "pubkey-b-scope-test";
  await harness.render({
    pubkey: PUBKEY_B,
    relay: RELAY,
    isReady: false,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  });
  assert.ok(
    harness.api.isScopeLoaded(),
    "isScopeLoaded must be true after scope switch + effects committed",
  );
  assert.ok(
    harness.api.currentScope.includes(PUBKEY_B.toLowerCase()),
    "currentScope must reflect the new pubkey",
  );
  assert.equal(
    harness.api.scopeLoadedRef.current,
    harness.api.currentScope,
    "scopeLoadedRef must equal currentScope after effects commit",
  );

  await harness.unmount();
});

test("A→B scope switch: pending A-timer is cancelled by flush, A data persisted synchronously", async () => {
  installFreshStorage();

  const PUBKEY_AT = "pubkey-a-t";
  const RELAY_AT = "wss://relay-a-t.example.com";
  const PUBKEY_BT = "pubkey-b-t";
  const RELAY_BT = "wss://relay-b-t.example.com";

  writeObservedUnreadToStorage(
    PUBKEY_AT,
    RELAY_AT,
    new Map([
      ["ch-at", new Map([["evt-at", makeEvent("evt-at", "ch-at", NOW_S)]])],
    ]),
  );

  const refsAT = {
    eventsRef: { current: new Map() },
    latestRef: { current: new Map() },
  };
  const propsAT = {
    pubkey: PUBKEY_AT,
    relay: RELAY_AT,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  const harness = await mountHook(propsAT, refsAT);
  assert.ok(
    refsAT.eventsRef.current.has("ch-at"),
    "hydration must restore ch-at from storage",
  );

  harness.api.schedule(harness.api.currentScope);

  // Switch to B: flushes A synchronously, resets refs, loads B.
  await harness.render({ ...propsAT, pubkey: PUBKEY_BT, relay: RELAY_BT });

  assert.ok(
    readObservedUnreadFromStorage(PUBKEY_AT, RELAY_AT)?.has("ch-at"),
    "A must be flushed synchronously on scope switch",
  );
  assert.ok(
    readObservedUnreadFromStorage(PUBKEY_BT, RELAY_BT) == null ||
      !readObservedUnreadFromStorage(PUBKEY_BT, RELAY_BT)?.has("ch-at"),
    "B's bucket must not contain A's channel",
  );

  // B schedules and flushes independently.
  const chBT = new Map();
  chBT.set("evt-bt", makeEvent("evt-bt", "ch-bt", NOW_S + 300));
  refsAT.eventsRef.current.set("ch-bt", chBT);
  refsAT.latestRef.current.set("ch-bt", NOW_S + 300);
  harness.api.schedule(harness.api.currentScope);

  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  assert.ok(
    readObservedUnreadFromStorage(PUBKEY_BT, RELAY_BT)?.has("ch-bt"),
    "B's scheduled write must persist independently",
  );

  await harness.unmount();
});

test("stale clearAll from scope A rejects after scope B loads (scope fence enforced)", async () => {
  installFreshStorage();

  const seedA = new Map([
    [
      "channel-seed",
      new Map([["evt-seed-a", makeEvent("evt-seed-a", "channel-seed", NOW_S)]]),
    ],
  ]);
  writeObservedUnreadToStorage(PUBKEY, RELAY, seedA);

  const refsA = {
    eventsRef: { current: new Map() },
    latestRef: { current: new Map() },
  };
  const propsA = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };
  const harness = await mountHook(propsA, refsA);

  harness.api.schedule(harness.api.currentScope);
  const staleClearAll = harness.api.clearAll;

  const PUBKEY_B = "pubkey-b2";
  const RELAY_B = "wss://relay-b2.example.com";
  await harness.render({ ...propsA, pubkey: PUBKEY_B, relay: RELAY_B });

  const storedA_before = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(storedA_before !== null, "A's bucket must survive scope switch");

  staleClearAll();

  assert.deepEqual(
    readObservedUnreadFromStorage(PUBKEY, RELAY),
    storedA_before,
    "stale clearAll from scope A must not delete A's bucket after scope B loads",
  );

  await harness.unmount();
});

test("stale removeChannel from scope A rejects after scope B loads (scope fence enforced)", async () => {
  installFreshStorage();

  const seedA = new Map([
    [
      "channel-seed",
      new Map([["evt-seed-a", makeEvent("evt-seed-a", "channel-seed", NOW_S)]]),
    ],
  ]);
  writeObservedUnreadToStorage(PUBKEY, RELAY, seedA);

  const refsA = {
    eventsRef: { current: new Map() },
    latestRef: { current: new Map() },
  };
  const propsA = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };
  const harness = await mountHook(propsA, refsA);

  harness.api.schedule(harness.api.currentScope);

  const PUBKEY_B = "pubkey-b3";
  const RELAY_B = "wss://relay-b3.example.com";
  writeObservedUnreadToStorage(
    PUBKEY_B,
    RELAY_B,
    new Map([
      [
        "channel-b",
        new Map([["evt-seed-b", makeEvent("evt-seed-b", "channel-b", NOW_S)]]),
      ],
    ]),
  );

  const staleRemoveChannel = harness.api.removeChannel;
  await harness.render({ ...propsA, pubkey: PUBKEY_B, relay: RELAY_B });

  const storedB_before = readObservedUnreadFromStorage(PUBKEY_B, RELAY_B);
  assert.ok(
    storedB_before !== null,
    "B's bucket must be in storage after scope switch",
  );

  staleRemoveChannel("channel-b");

  assert.deepEqual(
    readObservedUnreadFromStorage(PUBKEY_B, RELAY_B),
    storedB_before,
    "stale removeChannel from scope A must not delete channel-b from B's bucket",
  );

  await harness.unmount();
});

test("unrelated rerenders do not change API object identity (catch-up stability)", async () => {
  installFreshStorage();
  const refs = makeRefs();
  const props = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };
  const harness = await mountHook(props, refs);
  const api1 = harness.api;

  // readStateVersion changes on every read-state advance but must NOT change the API object.
  await harness.render({ ...props, readStateVersion: 1 });

  const api2 = harness.api;
  assert.equal(
    api1,
    api2,
    "API object must be the same reference on unrelated rerender",
  );
  assert.equal(api1.schedule, api2.schedule, "schedule must be stable");
  assert.equal(
    api1.removeChannel,
    api2.removeChannel,
    "removeChannel must be stable",
  );
  assert.equal(api1.clearAll, api2.clearAll, "clearAll must be stable");
  assert.equal(
    api1.isScopeLoaded,
    api2.isScopeLoaded,
    "isScopeLoaded must be stable",
  );

  await harness.unmount();
});
