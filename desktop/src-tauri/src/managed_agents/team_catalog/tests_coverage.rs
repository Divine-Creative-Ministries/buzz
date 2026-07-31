//! Additional coverage tests for `team_catalog` — split from `tests.rs` to
//! stay under the file-size gate. Included via `#[path]` from `team_catalog.rs`.

use super::*;
use std::collections::BTreeMap;

fn member(id: &str, display_name: &str) -> AgentDefinition {
    AgentDefinition {
        id: id.to_string(),
        display_name: display_name.to_string(),
        avatar_url: None,
        system_prompt: "Do the work.".to_string(),
        runtime: Some("goose".to_string()),
        model: Some("claude-opus-4".to_string()),
        provider: Some("anthropic".to_string()),
        name_pool: vec!["Alpha".to_string()],
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        team_catalog_source: None,
        env_vars: BTreeMap::new(),
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: "2026-07-30T00:00:00Z".to_string(),
        updated_at: "2026-07-30T00:00:00Z".to_string(),
    }
}

fn team() -> crate::managed_agents::TeamRecord {
    crate::managed_agents::TeamRecord {
        id: "team-abc".to_string(),
        name: "Catalog Team".to_string(),
        description: Some("A shared team".to_string()),
        instructions: None,
        persona_ids: vec!["m1".to_string(), "m2".to_string()],
        is_builtin: false,
        shared: false,
        catalog_source: None,
        source_dir: Some(std::path::PathBuf::from("/local/only/path")),
        is_symlink: false,
        symlink_target: None,
        version: None,
        created_at: "2026-07-30T00:00:00Z".to_string(),
        updated_at: "2026-07-30T00:00:00Z".to_string(),
    }
}

// ── Untouched built-in projection ─────────────────────────────────────────

#[test]
fn test_real_builtin_without_avatar_mutation_projects_successfully() {
    // Retrieve the actual built-in record that `ensure_built_in_personas`
    // installs — no `avatar_url` mutation. The oversized avatar is stripped
    // inside `member_projection` (built-in path). If the logic is correct
    // the build succeeds and the projected member has no avatar field.
    let builtin =
        crate::managed_agents::built_in_persona_definition("builtin:fizz", "2026-07-30T00:00:00Z")
            .expect("builtin:fizz must exist");
    let has_large_avatar = builtin
        .avatar_url
        .as_deref()
        .is_some_and(|url| url.len() > MAX_AVATAR_URL_BYTES);
    let content = build_team_catalog_content(&team(), &[builtin]).expect(
        "a team containing a real built-in must project successfully without avatar mutation",
    );
    assert_eq!(content.members.len(), 1);
    if has_large_avatar {
        assert!(
            content.members[0].avatar_url.is_none(),
            "oversized built-in avatar must be omitted, not rejected"
        );
    }
    assert!(
        validate_team_catalog_content(&content).is_ok(),
        "projected content must pass full validation"
    );
}

// ── Tombstone transaction: rollback on INSERT failure ──────────────────────

#[test]
fn test_tombstone_transaction_rolls_back_delete_when_insert_fails() {
    // Use a `BEFORE INSERT` trigger to force the INSERT step to fail,
    // and verify the DELETE is rolled back (head still present after error).
    use crate::managed_agents::retention::{
        get_retained_event, open_retention_db, retain_event, scoped_retention_db_path,
        RetainedEvent,
    };
    use buzz_core_pkg::kind::KIND_TEAM_CATALOG;
    use nostr::JsonUtil;

    let dir = tempfile::tempdir().unwrap();
    let keys = nostr::Keys::generate();
    let owner = keys.public_key().to_hex();
    let db_path = scoped_retention_db_path(dir.path(), "wss://a.example", &owner);
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();

    let t = team();
    let m = member("m1", "Sentinel.");
    let head_event = build_team_catalog_event(&t, &[m], true)
        .unwrap()
        .sign_with_keys(&keys)
        .unwrap();
    let conn = open_retention_db(&db_path).unwrap();
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_TEAM_CATALOG,
            pubkey: owner.clone(),
            d_tag: "team-abc".to_string(),
            content: head_event.content.to_string(),
            created_at: head_event.created_at.as_secs() as i64,
            raw_event: head_event.as_json(),
            pending_sync: false,
        },
    )
    .unwrap();

    conn.execute_batch(
        "CREATE TRIGGER block_all_inserts BEFORE INSERT ON persona_events
         BEGIN
             SELECT RAISE(ABORT, 'insert blocked by test trigger');
         END;",
    )
    .unwrap();
    drop(conn);

    let result = tombstone_team_catalog_coordinate(&db_path, &keys, "team-abc");
    assert!(result.is_err(), "tombstone with INSERT trigger must fail");
    let err = result.unwrap_err();
    assert!(
        err.contains("insert blocked by test trigger") || err.contains("blocked"),
        "error must name the trigger cause; got: {err}"
    );

    let conn = open_retention_db(&db_path).unwrap();
    let head = get_retained_event(&conn, KIND_TEAM_CATALOG, &owner, "team-abc").unwrap();
    assert!(
        head.is_some(),
        "DELETE must be rolled back when INSERT fails so the head is not lost"
    );
}

