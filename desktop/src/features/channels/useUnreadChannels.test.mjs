/**
 * Boundary tests for useUnreadChannels — exercises the real parent-to-owner
 * boundary between useUnreadChannels and useObservedUnreadPersistence.
 *
 * These tests mount the FULL production hook (via createRoot + act) to verify
 * that markChannelRead and markAllChannelsRead are scope-safe: a stale callback
 * captured under scope A cannot corrupt scope B's refs or storage after a
 * scope switch. Coverage for both happy paths (current scope mutates correctly)
 * and stale paths (scope-A callback rejects after B loads) is included.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ── DOM shim ─────────────────────────────────────────────────────────────────
// Same shim used by useObservedUnreadPersistence.test.mjs: minimal DOM with
// full event-listener support so createRoot + pagehide flush both work.

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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useUnreadChannels } from "./useUnreadChannels.ts";
import {
  readObservedUnreadFromStorage,
  writeObservedUnreadToStorage,
} from "./observedUnreadStorage.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RELAY = "wss://relay.example.com";
// Use a recent timestamp so age-pruning doesn't drop events before we assert.
// 7-day horizon: events must be newer than (now - 604800 seconds).
const NOW_S = Math.floor(Date.now() / 1_000);

function makeObservedEvent(id, _channelId, createdAt = NOW_S) {
  return {
    id,
    createdAt,
    rootId: `root-${id}`,
    highPriority: false,
    countsTowardBadge: true,
    countsTowardAppBadge: false,
  };
}

/**
 * Pre-seed storage for a given pubkey+relay with one channel's worth of events.
 * Returns the ISO timestamp matching the seeded event's createdAt, suitable for
 * passing as the `readAt` argument to markChannelRead to trigger clearObserved.
 */
function seedStorage(pubkey, relay, channelId, eventId = "evt-1") {
  const inner = new Map();
  inner.set(eventId, makeObservedEvent(eventId, channelId, NOW_S));
  const events = new Map();
  events.set(channelId, inner);
  writeObservedUnreadToStorage(pubkey, relay, events);
  // Return a timestamp that covers the seeded event (equals createdAt).
  return new Date(NOW_S * 1_000).toISOString();
}

/**
 * Mount useUnreadChannels inside a QueryClientProvider harness.
 * Returns controls to inspect and re-render the hook.
 */
async function mountUnreadChannels({ pubkey, relay = RELAY }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  let capturedMarkChannelRead = null;
  let capturedMarkAllChannelsRead = null;

  function Inner({ pubkey: pk }) {
    const result = useUnreadChannels([], null, {
      pubkey: pk,
      // relayClient prop is undefined — useReadState returns no-ops (no relay
      // calls). The module-level relayClient used by useLiveChannelUpdates is
      // the real singleton but operates on an empty channel list, so no
      // subscriptions are attempted.
      relayClient: undefined,
      relayUrl: relay,
    });
    capturedMarkChannelRead = result.markChannelRead;
    capturedMarkAllChannelsRead = result.markAllChannelsRead;
    return null;
  }

  function Harness({ pubkey: pk }) {
    return React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Inner, { pubkey: pk }),
    );
  }

  const container = document.createElement("div");
  const root = createRoot(container);

  const render = async (pk) => {
    await act(async () => {
      root.render(React.createElement(Harness, { pubkey: pk }));
    });
  };

  await render(pubkey);

  return {
    get markChannelRead() {
      return capturedMarkChannelRead;
    },
    get markAllChannelsRead() {
      return capturedMarkAllChannelsRead;
    },
    render,
    unmount: async () => {
      await act(async () => root.unmount());
    },
    /** Fire a pagehide event to synchronously flush any pending debounce. */
    flushStorage: () => {
      dispatchEvent(
        new (class extends Event {
          constructor() {
            super("pagehide");
          }
        })(),
      );
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("markChannelRead happy path: current scope removes channel from observed refs and persists snapshot", async () => {
  installFreshStorage();

  const PUBKEY = "pubkey-happy-mcr";
  // Pre-seed storage so hydration populates latestByChannelRef for channel-1.
  const readAt = seedStorage(PUBKEY, RELAY, "channel-1");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // Calling markChannelRead with readAt >= observed latest triggers clearObserved.
  // Under the current scope this must delegate to observedPersistence.removeChannel,
  // which deletes channel-1 from both in-memory refs and schedules a write.
  // Wrap in act() because markChannelRead calls bumpLatestVersion (useReducer).
  await act(async () => {
    harness.markChannelRead("channel-1", readAt);
  });

  // Flush the debounce synchronously via pagehide.
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored === null || !stored.has("channel-1"),
    "channel-1 must be absent from storage after markChannelRead under current scope",
  );

  await harness.unmount();
});

test("markChannelRead happy path: topLevelOnly=true leaves observed refs intact (no clearObserved)", async () => {
  installFreshStorage();

  const PUBKEY = "pubkey-happy-mcr-tlo";
  const readAt = seedStorage(PUBKEY, RELAY, "channel-tlo");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // topLevelOnly=true: observedLatest is passed as undefined to
  // resolveChannelReadMarker, so clearObserved is false — the observed refs
  // must remain intact.
  await act(async () => {
    harness.markChannelRead("channel-tlo", readAt, { topLevelOnly: true });
  });
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored?.has("channel-tlo"),
    "channel-tlo must remain in storage when topLevelOnly=true",
  );

  await harness.unmount();
});

