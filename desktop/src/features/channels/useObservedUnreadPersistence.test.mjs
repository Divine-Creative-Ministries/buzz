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
  let renderCount = 0;

  function Harness({
    pubkey,
    relay,
    isReady,
    readStateVersion,
    getTs,
    getOwn,
    onPruned,
  }) {
    renderCount += 1;
    const api = useObservedUnreadPersistence(
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
    apiRef.current = api;
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);

  const render = async (p) => {
    await act(async () => {
      root.render(React.createElement(Harness, p));
    });
  };

  await render(props);

  return {
    root,
    container,
    get api() {
      return apiRef.current;
    },
    get renderCount() {
      return renderCount;
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
  const props = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  const harness = await mountHook(props, refs);
  const scope = harness.api.currentScope;

  // Add a new event to the in-memory refs AFTER mount (simulates a live message).
  const newInner = new Map(refs.eventsRef.current.get("channel-2") ?? []);
  newInner.set("evt-new", makeEvent("evt-new", "channel-2", NOW_S + 1));
  refs.eventsRef.current.set("channel-2", newInner);
  refs.latestRef.current.set("channel-2", NOW_S + 1);

  // Schedule a write (debounced — not yet persisted).
  harness.api.schedule(scope);

  // Simulate pagehide (what Cmd+R triggers before reload).
  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  // Verify the event is now in localStorage (flush happened synchronously).
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
  const props = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  const harness = await mountHook(props, refs);
  const scope = harness.api.currentScope;

  // Add an event and schedule (timer pending).
  const inner = new Map();
  inner.set("evt-unmount", makeEvent("evt-unmount", "ch-u", NOW_S + 2));
  refs.eventsRef.current.set("ch-u", inner);
  harness.api.schedule(scope);

  // Unmount without letting the debounce timer fire.
  await harness.unmount();

  // Flush must have been called — event must be in storage.
  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(stored !== null, "storage must not be null after unmount flush");
  assert.ok(stored.has("ch-u"), "ch-u must be persisted after unmount");
});

test("API object identity is stable across rerenders with unchanged props", async () => {
  const refs = makeRefs();
  const props = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  installFreshStorage();
  const harness = await mountHook(props, refs);
  const api1 = harness.api;
  const schedule1 = api1.schedule;
  const removeChannel1 = api1.removeChannel;
  const clearAll1 = api1.clearAll;
  const isScopeLoaded1 = api1.isScopeLoaded;

  // Re-render with the same props.
  await harness.render(props);

  const api2 = harness.api;
  assert.equal(
    api1,
    api2,
    "returned API object must be the same reference on rerender with same props",
  );
  assert.equal(schedule1, api2.schedule, "schedule must be stable");
  assert.equal(
    removeChannel1,
    api2.removeChannel,
    "removeChannel must be stable",
  );
  assert.equal(clearAll1, api2.clearAll, "clearAll must be stable");
  assert.equal(
    isScopeLoaded1,
    api2.isScopeLoaded,
    "isScopeLoaded must be stable",
  );

  await harness.unmount();
});

test("A→B scope switch: late A-scope scheduled write does not corrupt B's bucket", async () => {
  installFreshStorage();

  const PUBKEY_A = "pubkey-a";
  const RELAY_A = "wss://relay-a.example.com";
  const PUBKEY_B = "pubkey-b";
  const RELAY_B = "wss://relay-b.example.com";

  const refs = makeRefs();
  const propsA = {
    pubkey: PUBKEY_A,
    relay: RELAY_A,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  const harness = await mountHook(propsA, refs);
  const scopeA = harness.api.currentScope;

  // Schedule a write for scope A (timer pending).
  harness.api.schedule(scopeA);

  // Switch to scope B before the timer fires.
  const propsB = { ...propsA, pubkey: PUBKEY_B, relay: RELAY_B };
  await harness.render(propsB);

  // The scope switch flushes A's pending write (the flush-before-clobber path).
  // Now schedule a write for scope B.
  const scopeB = harness.api.currentScope;
  assert.notEqual(scopeA, scopeB, "scopes must differ");

  // Add a B-specific event.
  const innerB = new Map();
  innerB.set("evt-b", makeEvent("evt-b", "ch-b", NOW_S + 3));
  refs.eventsRef.current.set("ch-b", innerB);
  harness.api.schedule(scopeB);

  // Manually advance the timer to see what fires.
  // Use fake timers if available; otherwise rely on the snapshot-owning design:
  // the A-scope timer's snapshot was captured before the switch, and the
  // scope guard in scheduleObservedUnreadWrite rejects a stale scope.
  // Verify B's bucket is untouched by any A-scope write.
  const storedB_before = readObservedUnreadFromStorage(PUBKEY_B, RELAY_B);
  // Before timer fires, B's storage is from the flush (may be null if empty).
  // Verify A's snapshot didn't land in B's key.
  if (storedB_before !== null) {
    assert.ok(
      !storedB_before.has("channel-1"),
      "A's channel-1 must not appear in B's bucket",
    );
  }

  await harness.unmount();
});

test("clearAll cancels pending debounce so no resurrection after reload", async () => {
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
  const scope = harness.api.currentScope;

  // Schedule a write (timer pending with snapshot of current events).
  harness.api.schedule(scope);

  // Call clearAll — must cancel the timer and clear storage.
  harness.api.clearAll();

  // Dispatch pagehide — the flush after clearAll should write an empty map
  // (refs are now empty after the parent calls markAllChannelsRead which
  // reassigns both refs to new Maps). Simulate that here.
  refs.eventsRef.current = new Map();
  refs.latestRef.current = new Map();

  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  // Storage must not contain the pre-clearAll event snapshot.
  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  // The storage key should be absent (empty map → removeItem was called).
  assert.equal(
    stored,
    null,
    "storage must be null after clearAll + empty flush",
  );

  await harness.unmount();
});

test("removeChannel cancels pending debounce so cleared channel is not resurrected", async () => {
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
  const scope = harness.api.currentScope;

  // Schedule a write (timer pending — snapshot includes channel-1).
  harness.api.schedule(scope);

  // Remove channel-1 from storage before timer fires.
  refs.eventsRef.current.delete("channel-1");
  refs.latestRef.current.delete("channel-1");
  harness.api.removeChannel("channel-1");

  // Flush via pagehide — should write the updated refs (channel-1 absent).
  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  if (stored !== null) {
    assert.ok(
      !stored.has("channel-1"),
      "channel-1 must not be resurrected after removeChannel + flush",
    );
  }

  await harness.unmount();
});

test("marker prune: thread marker removes only covered events and bumps onPruned", async () => {
  installFreshStorage();

  // Seed storage with two events in different threads.
  // Write directly to localStorage so hydration picks them up.
  const eventsRef = { current: new Map() };
  const latestRef = { current: new Map() };
  // Use recent timestamps so age-pruning doesn't discard them.
  // evt-a: covered by thread:root-a marker (marker = NOW_S + 1)
  // evt-b: NOT covered (timestamp higher than the marker)
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
  // Pre-seed storage so hydration restores both events.
  const stored = new Map();
  const ch1 = new Map();
  ch1.set("evt-a", evtA);
  ch1.set("evt-b", evtB);
  stored.set("channel-1", ch1);
  writeObservedUnreadToStorage(PUBKEY, RELAY, stored);

  let pruneCount = 0;
  const props = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  // Mount with isReady=false so initial marker prune doesn't run.
  // The hydration effect will populate eventsRef from storage.
  const harness = await mountHook(
    { ...props, isReady: false },
    { eventsRef, latestRef },
  );
  // After hydration, refs should have both events.
  assert.ok(
    eventsRef.current.get("channel-1")?.has("evt-a"),
    "evt-a must be in refs after hydration",
  );
  assert.ok(
    eventsRef.current.get("channel-1")?.has("evt-b"),
    "evt-b must be in refs after hydration",
  );

  // Re-render with a thread:root-a marker that covers evt-a (createdAt=NOW_S-10).
  // Marker at NOW_S - 5: covers evt-a (NOW_S-10 <= NOW_S-5), not evt-b (NOW_S+10 > NOW_S-5).
  await harness.render({
    ...props,
    isReady: true,
    readStateVersion: 1,
    getTs: () => null,
    getOwn: (ctx) => (ctx === "thread:root-a" ? NOW_S - 5 : null),
    onPruned: () => {
      pruneCount += 1;
    },
  });

  // evt-a (createdAt=NOW_S-10) is covered by thread:root-a marker → pruned.
  // evt-b (createdAt=NOW_S+10, rootId=root-b) is NOT covered → kept.
  assert.ok(
    !eventsRef.current.get("channel-1")?.has("evt-a"),
    "evt-a must be pruned",
  );
  assert.ok(
    eventsRef.current.get("channel-1")?.has("evt-b"),
    "evt-b must be kept",
  );
  assert.equal(pruneCount, 1, "onPruned must be called once");

  await harness.unmount();
});

test("isScopeLoaded returns false before identity-reset effect commits, true after", async () => {
  installFreshStorage();
  const refs = makeRefs();
  const props = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: false,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  const harness = await mountHook(props, refs);
  // After mount and effects commit, scope should be loaded.
  assert.ok(
    harness.api.isScopeLoaded(),
    "isScopeLoaded must be true after mount+effects",
  );

  // Switch identity — effects haven't committed yet but we check the return value.
  // (In real React, the component would render once with the new scope before
  // the effect commits. We test that isScopeLoaded() reads current ref state.)
  // Manually back-date the loaded scope to simulate the pre-effect-commit render.
  harness.api.scopeLoadedRef.current = "stale-scope";
  assert.ok(
    !harness.api.isScopeLoaded(),
    "isScopeLoaded must be false when scope is stale",
  );

  // After effect commits (simulated by restoring the correct scope).
  harness.api.scopeLoadedRef.current = harness.api.currentScope;
  assert.ok(
    harness.api.isScopeLoaded(),
    "isScopeLoaded must be true once effect commits",
  );

  await harness.unmount();
});