// ── Validator contract boundary fixtures ──────────────────────────────────
//
// Shared fixtures that exercise the exact cases where Rust and TypeScript
// previously diverged: blank team names and HTTP/HTTPS URL constraints.

#[test]
fn test_url_parse_smoke() {
    // Verify is_safe_catalog_avatar_url behavior against the WHATWG parse
    // contract.  These are inline spot-checks; the shared JSON fixtures below
    // are the canonical parity evidence.

    // Parse-based cases
    assert!(
        is_safe_catalog_avatar_url("HTTPS://example.com"),
        "uppercase scheme must be accepted (parser normalizes)"
    );
    assert!(
        !is_safe_catalog_avatar_url("https://^"),
        "caret-in-host must be rejected by parser"
    );
    assert!(
        !is_safe_catalog_avatar_url("https://a b.png"),
        "ASCII space in path must be rejected by whitespace guard"
    );
    // url::Url::parse accepts https://a:1234 (host a, port 1234)
    assert!(
        is_safe_catalog_avatar_url("https://a:1234"),
        "host:port form must be accepted"
    );
    // Shorthand scheme — no literal `://` prefix; both WHATWG parsers normalize
    assert!(
        is_safe_catalog_avatar_url("http:example.com"),
        "shorthand http:example.com must be accepted (normalizes to http://example.com/)"
    );

    // ECMAScript `\s` whitespace parity
    // U+00A0 NBSP — char::is_whitespace() true, JS /\s/u true → must reject
    assert!(
        !is_safe_catalog_avatar_url("https://example.com/\u{00A0}path"),
        "NBSP (U+00A0) must be rejected"
    );
    // U+2003 EM SPACE — both sides reject
    assert!(
        !is_safe_catalog_avatar_url("https://example.com/\u{2003}path"),
        "EM SPACE (U+2003) must be rejected"
    );
    // U+FEFF BOM — char::is_whitespace() false, JS /\s/u true → must reject
    assert!(
        !is_safe_catalog_avatar_url("https://example.com/\u{FEFF}path"),
        "BOM (U+FEFF) must be rejected"
    );
    // U+0085 NEL — char::is_whitespace() true, JS /\s/u FALSE → must NOT reject
    assert!(
        is_safe_catalog_avatar_url("https://example.com/\u{0085}path"),
        "NEL (U+0085) must be accepted (JS \\s does not match it)"
    );
}

/// Deserialize a JSON fixture body into a signed event for validation testing.
fn fixture_event(content_str: &str) -> nostr::Event {
    let keys = nostr::Keys::generate();
    nostr::EventBuilder::new(nostr::Kind::Custom(30178u16), content_str)
        .sign_with_keys(&keys)
        .unwrap()
}

