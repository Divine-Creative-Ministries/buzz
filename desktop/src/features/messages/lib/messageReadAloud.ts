import * as React from "react";

export type MessageReadAloudStatus =
  | "idle"
  | "preparing"
  | "playing"
  | "paused"
  | "finished"
  | "error";

/**
 * Which speech backend is driving the current playback.
 *
 * "native" is the Pocket TTS pipeline in the Tauri backend — the same engine
 * and selected Settings voice the huddle uses. "web" is the browser's
 * `speechSynthesis`, kept as the fallback for non-Tauri contexts (web dev
 * server, e2e mock bridge). Native supports play/stop only; pause/resume is
 * web-only.
 */
export type MessageReadAloudEngine = "native" | "web";

export type MessageReadAloudState = {
  author: string;
  engine: MessageReadAloudEngine;
  error: string | null;
  messageId: string | null;
  status: MessageReadAloudStatus;
  text: string;
};

const IDLE_STATE: MessageReadAloudState = {
  author: "",
  engine: "web",
  error: null,
  messageId: null,
  status: "idle",
  text: "",
};

let state = IDLE_STATE;
let activeUtterance: SpeechSynthesisUtterance | null = null;
let nativeSessionCounter = 0;
let currentNativeSessionId: string | null = null;
let nativeStartedListenerReady: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: MessageReadAloudState) {
  state = next;
  for (const listener of listeners) listener();
}

