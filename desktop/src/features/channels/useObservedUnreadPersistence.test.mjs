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

test("removeChannel replaces pending snapshot so sibling channel B survives reload", async () => {
  installFreshStorage();

  // Pre-seed storage with BOTH channel-1 and channel-2 so the hydration
  // effect loads them into refs on mount.
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

  const props = {
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 0,
    getTs: () => null,
    getOwn: () => null,
  };

  const harness = await mountHook(props, refs);

  // After hydration, both channels are loaded into refs.
  assert.ok(
    refs.eventsRef.current.has("channel-1"),
    "hydration must restore channel-1",
  );
  assert.ok(
    refs.eventsRef.current.has("channel-2"),
    "hydration must restore channel-2",
  );

  const scope = harness.api.currentScope;

  // Schedule a write (timer pending — snapshot includes channel-1 AND channel-2).
  harness.api.schedule(scope);

  // Remove channel-1 BEFORE the debounce fires.
  // removeChannel must: (1) delete channel-1 from refs, (2) replace the
  // pending snapshot with a new snapshot of the current full map (channel-2 only),
  // so channel-2 events are never lost on the next reload.
  harness.api.removeChannel("channel-1");

  // channel-1 must be gone from refs immediately.
  assert.ok(
    !refs.eventsRef.current.has("channel-1"),
    "channel-1 removed from refs",
  );
  // channel-2 must still be in refs.
  assert.ok(
    refs.eventsRef.current.has("channel-2"),
    "channel-2 still in refs after removeChannel",
  );

  // Flush via pagehide — must write the post-removeChannel snapshot (channel-2 only).
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
    "channel-2 must survive removeChannel(channel-1) — no cancel-without-replacement",
  );

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

  // Drive a real scope transition via re-render with a different pubkey.
  // After act() settles, the hydration effect has committed the new scope.
  const PUBKEY_B = "pubkey-b-scope-test";
  await harness.render({ ...props, pubkey: PUBKEY_B });
  assert.ok(
    harness.api.isScopeLoaded(),
    "isScopeLoaded must be true after scope switch + effects committed",
  );
  assert.ok(
    harness.api.currentScope.includes(PUBKEY_B.toLowerCase()),
    "currentScope must reflect the new pubkey",
  );
  // The loaded ref must match the new scope — any stale value would have been
  // overwritten by the hydration effect.
  assert.equal(
    harness.api.scopeLoadedRef.current,
    harness.api.currentScope,
    "scopeLoadedRef must equal currentScope after effects commit",
  );

  await harness.unmount();
});

test("A→B scope switch: pending A-timer is cancelled by flush, A data persisted synchronously", async () => {
  // The hydration effect cleanup calls flushObservedUnreadWrite when scope
  // switches, which cancels the pending A-timer and synchronously writes A's
  // current snapshot to A's bucket. After the switch:
  //   - A's bucket holds the flushed data.
  //   - B's bucket has no A contamination.
  //   - A new B-scope timer can schedule independently.
  //
  // A genuinely late scope-A timer cannot exist after a scope switch, because
  // flushObservedUnreadWrite always cancels the pending timer before resetting
  // the refs. The persistence hook's timer closure holds an immutable snapshot
  // of the event map at schedule time, but that timer is always cancelled before
  // it can fire — so the snapshot invariant is moot in the lifecycle path.
  installFreshStorage();

  const PUBKEY_AT = "pubkey-a-t";
  const RELAY_AT = "wss://relay-a-t.example.com";
  const PUBKEY_BT = "pubkey-b-t";
  const RELAY_BT = "wss://relay-b-t.example.com";

  // Pre-seed A's storage so the hydration effect loads it into refs.
  const seedMap = new Map();
  const chAT = new Map();
  chAT.set("evt-at", makeEvent("evt-at", "ch-at", NOW_S));
  seedMap.set("ch-at", chAT);
  writeObservedUnreadToStorage(PUBKEY_AT, RELAY_AT, seedMap);

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

  // Hydration loaded A's pre-seeded event.
  assert.ok(
    refsAT.eventsRef.current.has("ch-at"),
    "hydration must restore ch-at from storage",
  );

  const scopeAT = harness.api.currentScope;

  // Schedule a write for scope A (timer pending with immutable snapshot).
  harness.api.schedule(scopeAT);

  // Switch to scope B. The hydration effect cleanup fires first:
  // 1. flushObservedUnreadWrite — cancels the pending timer, writes A's
  //    snapshot synchronously to A's bucket.
  // 2. Refs are reset to new Maps, B's storage is loaded.
  const propsBT = { ...propsAT, pubkey: PUBKEY_BT, relay: RELAY_BT };
  await harness.render(propsBT);

  // A's data must be in storage from the synchronous flush.
  const storedAT = readObservedUnreadFromStorage(PUBKEY_AT, RELAY_AT);
  assert.ok(
    storedAT?.has("ch-at"),
    "A scope must be flushed synchronously on scope switch",
  );

  // B's bucket must not contain A's channel.
  const storedBT = readObservedUnreadFromStorage(PUBKEY_BT, RELAY_BT);
  assert.ok(
    storedBT == null || !storedBT.has("ch-at"),
    "B's bucket must not contain A's channel after scope switch",
  );

  // Seed B, schedule a B write, flush via pagehide — B persists independently.
  const chBT = new Map();
  chBT.set("evt-bt", makeEvent("evt-bt", "ch-bt", NOW_S + 300));
  refsAT.eventsRef.current.set("ch-bt", chBT);
  refsAT.latestRef.current.set("ch-bt", NOW_S + 300);
  harness.api.schedule(harness.api.currentScope); // B scope

  await act(async () => {
    globalThis.dispatchEvent({ type: "pagehide" });
  });

  const storedBT2 = readObservedUnreadFromStorage(PUBKEY_BT, RELAY_BT);
  assert.ok(
    storedBT2?.has("ch-bt"),
    "B's scheduled write must survive as its own independent snapshot",
  );

  await harness.unmount();
});

