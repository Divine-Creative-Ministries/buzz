//! On-demand read-aloud of a single chat message through the local Pocket
//! TTS engine — the same pipeline (and selected Settings voice) the huddle
//! uses for agent speech.
//!
//! Mirrors the `preview_pocket_voice` structure: a short-lived pipeline per
//! request, completion detected by polling the pipeline's active flag. Only
//! one message plays at a time; starting a new one cancels the previous.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::app_state::AppState;

use super::models;
use super::tts::TtsPipeline;
use super::tts_settings::{current_settings, pocket_voice_reference};

/// Emitted (payload: the caller's `session_id`) when audio playback actually
/// starts, so the UI can move from "preparing" to "playing".
const STARTED_EVENT: &str = "message-read-aloud-started";

/// How long synthesis may run before the first audible sample. Matches the
/// voice-preview timeout.
const PLAYBACK_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Poll interval for the playback progress flags.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

/// Cancel flag for the in-flight message read-aloud playback, if any.
/// Starting a new read-aloud cancels the previous one; stop raises it.
static ACTIVE_CANCEL: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Swap the shared cancel slot, returning the previous occupant.
fn swap_active_cancel(next: Option<Arc<AtomicBool>>) -> Option<Arc<AtomicBool>> {
    let mut slot = ACTIVE_CANCEL
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    std::mem::replace(&mut *slot, next)
}

/// Speak `text` through the local Pocket TTS engine with the user's selected
/// Settings voice.
///
/// Resolves `Ok(true)` once playback finishes, `Ok(false)` when cancelled by
/// [`stop_message_read_aloud`] or a newer read-aloud request. Errors when the
/// voice files are not ready, no Pocket voice is available, or audio never
/// starts.
#[tauri::command]
pub async fn speak_message_read_aloud(
    session_id: String,
    text: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if text.trim().is_empty() {
        return Err("Nothing to read aloud".to_string());
    }
    if !models::is_tts_ready() {
        return Err("Voice files are still downloading. Try again shortly.".to_string());
    }
    let model_dir = models::tts_model_dir().ok_or("Pocket voice files are unavailable")?;
    let settings = current_settings(&state)?;
    let voice_name = pocket_voice_reference(&app, &settings.voice_preferences)?;
    let output_device = state
        .huddle_audio
        .output_device
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();

    // Only one message plays at a time — cancel whichever was still running.
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(previous) = swap_active_cancel(Some(Arc::clone(&cancel))) {
        previous.store(true, Ordering::Release);
    }
    let cancel_worker = Arc::clone(&cancel);

    let result = tokio::task::spawn_blocking(move || {
        let active = Arc::new(AtomicBool::new(false));
        let pipeline = TtsPipeline::new_with_voice(
            model_dir,
            Arc::clone(&active),
            Arc::clone(&cancel_worker),
            &voice_name,
            output_device,
            None,
        )?;
        pipeline.speak(text)?;
        let started = std::time::Instant::now();
        let mut heard_audio = false;
        loop {
            if cancel_worker.load(Ordering::Acquire) {
                return Ok(false);
            }
            let is_active = active.load(Ordering::Acquire);
            if is_active && !heard_audio {
                heard_audio = true;
                let _ = app.emit(STARTED_EVENT, &session_id);
            }
            if heard_audio && !is_active {
                return Ok(true);
            }
            if !heard_audio && started.elapsed() > PLAYBACK_START_TIMEOUT {
                return Err(
                    "Playback did not start. Check your audio output and try again.".to_string(),
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    })
    .await
    .map_err(|error| format!("Read-aloud task failed: {error}"))?;

    // Release the slot if it still belongs to this request so a stale Arc
    // doesn't linger after playback ends.
    {
        let mut slot = ACTIVE_CANCEL
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if slot.as_ref().is_some_and(|held| Arc::ptr_eq(held, &cancel)) {
            *slot = None;
        }
    }
    result
}

/// Stop the in-flight message read-aloud, if any.
#[tauri::command]
pub fn stop_message_read_aloud() {
    if let Some(cancel) = swap_active_cancel(None) {
        cancel.store(true, Ordering::Release);
    }
}