function speechEngine() {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

function nativeEngineAvailable() {
  if (typeof window === "undefined") return false;
  const globals = window as unknown as Record<string, unknown>;
  // The e2e mock bridge defines __TAURI_INTERNALS__ but not the read-aloud
  // commands — specs drive the web engine through a speechSynthesis mock.
  return (
    "__TAURI_INTERNALS__" in globals &&
    !("__BUZZ_E2E_INVOKE_MOCK_COMMAND__" in globals)
  );
}

/** Flatten common Markdown markers while preserving every readable word. */
export function messageTextForSpeech(markdown: string) {
  const codeSpans: string[] = [];
  const preserveCode = (text: string) => {
    const index = codeSpans.push(text) - 1;
    return `${index}`;
  };

  return markdown
    .replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, (_match, code: string) =>
      preserveCode(code),
    )
    .replace(/`([^`]+)`/g, (_match, code: string) => preserveCode(code))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(?<!\w)__([^_\n]+)__(?!\w)/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(
      /(\d+)/g,
      (_match, index: string) => codeSpans[Number(index)] ?? "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readAloudErrorMessage(error: unknown) {
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Couldn't play audio. Try again.";
}

function ensureNativeStartedListener() {
  if (!nativeStartedListenerReady) {
    nativeStartedListenerReady = import("@tauri-apps/api/event").then(
      ({ listen }) =>
        listen<string>("message-read-aloud-started", (event) => {
          if (event.payload !== currentNativeSessionId) return;
          if (state.status !== "preparing") return;
          publish({ ...state, status: "playing" });
        }).then(() => undefined),
    );
  }
  return nativeStartedListenerReady;
}

async function beginNativeSpeech(
  messageId: string,
  author: string,
  text: string,
) {
  const sessionId = String(++nativeSessionCounter);
  currentNativeSessionId = sessionId;
  activeUtterance = null;
  speechEngine()?.cancel();
  publish({
    author,
    engine: "native",
    error: null,
    messageId,
    status: "preparing",
    text,
  });
  try {
    await ensureNativeStartedListener();
    const { invoke } = await import("@tauri-apps/api/core");
    const finished = await invoke<boolean>("speak_message_read_aloud", {
      sessionId,
      text,
    });
    if (currentNativeSessionId !== sessionId) return;
    currentNativeSessionId = null;
    if (finished) {
      publish({
        author,
        engine: "native",
        error: null,
        messageId,
        status: "finished",
        text,
      });
    } else if (state.messageId === messageId && state.status !== "idle") {
      publish(IDLE_STATE);
    }
  } catch (error) {
    if (currentNativeSessionId !== sessionId) return;
    currentNativeSessionId = null;
    console.error("message read aloud failed", error);
    publish({
      author,
      engine: "native",
      error: readAloudErrorMessage(error),
      messageId,
      status: "error",
      text,
    });
  }
}

function beginWebSpeech(messageId: string, author: string, text: string) {
  const engine = speechEngine();
  if (!engine || typeof SpeechSynthesisUtterance === "undefined") {
    publish({
      author,
      engine: "web",
      error: "Couldn't play audio. Try again.",
      messageId,
      status: "error",
      text,
    });
    return;
  }

  engine.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  activeUtterance = utterance;
  publish({
    author,
    engine: "web",
    error: null,
    messageId,
    status: "preparing",
    text,
  });

  utterance.onstart = () => {
    if (activeUtterance !== utterance) return;
    publish({
      author,
      engine: "web",
      error: null,
      messageId,
      status: "playing",
      text,
    });
  };
  utterance.onpause = () => {
    if (activeUtterance !== utterance) return;
    publish({
      author,
      engine: "web",
      error: null,
      messageId,
      status: "paused",
      text,
    });
  };
  utterance.onresume = () => {
    if (activeUtterance !== utterance) return;
    publish({
      author,
      engine: "web",
      error: null,
      messageId,
      status: "playing",
      text,
    });
  };
  utterance.onend = () => {
    if (activeUtterance !== utterance) return;
    activeUtterance = null;
    publish({
      author,
      engine: "web",
      error: null,
      messageId,
      status: "finished",
      text,
    });
  };
  utterance.onerror = (event) => {
    if (activeUtterance !== utterance || event.error === "canceled") return;
    activeUtterance = null;
    console.error("message read aloud failed", event.error);
    publish({
      author,
      engine: "web",
      error: "Couldn't play audio. Try again.",
      messageId,
      status: "error",
      text,
    });
  };

  engine.speak(utterance);
}

function speakText(messageId: string, author: string, text: string) {
  if (!text) {
    publish({
      author,
      engine: "web",
      error: "Couldn't play audio. Try again.",
      messageId,
      status: "error",
      text,
    });
    return;
  }
  if (nativeEngineAvailable()) {
    void beginNativeSpeech(messageId, author, text);
    return;
  }
  beginWebSpeech(messageId, author, text);
}

function beginSpeech(messageId: string, author: string, markdown: string) {
  speakText(messageId, author, messageTextForSpeech(markdown));
}

export function listenToMessage(
  messageId: string,
  author: string,
  markdown: string,
) {
  if (
    state.messageId === messageId &&
    state.status === "paused" &&
    state.engine === "web"
  ) {
    speechEngine()?.resume();
    return;
  }
  if (state.messageId === messageId && state.status === "playing") {
    if (state.engine === "native") {
      stopMessageReadAloud();
    } else {
      speechEngine()?.pause();
    }
    return;
  }
  beginSpeech(messageId, author, markdown);
}

export function pauseMessageReadAloud() {
  if (state.status === "playing" && state.engine === "web") {
    speechEngine()?.pause();
  }
}

export function resumeMessageReadAloud() {
  if (state.status === "paused" && state.engine === "web") {
    speechEngine()?.resume();
  }
}

export function retryMessageReadAloud() {
  // `state.text` is already flattened — do not re-run messageTextForSpeech,
  // which would treat code content (e.g. `__init__`) as Markdown markers.
  if (state.messageId) speakText(state.messageId, state.author, state.text);
}

function stopNativeSpeech() {
  currentNativeSessionId = null;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("stop_message_read_aloud"))
    .catch((error) => {
      console.error("message read aloud stop failed", error);
    });
}

export function stopMessageReadAloud() {
  if (
    state.engine === "native" &&
    (state.status === "preparing" || state.status === "playing")
  ) {
    stopNativeSpeech();
  }
  activeUtterance = null;
  speechEngine()?.cancel();
  publish(IDLE_STATE);
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", stopMessageReadAloud);
  window.addEventListener("pagehide", stopMessageReadAloud);
}

export function getMessageReadAloudState() {
  return state;
}

export function subscribeMessageReadAloud(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMessageReadAloud() {
  return React.useSyncExternalStore(
    subscribeMessageReadAloud,
    getMessageReadAloudState,
    getMessageReadAloudState,
  );
}

export function useMessageReadAloudForMessage(messageId: string) {
  const getSnapshot = React.useCallback(
    () => (state.messageId === messageId ? state : IDLE_STATE),
    [messageId],
  );
  return React.useSyncExternalStore(
    subscribeMessageReadAloud,
    getSnapshot,
    getSnapshot,
  );
}