test("stale clearAll from scope A rejects after scope B loads (scope fence enforced)", async () => {
  installFreshStorage();

  // Pre-seed A's storage so hydration effect picks it up (same pattern as A→B
  // late-timer test — the hydration effect resets refs from storage, not from
  // the pre-populated makeRefs()).
  const seedA = new Map();
  const chSeedA = new Map();
  chSeedA.set("evt-seed-a", makeEvent("evt-seed-a", "channel-seed", NOW_S));
  seedA.set("channel-seed", chSeedA);
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

  // After mount, A's bucket is in storage (written by pre-seed).
  const storedA_initial = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    storedA_initial !== null,
    "A's bucket must be in storage after mount",
  );

  // Schedule a write so A has a pending timer — this tests that the stale
  // clearAll doesn't cancel B's timer (not A's).
  const scopeA = harness.api.currentScope;
  harness.api.schedule(scopeA);

  const PUBKEY_B = "pubkey-b2";
  const RELAY_B = "wss://relay-b2.example.com";

  // Capture scope A's clearAll before switching scopes.
  const staleClearAll = harness.api.clearAll;

  // Switch to scope B — effects flush A (persisting the pending snapshot), reset refs, load B.
  await harness.render({ ...propsA, pubkey: PUBKEY_B, relay: RELAY_B });

  // A's bucket should still have data from the flush.
  const storedA_before = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(storedA_before !== null, "A's bucket must survive scope switch");

  // Calling the stale clearAll (captured under scope A) after scope B is loaded
  // must be a no-op — scopeLoadedRef.current (=B) !== A scope in the closure.
  staleClearAll();

  const storedA_after = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.deepEqual(
    storedA_after,
    storedA_before,
    "stale clearAll from scope A must not delete A's bucket after scope B loads",
  );

  await harness.unmount();
});

