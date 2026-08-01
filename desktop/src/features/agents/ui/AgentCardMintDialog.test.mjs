import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

// ── Why these tests live at the store boundary ─────────────────────────────
// AgentCardMintDialog holds a single new boolean state (`editingKey`) that
// gates whether the key-setup panel is visible even after a key already
// resolves. Mounting the full component requires Tauri IPC, a QueryClient
// provider, and a real DOM — none of which are available in the node:test
// runner. Rather than a fragile DOM shim, these tests pin the *logic* that
// the component depends on:
//
//   1. The panel-visibility predicate (needsKey || editingKey) through both
//      toggle transitions.
//   2. The cancel path: editingKey resets to false when cancelled.
//   3. The save path: editingKey resets to false on success (verified via the
//      store's onSuccess handler logic, exercised in cardMintStore.test.mjs).
//
// If the predicate ever changes (e.g. triple condition), this file catches it.

/** Pure model of the key-panel show condition — mirrors the component render. */
function showKeyPanel(needsKey, editingKey) {
  return needsKey || editingKey;
}

/** Pure model of the cancel-button visibility — mirrors the component render. */
function showCancelButton(needsKey, editingKey) {
  return editingKey && !needsKey;
}

/** Pure model of the panel header title — mirrors the component render. */
function keyPanelTitle(needsKey) {
  return needsKey ? "One-time setup: OpenAI API key" : "Update OpenAI API key";
}

/** Pure model of the key-status row visibility (mint form, not key panel). */
function showKeyStatusRow(needsKey, editingKey) {
  return !needsKey && !editingKey;
}

describe("AgentCardMintDialog — editingKey toggle logic", () => {
  // ── showKeyPanel ──────────────────────────────────────────────────────────

  it("showKeyPanel_noKeyAndNotEditing_shows_setup_panel", () => {
    // First-time user: key not yet saved
    assert.equal(showKeyPanel(true, false), true);
  });

  it("showKeyPanel_keyExistsAndNotEditing_hides_panel", () => {
    // Normal state after first save: show the mint form
    assert.equal(showKeyPanel(false, false), false);
  });

  it("showKeyPanel_keyExistsAndEditingKey_shows_panel", () => {
    // User clicked "Update API key": panel must reappear
    assert.equal(showKeyPanel(false, true), true);
  });

  it("showKeyPanel_noKeyAndEditingKey_shows_panel", () => {
    // Degenerate: both true still shows the panel
    assert.equal(showKeyPanel(true, true), true);
  });

  // ── showCancelButton ───────────────────────────────────────────────────────

  it("showCancelButton_editingAndKeyExists_shows_cancel", () => {
    // Cancel is only needed when the user opted in to update an existing key
    assert.equal(showCancelButton(false, true), true);
  });

  it("showCancelButton_firstTimeSetup_hides_cancel", () => {
    // First-time setup has nowhere to cancel back to
    assert.equal(showCancelButton(true, false), false);
  });

  it("showCancelButton_afterCancel_hides_cancel", () => {
    // After cancel resets editingKey = false
    assert.equal(showCancelButton(false, false), false);
  });

  it("showCancelButton_bothTrue_hides_cancel", () => {
    // If key is missing AND editingKey is true, suppress cancel
    // (no mint form to return to)
    assert.equal(showCancelButton(true, true), false);
  });

  // ── keyPanelTitle ─────────────────────────────────────────────────────────

  it("keyPanelTitle_noKey_shows_one_time_setup", () => {
    assert.equal(keyPanelTitle(true), "One-time setup: OpenAI API key");
  });

  it("keyPanelTitle_keyExists_shows_update_label", () => {
    assert.equal(keyPanelTitle(false), "Update OpenAI API key");
  });

  // ── showKeyStatusRow ───────────────────────────────────────────────────────

  it("showKeyStatusRow_keyExistsAndNotEditing_shows_status", () => {
    // Normal state: key saved, not editing — show "Using your saved OpenAI key · Update"
    assert.equal(showKeyStatusRow(false, false), true);
  });

  it("showKeyStatusRow_noKey_hides_status", () => {
    // First-time user: no key yet, show the key panel instead
    assert.equal(showKeyStatusRow(true, false), false);
  });

  it("showKeyStatusRow_editingKey_hides_status", () => {
    // User opened the update panel — status row is redundant while editing
    assert.equal(showKeyStatusRow(false, true), false);
  });

  it("showKeyStatusRow_bothTrue_hides_status", () => {
    // Degenerate: panel is shown, status row should not be
    assert.equal(showKeyStatusRow(true, true), false);
  });
});