#[test]
fn test_fixture_invalid_team_name_blank_is_rejected() {
    // A whitespace-only team name must be rejected — parity with TS
    // `parsed.name.trim().length > 0`.
    let event = fixture_event(
        include_str!("../../../tests/fixtures/team_catalog_content/invalid_team_name_blank.json")
            .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_team_name_blank.json must be rejected"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_bare_https_is_rejected() {
    // A bare `https://` with no hostname must be rejected by both validators.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_bare_https.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_bare_https.json must be rejected"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_whitespace_in_url_is_rejected() {
    // An HTTPS URL containing a space must be rejected.
    let event = fixture_event(
        include_str!(
        "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_whitespace_in_url.json"
    )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_whitespace_in_url.json must be rejected"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_https_over_2048_is_rejected() {
    // An HTTPS URL exceeding 2 048 chars must be rejected — exact parity with
    // the TypeScript `isSafeHttpUrl` length cap.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_https_over_2048.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_https_over_2048.json must be rejected"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_malformed_port_is_rejected() {
    // https://a:b — "b" is not a valid port number; url::Url::parse rejects it.
    // TS new URL("https://a:b") also throws.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_malformed_port.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_malformed_port.json must be rejected"
    );
}

#[test]
fn test_fixture_valid_avatar_url_uppercase_scheme_is_accepted() {
    // HTTPS://example.com — url::Url::parse normalises the scheme; its
    // parsed scheme is "https". The old lowercase starts_with rejected this
    // while TS new URL() (which also normalises) accepted it.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/valid_avatar_url_uppercase_scheme.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_ok(),
        "valid_avatar_url_uppercase_scheme.json must be accepted"
    );
}

#[test]
fn test_fixture_valid_avatar_url_non_ascii_at_utf8_limit_is_accepted() {
    // https://a/ + 1019 é = 2048 UTF-8 bytes (at the limit) but only
    // 1029 UTF-16 code units.  Both sides cap at 2048 UTF-8 bytes, so
    // both accept this URL.
    let event = fixture_event(
        include_str!(
        "../../../tests/fixtures/team_catalog_content/valid_avatar_url_non_ascii_at_utf8_limit.json"
    )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_ok(),
        "valid_avatar_url_non_ascii_at_utf8_limit.json must be accepted"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_non_ascii_over_utf8_limit_is_rejected() {
    // https://a/ + 1020 é = 2050 UTF-8 bytes (over the limit) but only
    // 1030 UTF-16 code units.  The old TS code used value.length (1030 < 2048)
    // and would have accepted this; the new code uses byteLength (2050 > 2048)
    // and rejects it, matching Rust.  This is the exact split Thufir reproduced.
    let event = fixture_event(include_str!(
        "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_non_ascii_over_utf8_limit.json"
    ).trim());
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_non_ascii_over_utf8_limit.json must be rejected"
    );
}

#[test]
fn test_fixture_valid_avatar_url_shorthand_scheme_is_accepted() {
    // http:example.com — no literal `://` but the WHATWG URL Standard
    // normalizes it to http://example.com/.  TypeScript's new URL() and
    // Rust's url::Url::parse both implement the same spec and both accept it.
    // The old literal-prefix fast path rejected it; parse-first accepts it.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/valid_avatar_url_shorthand_scheme.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_ok(),
        "valid_avatar_url_shorthand_scheme.json must be accepted"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_unicode_nbsp_is_rejected() {
    // https://example.com/U+00A0 path — NBSP is matched by ECMAScript /\s/u
    // and by Rust char::is_whitespace(); both sides reject it.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_unicode_nbsp.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_unicode_nbsp.json must be rejected"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_unicode_em_space_is_rejected() {
    // https://example.com/U+2003 path — EM SPACE is matched by both
    // ECMAScript /\s/u and Rust char::is_whitespace(); both sides reject it.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_unicode_em_space.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_unicode_em_space.json must be rejected"
    );
}

#[test]
fn test_fixture_invalid_avatar_url_unicode_bom_is_rejected() {
    // https://example.com/U+FEFF path — BOM is matched by ECMAScript /\s/u
    // but NOT by Rust char::is_whitespace() — it must be added explicitly so
    // both sides reject it.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/invalid_avatar_url_unicode_bom.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_err(),
        "invalid_avatar_url_unicode_bom.json must be rejected"
    );
}

#[test]
fn test_fixture_valid_avatar_url_unicode_nel_is_accepted() {
    // https://example.com/U+0085 path — NEL is NOT matched by ECMAScript
    // /\s/u (JS explicitly excludes it), so TypeScript accepts it (the parser
    // percent-encodes it).  Rust must also accept it — char::is_whitespace()
    // includes U+0085 but we explicitly exclude it to match JS semantics.
    let event = fixture_event(
        include_str!(
            "../../../tests/fixtures/team_catalog_content/valid_avatar_url_unicode_nel.json"
        )
        .trim(),
    );
    assert!(
        team_catalog_content_from_event(&event).is_ok(),
        "valid_avatar_url_unicode_nel.json must be accepted"
    );
}
