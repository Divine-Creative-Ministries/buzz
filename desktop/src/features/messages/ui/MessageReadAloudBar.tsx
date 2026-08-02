import * as React from "react";
import { LoaderCircle, Pause, Play, RotateCcw, Volume2, X } from "lucide-react";

import {
  pauseMessageReadAloud,
  resumeMessageReadAloud,
  retryMessageReadAloud,
  stopMessageReadAloud,
  useMessageReadAloud,
} from "@/features/messages/lib/messageReadAloud";
import { Button } from "@/shared/ui/button";

export function MessageReadAloudBar() {
  const playback = useMessageReadAloud();
  const [showPreparing, setShowPreparing] = React.useState(false);
  React.useEffect(() => {
    if (playback.status !== "preparing") {
      setShowPreparing(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowPreparing(true), 200);
    return () => window.clearTimeout(timeout);
  }, [playback.status]);
  if (
    playback.status === "idle" ||
    playback.status === "finished" ||
    (playback.status === "preparing" && !showPreparing) ||
    !playback.messageId
  ) {
    return null;
  }

  const isPaused = playback.status === "paused";
  const isError = playback.status === "error";
  const isPreparing = playback.status === "preparing";
  // The native Pocket engine supports play/stop only — the X button stops.
  const canPause = playback.engine === "web";

  return (
    <div
      aria-live="polite"
      className="mx-5 mb-1 flex min-h-10 items-center gap-2 rounded-xl border border-border/70 bg-background/95 px-2.5 py-1.5 text-sm shadow-xs backdrop-blur-sm"
      data-testid="message-read-aloud-bar"
    >
      {isPreparing ? (
        <LoaderCircle
          aria-hidden
          className="h-4 w-4 shrink-0 animate-spin text-primary"
        />
      ) : (
        <Volume2 aria-hidden className="h-4 w-4 shrink-0 text-primary" />
      )}
      <p className="min-w-0 flex-1 truncate text-muted-foreground">
        {isError ? (
          (playback.error ?? "Couldn't play audio. Try again.")
        ) : isPreparing ? (
          "Preparing audio…"
        ) : (
          <>
            Reading message from{" "}
            <span className="font-medium text-foreground">
              {playback.author}
            </span>
          </>
        )}
      </p>
      {isError ? (
        <Button
          aria-label="Retry reading message"
          className="h-8 gap-1.5 px-2.5"
          onClick={retryMessageReadAloud}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RotateCcw aria-hidden className="h-4 w-4" />
          Retry
        </Button>
      ) : isPreparing || !canPause ? null : (
        <Button
          aria-label={isPaused ? "Resume reading" : "Pause reading"}
          className="h-8 w-8 rounded-full p-0"
          onClick={isPaused ? resumeMessageReadAloud : pauseMessageReadAloud}
          size="sm"
          type="button"
          variant="ghost"
        >
          {isPaused ? (
            <Play aria-hidden className="h-4 w-4" />
          ) : (
            <Pause aria-hidden className="h-4 w-4" />
          )}
        </Button>
      )}
      <Button
        aria-label="Stop reading"
        className="h-8 w-8 rounded-full p-0"
        onClick={stopMessageReadAloud}
        size="sm"
        type="button"
        variant="ghost"
      >
        <X aria-hidden className="h-4 w-4" />
      </Button>
    </div>
  );
}