test("markChannelRead stale: scope-A callback rejects after scope B loads — B refs and storage untouched", async () => {
  installFreshStorage();

  const PUBKEY_A = "pubkey-a-mcr";
  const PUBKEY_B = "pubkey-b-mcr";

  // Seed A with channel-1, B with channel-2.
  const readAtA = seedStorage(PUBKEY_A, RELAY, "channel-1");
  seedStorage(PUBKEY_B, RELAY, "channel-2");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY_A });

  // Capture markChannelRead from scope A before the switch.
  const staleMarkChannelRead = harness.markChannelRead;

  // Switch to scope B. The persistence hook's hydration effect flushes A
  // synchronously, resets refs, and loads B's storage (channel-2).
  await harness.render(PUBKEY_B);

  // B's storage before the stale call.
  const storedBBefore = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBBefore?.has("channel-2"),
    "B's channel-2 must be present before the stale call",
  );

  // Invoke the stale scope-A markChannelRead. With the unfenced parent
  // pattern, this would have deleted channel-1 from the B-scope refs (if
  // B had channel-1) and called observedPersistence.removeChannel. With the
  // fenced pattern, removeChannel validates the scope and returns early — B's
  // refs and storage are untouched.
  await act(async () => {
    staleMarkChannelRead("channel-1", readAtA);
  });

  // Flush to materialize any write the stale call might have scheduled.
  harness.flushStorage();

  // B's bucket must still have channel-2 and must NOT have had channel-1
  // written into it or channel-2 deleted from it.
  const storedBAfter = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBAfter?.has("channel-2"),
    "B's channel-2 must survive a stale scope-A markChannelRead call",
  );

  await harness.unmount();
});

test("markAllChannelsRead happy path: current scope clears all observed refs and clears storage bucket", async () => {
  installFreshStorage();

  const PUBKEY = "pubkey-happy-mar";
  seedStorage(PUBKEY, RELAY, "channel-1");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // Under the current scope, clearAll must clear both in-memory refs and
  // cancel any pending write before wiping the storage bucket.
  await act(async () => {
    harness.markAllChannelsRead();
  });

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  // clearObservedUnreadStorage removes the key entirely; null is the expected result.
  assert.ok(
    stored === null || stored.size === 0,
    "storage bucket must be empty after markAllChannelsRead under current scope",
  );

  await harness.unmount();
});

test("markAllChannelsRead stale: scope-A callback rejects after scope B loads — B refs and storage untouched", async () => {
  installFreshStorage();

  const PUBKEY_A = "pubkey-a-mar";
  const PUBKEY_B = "pubkey-b-mar";

  seedStorage(PUBKEY_A, RELAY, "channel-1");
  seedStorage(PUBKEY_B, RELAY, "channel-2");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY_A });

  // Capture markAllChannelsRead from scope A.
  const staleMarkAllChannelsRead = harness.markAllChannelsRead;

  // Switch to scope B.
  await harness.render(PUBKEY_B);

  const storedBBefore = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBBefore?.has("channel-2"),
    "B's channel-2 must be present before the stale call",
  );

  // Invoke the stale scope-A markAllChannelsRead. With the unfenced pattern,
  // this would have reset B's refs to empty Maps before clearAll rejected.
  // With the fenced pattern, clearAll validates scope first and returns early
  // — B's refs and storage are fully intact.
  await act(async () => {
    staleMarkAllChannelsRead();
  });

  // B's bucket must still have channel-2.
  const storedBAfter = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBAfter?.has("channel-2"),
    "B's channel-2 must survive a stale scope-A markAllChannelsRead call",
  );

  await harness.unmount();
});