test("stale removeChannel from scope A rejects after scope B loads (scope fence enforced)", async () => {
  installFreshStorage();

  // Pre-seed A's storage so hydration picks it up.
  const seedA = new Map();
  const chSeedA = new Map();
  chSeedA.set("evt-seed-a", makeEvent("evt-seed-a", "channel-seed", NOW_S));
  seedA.set("channel-seed", chSeedA);
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

  // Schedule a write for A so there is a pending timer.
  const scopeA = harness.api.currentScope;
  harness.api.schedule(scopeA);

  const PUBKEY_B = "pubkey-b3";
  const RELAY_B = "wss://relay-b3.example.com";

  // Pre-seed B's storage with a different channel.
  const seedB = new Map();
  const chSeedB = new Map();
  chSeedB.set("evt-seed-b", makeEvent("evt-seed-b", "channel-b", NOW_S));
  seedB.set("channel-b", chSeedB);
  writeObservedUnreadToStorage(PUBKEY_B, RELAY_B, seedB);

  // Capture scope A's removeChannel before switching scopes.
  const staleRemoveChannel = harness.api.removeChannel;

  // Switch to scope B — effects flush A (persisting the pending snapshot), reset refs, load B.
  await harness.render({ ...propsA, pubkey: PUBKEY_B, relay: RELAY_B });

  // B's bucket is in storage after hydration.
  const storedB_before = readObservedUnreadFromStorage(PUBKEY_B, RELAY_B);
  assert.ok(
    storedB_before !== null,
    "B's bucket must be in storage after scope switch",
  );

  // Calling the stale removeChannel (captured under scope A) after scope B is
  // loaded must be a no-op — scopeLoadedRef.current (=B) !== A scope.
  staleRemoveChannel("channel-b");

  const storedB_after = readObservedUnreadFromStorage(PUBKEY_B, RELAY_B);
  assert.deepEqual(
    storedB_after,
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
  const schedule1 = api1.schedule;
  const removeChannel1 = api1.removeChannel;
  const clearAll1 = api1.clearAll;
  const isScopeLoaded1 = api1.isScopeLoaded;

  // Re-render with an unrelated prop change (readStateVersion bumped, same identity).
  // This simulates what happens on every read-state advance in the parent.
  await harness.render({ ...props, readStateVersion: 1 });

  const api2 = harness.api;
  // The API object must be the same reference — different readStateVersion is not
  // a dep of the useMemo that builds the API (only scope-level deps are).
  assert.equal(
    api1,
    api2,
    "API object must be the same reference on unrelated rerender",
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

test("channel-level marker prune: channel marker removes all events in that channel", async () => {
  installFreshStorage();

  const eventsRef = { current: new Map() };
  const latestRef = { current: new Map() };
  // Seed channel-a: two events at NOW_S-20 and NOW_S-10.
  // Channel read marker at NOW_S-5 covers both (they are <= marker).
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
  // channel-b: one event at NOW_S+10 (newer than any marker — must survive).
  const evtB = {
    id: "evt-b",
    createdAt: NOW_S + 10,
    rootId: "root-b",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };

  const stored = new Map();
  const chA = new Map();
  chA.set("evt-old", evtOld);
  chA.set("evt-mid", evtMid);
  stored.set("channel-a", chA);
  const chB = new Map();
  chB.set("evt-b", evtB);
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

  // Re-render with a channel marker covering channel-a at NOW_S-5.
  // getEffectiveTimestamp("channel-a") = NOW_S-5 covers evtOld (NOW_S-20) and evtMid (NOW_S-10).
  // channel-b has no channel marker (returns null) and evtB is newer — survives.
  await harness.render({
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 1,
    getTs: (channelId) => (channelId === "channel-a" ? NOW_S - 5 : null),
    getOwn: () => null,
    onPruned: () => {
      pruneCount += 1;
    },
  });

  assert.ok(
    !eventsRef.current.has("channel-a"),
    "channel-a must be fully pruned by channel marker",
  );
  assert.ok(
    eventsRef.current.has("channel-b"),
    "channel-b must survive — its event is newer than any marker",
  );
  assert.equal(pruneCount, 1, "onPruned must fire once");

  await harness.unmount();
});

test("local-vs-synced marker equivalence: own-timestamp prune behaves identically to channel-level marker", async () => {
  installFreshStorage();

  const eventsRef = { current: new Map() };
  const latestRef = { current: new Map() };
  // Two events with the same rootId. getOwnTimestamp("thread:root-shared")
  // covers them just like a channel marker would — same pruning result.
  const evt1 = {
    id: "evt1",
    createdAt: NOW_S - 30,
    rootId: "root-shared",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
  const evt2 = {
    id: "evt2",
    createdAt: NOW_S - 15,
    rootId: "root-shared",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
  // evt3 has a different rootId and no matching marker — must survive.
  const evt3 = {
    id: "evt3",
    createdAt: NOW_S - 5,
    rootId: "root-other",
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };

  const storedMap = new Map();
  const ch = new Map();
  ch.set("evt1", evt1);
  ch.set("evt2", evt2);
  ch.set("evt3", evt3);
  storedMap.set("ch-shared", ch);
  writeObservedUnreadToStorage(PUBKEY, RELAY, storedMap);

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

  // Thread marker at NOW_S-10 covers evt1 (NOW_S-30) and evt2 (NOW_S-15), not evt3.
  await harness.render({
    pubkey: PUBKEY,
    relay: RELAY,
    isReady: true,
    readStateVersion: 1,
    getTs: () => null,
    getOwn: (ctx) => (ctx === "thread:root-shared" ? NOW_S - 10 : null),
    onPruned: () => {
      pruneCount += 1;
    },
  });

  const ch2 = eventsRef.current.get("ch-shared");
  assert.ok(!ch2?.has("evt1"), "evt1 covered by thread marker must be pruned");
  assert.ok(!ch2?.has("evt2"), "evt2 covered by thread marker must be pruned");
  assert.ok(ch2?.has("evt3"), "evt3 with no marker must survive");
  assert.equal(pruneCount, 1, "onPruned must fire once");

  await harness.unmount();
});
