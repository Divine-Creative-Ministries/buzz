pub(super) fn normalize_huddle_channel_name(candidate: Option<String>, fallback: &str) -> String {
    let normalized = candidate
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let name = if normalized.is_empty() {
        fallback
    } else {
        normalized.as_str()
    };

    name.chars().take(80).collect()
}
