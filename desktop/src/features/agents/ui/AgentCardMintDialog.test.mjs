import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Tests for the key-panel visibility derivations that AgentCardMintDialog
// imports from cardMintKeyUtils. These tests exercise the exact production
// module — changes to any exported function will cause failures here.

import {
  isReadOnlyLayer,
  isWritableLayer,
  showCancelButton,
  showKeyPanel,
  showKeyStatusRow,
} from "./cardMintKeyUtils.ts";

describe("cardMintKeyUtils — key panel derivations", () => {
  // ── isWritableLayer ────────────────────────────────────────────────────────

  it("isWritableLayer_none_true", () => {
    assert.equal(isWritableLayer("none"), true);
  });

  it("isWritableLayer_global_true", () => {
    assert.equal(isWritableLayer("global"), true);
  });

  it("isWritableLayer_agent_false", () => {
    assert.equal(isWritableLayer("agent"), false);
  });

  it("isWritableLayer_persona_false", () => {
    assert.equal(isWritableLayer("persona"), false);
  });

  it("isWritableLayer_process_false", () => {
    assert.equal(isWritableLayer("process"), false);
  });

  it("isWritableLayer_undefined_false", () => {
    // Unknown (pending/error) — don't offer a write path
    assert.equal(isWritableLayer(undefined), false);
  });

  // ── isReadOnlyLayer ────────────────────────────────────────────────────────

  it("isReadOnlyLayer_agent_true", () => {
    assert.equal(isReadOnlyLayer("agent"), true);
  });

  it("isReadOnlyLayer_persona_true", () => {
    assert.equal(isReadOnlyLayer("persona"), true);
  });

  it("isReadOnlyLayer_process_true", () => {
    assert.equal(isReadOnlyLayer("process"), true);
  });

  it("isReadOnlyLayer_global_false", () => {
    assert.equal(isReadOnlyLayer("global"), false);
  });

  it("isReadOnlyLayer_none_false", () => {
    assert.equal(isReadOnlyLayer("none"), false);
  });

  it("isReadOnlyLayer_undefined_false", () => {
    assert.equal(isReadOnlyLayer(undefined), false);
  });

  // ── showKeyPanel ───────────────────────────────────────────────────────────

  it("showKeyPanel_none_notEditing_shows", () => {
    // First-time user: key not set → show setup panel
    assert.equal(showKeyPanel("none", false), true);
  });

  it("showKeyPanel_global_notEditing_hides", () => {
    // Normal state: key in global defaults, not editing → show mint form
    assert.equal(showKeyPanel("global", false), false);
  });

  it("showKeyPanel_global_editing_shows", () => {
    // User clicked Update → show the update panel
    assert.equal(showKeyPanel("global", true), true);
  });

  it("showKeyPanel_agent_notEditing_shows", () => {
    // Read-only layer: always show the read-only redirect panel
    assert.equal(showKeyPanel("agent", false), true);
  });

  it("showKeyPanel_persona_notEditing_shows", () => {
    assert.equal(showKeyPanel("persona", false), true);
  });

  it("showKeyPanel_process_notEditing_shows", () => {
    assert.equal(showKeyPanel("process", false), true);
  });

  it("showKeyPanel_undefined_notEditing_hides", () => {
    // Query pending/error → show mint form (fail-open, no panel claim)
    assert.equal(showKeyPanel(undefined, false), false);
  });

  // ── showCancelButton ───────────────────────────────────────────────────────

  it("showCancelButton_global_editing_shows", () => {
    // Update mode for a global key: Cancel returns to the mint form
    assert.equal(showCancelButton("global", true), true);
  });

  it("showCancelButton_none_editing_hides", () => {
    // First-time setup: no cancel (no mint form to return to)
    assert.equal(showCancelButton("none", true), false);
  });

  it("showCancelButton_global_notEditing_hides", () => {
    assert.equal(showCancelButton("global", false), false);
  });

  it("showCancelButton_agent_editing_hides", () => {
    // Read-only layer: no Cancel (user didn't enter update mode voluntarily)
    assert.equal(showCancelButton("agent", true), false);
  });

  // ── showKeyStatusRow ───────────────────────────────────────────────────────

  it("showKeyStatusRow_global_notEditing_shows", () => {
    // Confirmed writable key: show "Using your saved OpenAI key · Update"
    assert.equal(showKeyStatusRow("global", false), true);
  });

  it("showKeyStatusRow_global_editing_hides", () => {
    // In update panel: status row is redundant while editing
    assert.equal(showKeyStatusRow("global", true), false);
  });

  it("showKeyStatusRow_none_notEditing_hides", () => {
    // No key: show setup panel, not status row
    assert.equal(showKeyStatusRow("none", false), false);
  });

  it("showKeyStatusRow_agent_notEditing_hides", () => {
    // Read-only layer: panel is shown, not the status row
    assert.equal(showKeyStatusRow("agent", false), false);
  });

  it("showKeyStatusRow_undefined_notEditing_hides", () => {
    // Query pending/error: do not assert key existence
    assert.equal(showKeyStatusRow(undefined, false), false);
  });
});
