import assert from "node:assert/strict";
import test from "node:test";

import { messageTextForSpeech } from "./messageReadAloud.ts";

test("messageTextForSpeech preserves readable words and removes Markdown", () => {
  assert.equal(
    messageTextForSpeech(
      "## **Update**\n\nRead [the guide](https://example.com), then run `buzz check`.\n\n```sh\nbuzz status\n```",
    ),
    "Update\n\nRead the guide, then run buzz check.\n\nbuzz status",
  );
});

test("messageTextForSpeech keeps image alt text and list content", () => {
  assert.equal(
    messageTextForSpeech("- First\n- ![Diagram](https://example.com/a.png)"),
    "First\nDiagram",
  );
});

test("messageTextForSpeech preserves code identifiers exactly", () => {
  assert.equal(
    messageTextForSpeech("Use `message_read_aloud.dart` and `__init__` next."),
    "Use message_read_aloud.dart and __init__ next.",
  );
});
