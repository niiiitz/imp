use crate::http_pool::http_get_bytes;
use crate::lyrics::with_lyrics_db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

const SESSION_RING_CAPACITY: usize = 128;

fn session_factoid_ring() -> &'static Mutex<VecDeque<u64>> {
    static RING: OnceLock<Mutex<VecDeque<u64>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(SESSION_RING_CAPACITY)))
}

fn hash_factoid_body(text: &str) -> u64 {
    let norm: String = text
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    norm.hash(&mut hasher);
    hasher.finish()
}

/// Checks whether a factoid sentence has already been shown during this listening session.
pub fn was_factoid_shown_in_session(text: &str) -> bool {
    let h = hash_factoid_body(text);
    if let Ok(guard) = session_factoid_ring().lock() {
        guard.contains(&h)
    } else {
        false
    }
}

/// Marks a factoid sentence as shown in the current session ring buffer.
pub fn mark_factoid_shown_in_session(text: &str) {
    let h = hash_factoid_body(text);
    if let Ok(mut guard) = session_factoid_ring().lock() {
        if !guard.contains(&h) {
            if guard.len() >= SESSION_RING_CAPACITY {
                guard.pop_front();
            }
            guard.push_back(h);
        }
    }
}

/// Rejects robotic / low-signal metadata filler (such as bare MusicBrainz region codes like `Region: XW`,
/// trivial catalog dates, or dry Billboard/RIAA chart-peak & certification boilerplate with no story)
/// so only genuinely entertaining VH1 Pop-Up Video style trivia is shown.
pub fn is_high_signal_factoid_body(body: &str) -> bool {
    let trimmed = body.trim();
    if trimmed.chars().count() < 32 {
        return false;
    }
    let lower = trimmed.to_lowercase();
    if lower.contains("region: xw")
        || lower.contains("region: xe")
        || lower.starts_with("first release date recorded as")
        || (lower.starts_with("first cataloged on") && !lower.contains("•"))
        || lower.contains("isbn ")
        || lower.contains("retrieved ")
        || lower.starts_with("see also")
        || lower.starts_with("track listing")
        || lower.starts_with("all tracks written by")
        || lower.starts_with("all lyrics are written by")
    {
        return false;
    }

    // High-drama / story keywords rescue sentences even if they mention a chart or single release
    let story_markers = [
        "controvers",
        "lawsuit",
        "sued",
        "plagiarism",
        "banned",
        "censor",
        "feud",
        "dispute",
        "arrest",
        "scandal",
        "backlash",
        "protest",
        "accident",
        "refused",
        "fired",
        "walked out",
        "recorded in",
        "recorded at",
        "inspired by",
        "originally written",
        "sampled",
        "synthesizer",
        "demo",
        "music video",
        "banned from",
        "court",
    ];
    let has_story_hook = story_markers.iter().any(|m| lower.contains(m));

    if !has_story_hook {
        let dry_chart_boilerplate = [
            "peaked at number",
            "peaked at no.",
            "peaked at #",
            "debuted at number",
            "debuted at no.",
            "charted at number",
            "charted at no.",
            "reached number ",
            "reached no. ",
            "certified gold",
            "certified platinum",
            "certified multi-platinum",
            "certified diamond",
            "certified silver",
            "billboard hot 100",
            "billboard 200",
            "uk singles chart",
            "uk albums chart",
            "official charts company",
            "recording industry association",
            "riaa",
            "bpi",
            "copies worldwide",
            "million copies",
            "units worldwide",
            "released as the lead single",
            "released as the second single",
            "released as the third single",
            "released as the fourth single",
            "is a song by ",
            "is a studio album by ",
            "is the debut studio album by ",
            "is the second studio album by ",
            "is the third studio album by ",
            "is the fourth studio album by ",
            "is the fifth studio album by ",
        ];
        if dry_chart_boilerplate.iter().any(|pat| lower.contains(pat)) {
            return false;
        }
    }

    true
}

fn http_get_text(url: &str, headers: &[(&str, &str)], timeout_secs: u64) -> anyhow::Result<String> {
    let bytes = http_get_bytes(url, headers, None, timeout_secs)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactoidBubble {
    pub category: String,
    pub headline: String,
    pub body: String,
    pub source: String,
    pub start_sec: u32,
    pub duration_sec: u32,
    #[serde(default)]
    pub part_index: Option<u8>,
    #[serde(default)]
    pub part_total: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackFactoidsResponse {
    pub found: bool,
    pub provider: String,
    pub bubbles: Vec<FactoidBubble>,
}

fn normalize_key(title: &str, artist: &str, album: Option<&str>) -> String {
    format!(
        "{}::{}::{}",
        artist.trim().to_lowercase(),
        title.trim().to_lowercase(),
        album.unwrap_or("").trim().to_lowercase()
    )
}

fn load_factoids_from_db(
    track_key: &str,
    track_uri: Option<&str>,
) -> Option<TrackFactoidsResponse> {
    with_lyrics_db(|conn| {
        conn.query_row(
            "SELECT factoids_json, provider
             FROM factoid_entries
             WHERE track_key = ?1
                OR (?2 != '' AND track_uri = ?2)
             ORDER BY CASE WHEN track_key = ?1 THEN 0 ELSE 1 END
             LIMIT 1",
            params![track_key, track_uri.unwrap_or("")],
            |row| {
                let json_str: String = row.get(0)?;
                let provider: String = row.get(1)?;
                let bubbles: Vec<FactoidBubble> =
                    serde_json::from_str(&json_str).unwrap_or_default();
                Ok(TrackFactoidsResponse {
                    found: !bubbles.is_empty(),
                    provider,
                    bubbles,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    })
}

fn save_factoids_to_db(
    track_key: &str,
    track_uri: Option<&str>,
    title: &str,
    artist: &str,
    album: Option<&str>,
    resp: &TrackFactoidsResponse,
) {
    if !resp.found || resp.bubbles.is_empty() {
        return;
    }
    let Ok(json_str) = serde_json::to_string(&resp.bubbles) else {
        return;
    };
    let now_sec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let _ = with_lyrics_db(|conn| {
        let _ = conn.execute(
            "INSERT INTO factoid_entries (
                track_key, track_uri, title, artist, album, factoids_json, provider, fetched_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(track_key) DO UPDATE SET
                track_uri = CASE WHEN excluded.track_uri != '' THEN excluded.track_uri ELSE factoid_entries.track_uri END,
                factoids_json = excluded.factoids_json,
                provider = excluded.provider,
                fetched_at = excluded.fetched_at",
            params![
                track_key,
                track_uri.unwrap_or(""),
                title,
                artist,
                album.unwrap_or(""),
                json_str,
                resp.provider,
                now_sec,
            ],
        );
        Some(())
    });
}

pub fn clear_cached_factoids_for_track(
    track_uri: Option<&str>,
    title: &str,
    artist: &str,
    album: Option<&str>,
) {
    let key = normalize_key(title, artist, album);
    let _ = with_lyrics_db(|conn| {
        let _ = conn.execute(
            "DELETE FROM factoid_entries WHERE track_key = ?1 OR (?2 != '' AND track_uri = ?2)",
            params![key, track_uri.unwrap_or("")],
        );
        Some(())
    });
}

/// Strict music/media disambiguation filter so generic nouns (e.g. "Home", "Low", "Rush")
/// never match unrelated Wikipedia articles.
pub fn is_music_related_wikipedia_summary(
    page_type: &str,
    description: &str,
    extract: &str,
) -> bool {
    if page_type.eq_ignore_ascii_case("disambiguation") {
        return false;
    }
    let combined = format!(
        "{} {}",
        description.to_lowercase(),
        extract.to_lowercase()
    );
    let keywords = [
        "album",
        "song",
        "single",
        "band",
        "musician",
        "singer",
        "rapper",
        "composer",
        "producer",
        "record",
        "studio",
        "soundtrack",
        "discography",
        "track",
        "vocalist",
        "guitarist",
        "dj",
        "electronic",
        "orchestra",
        "symphony",
        "rock",
        "jazz",
        "hip hop",
        "hip-hop",
        "pop",
        "metal",
        "folk",
        "punk",
        "chart",
        "billboard",
        "grammy",
        "released in",
        "debut",
        "film",
        "cinema",
    ];
    keywords.iter().any(|kw| combined.contains(kw))
}

fn truncate_factoid_sentence(text: &str, max_chars: usize) -> String {
    let cleaned = text
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }
    let mut out = String::new();
    for word in cleaned.split_whitespace() {
        if out.chars().count() + word.chars().count() + 2 > max_chars {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out.push('…');
    out
}

/// Splits a factoid sentence into either 1 compact speech bubble (`<= 92` chars)
/// or a balanced N-part sequential speech-bubble sequence (`1/N` -> `N/N`, up to 6 parts)
/// at natural clause/word boundaries so longer complete thoughts finish cleanly without mid-sentence cutoff.
pub fn split_sentence_into_bubble_parts(text: &str) -> Vec<String> {
    const MAX_BUBBLE_CHARS: usize = 92;

    let cleaned = text
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let char_count = cleaned.chars().count();
    if char_count <= MAX_BUBBLE_CHARS {
        return vec![cleaned];
    }

    let words: Vec<&str> = cleaned.split_whitespace().collect();
    if words.len() < 4 {
        return vec![cleaned];
    }

    let word_chars: Vec<usize> = words.iter().map(|w| w.chars().count()).collect();
    let span_chars = |start: usize, end: usize| -> usize {
        if start >= end {
            return 0;
        }
        let words_sum: usize = word_chars[start..end].iter().sum();
        words_sum + (end - start - 1)
    };
    let punct_penalty = |w: &str| -> u64 {
        if w.ends_with(',')
            || w.ends_with(';')
            || w.ends_with(':')
            || w.ends_with('—')
            || w.ends_with('–')
            || w.ends_with('-')
            || w.ends_with(')')
        {
            0
        } else {
            220
        }
    };

    let format_chunks = |slices: Vec<String>| -> Vec<String> {
        let total = slices.len();
        slices
            .into_iter()
            .enumerate()
            .map(|(idx, raw)| {
                if total == 1 {
                    raw
                } else if idx == 0 {
                    format!("{} …", raw.trim_end_matches([',', ';']))
                } else if idx + 1 < total {
                    format!("… {} …", raw.trim_end_matches([',', ';']))
                } else {
                    format!("… {}", raw)
                }
            })
            .collect()
    };

    let n = words.len();
    for k in 2..=6 {
        if n < k {
            continue;
        }
        let target = (char_count / k).max(20);
        let mut dp: Vec<Vec<Option<(u64, usize)>>> = vec![vec![None; n + 1]; k + 1];

        for j in 1..=n {
            let len = span_chars(0, j);
            if j == 1 || len <= 90 {
                let cost = (len.abs_diff(target) as u64).pow(2) + punct_penalty(words[j - 1]);
                dp[1][j] = Some((cost, 0));
            }
        }

        for p in 2..=k {
            let max_raw = if p < k { 88 } else { 90 };
            for j in p..=n {
                let mut best: Option<(u64, usize)> = None;
                for i in (p - 1)..j {
                    let Some((prev_cost, _)) = dp[p - 1][i] else {
                        continue;
                    };
                    let len = span_chars(i, j);
                    if j - i == 1 || len <= max_raw {
                        let penalty = if p < k { punct_penalty(words[j - 1]) } else { 0 };
                        let cost = prev_cost
                            .saturating_add((len.abs_diff(target) as u64).pow(2))
                            .saturating_add(penalty);
                        if best.map(|(b_cost, _)| cost < b_cost).unwrap_or(true) {
                            best = Some((cost, i));
                        }
                    }
                }
                dp[p][j] = best;
            }
        }

        if dp[k][n].is_some() {
            let mut bounds = vec![n];
            let mut cur_j = n;
            for p in (1..=k).rev() {
                let prev_i = dp[p][cur_j].map(|(_, idx)| idx).unwrap_or(0);
                bounds.push(prev_i);
                cur_j = prev_i;
            }
            bounds.reverse();
            let raw_slices: Vec<String> = bounds
                .windows(2)
                .map(|w| words[w[0]..w[1]].join(" "))
                .collect();
            return format_chunks(raw_slices);
        }
    }

    // Greedy fallback so no words are ever dropped on extraordinarily long inputs
    let mut raw_slices = Vec::new();
    let mut current = String::new();
    for word in words {
        if current.is_empty() {
            current.push_str(word);
        } else if current.chars().count() + 1 + word.chars().count() <= 88 {
            current.push(' ');
            current.push_str(word);
        } else {
            raw_slices.push(current);
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        raw_slices.push(current);
    }
    format_chunks(raw_slices)
}

fn is_non_terminal_period(paragraph: &str, period_byte_idx: usize, after_end_byte_idx: usize) -> bool {
    let rest = paragraph[after_end_byte_idx..].trim_start();
    if let Some(next_ch) = rest.chars().next() {
        if next_ch.is_lowercase() || next_ch.is_ascii_digit() {
            return true;
        }
    }

    let before = &paragraph[..period_byte_idx];
    let token = before
        .split_whitespace()
        .last()
        .unwrap_or("")
        .trim_start_matches(['"', '“', '”', '\'', '‘', '’', '(', '[']);
    if token.is_empty() {
        return false;
    }

    let lower = token.to_lowercase();
    const ABBREVIATIONS: &[&str] = &[
        "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "rev", "gen", "col", "sgt", "capt",
        "no", "nos", "vol", "vols", "pt", "op", "ft", "feat", "vs", "inc", "ltd", "co", "corp",
        "bros", "est", "approx", "ed", "eds", "al", "pp", "p", "e.g", "i.e", "etc", "cf", "jan",
        "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "u.s",
        "u.k", "a.m", "p.m",
    ];
    if ABBREVIATIONS.contains(&lower.as_str()) {
        return true;
    }

    let last_seg = token.rsplit('.').next().unwrap_or("");
    last_seg.chars().count() == 1 && last_seg.chars().all(|c| c.is_ascii_alphabetic())
}

fn extract_complete_sentences(extract: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    for raw_line in extract.lines() {
        let paragraph = raw_line.split_whitespace().collect::<Vec<_>>().join(" ");
        if paragraph.is_empty() {
            continue;
        }

        let mut start = 0usize;
        let bytes = paragraph.as_bytes();
        let mut idx = 0usize;
        while idx < paragraph.len() {
            let Some(ch) = paragraph[idx..].chars().next() else {
                break;
            };
            let ch_len = ch.len_utf8();
            if ch == '.' || ch == '!' || ch == '?' {
                let mut end = idx + ch_len;
                while end < paragraph.len() {
                    let Some(close) = paragraph[end..].chars().next() else {
                        break;
                    };
                    if matches!(close, '"' | '”' | '\'' | '’' | ')') {
                        end += close.len_utf8();
                    } else {
                        break;
                    }
                }
                let at_end = end == paragraph.len();
                let followed_by_ws = !at_end
                    && paragraph[end..]
                        .chars()
                        .next()
                        .map(|c| c.is_whitespace())
                        .unwrap_or(false);
                if (at_end || followed_by_ws)
                    && (ch != '.' || !is_non_terminal_period(&paragraph, idx, end))
                {
                    let piece = paragraph[start..end].trim();
                    if !piece.is_empty() {
                        sentences.push(piece.to_string());
                    }
                    start = end;
                    while start < paragraph.len() && bytes[start].is_ascii_whitespace() {
                        start += 1;
                    }
                    idx = start;
                    continue;
                }
            }
            idx += ch_len;
        }
        let trailing = paragraph[start..].trim();
        if !trailing.is_empty() && trailing.ends_with(['.', '!', '?']) {
            sentences.push(trailing.to_string());
        }
    }
    sentences
}

fn split_extract_into_sentences(extract: &str, max_sentences: usize) -> Vec<String> {
    let mut results = Vec::new();
    for candidate in extract_complete_sentences(extract) {
        let char_count = candidate.chars().count();
        if !(32..=340).contains(&char_count) {
            continue;
        }
        if !is_high_signal_factoid_body(&candidate) || was_factoid_shown_in_session(&candidate) {
            continue;
        }
        results.push(candidate);
        if results.len() >= max_sentences {
            break;
        }
    }
    results
}

fn url_encode_component(input: &str) -> String {
    let mut out = String::new();
    for b in input.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Parses MediaWiki `explaintext=1&exsectionformat=wiki` plain text into `(section_heading, body)` pairs.
/// Text before the first `== ... ==` heading is returned under `"Lead"`.
pub fn parse_wikipedia_sections(plain_text: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current_heading = "Lead".to_string();
    let mut current_body = String::new();

    for line in plain_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("==") && trimmed.ends_with("==") && trimmed.len() >= 5 {
            let clean_heading = trimmed.trim_matches('=').trim().to_string();
            if !clean_heading.is_empty() {
                if !current_body.trim().is_empty() {
                    sections.push((current_heading, current_body.trim().to_string()));
                }
                current_heading = clean_heading;
                current_body = String::new();
                continue;
            }
        }
        if !trimmed.is_empty() {
            if !current_body.is_empty() {
                current_body.push(' ');
            }
            current_body.push_str(trimmed);
        }
    }
    if !current_body.trim().is_empty() {
        sections.push((current_heading, current_body.trim().to_string()));
    }
    sections
}

/// Classifies a Wikipedia section heading into `(priority_tier, display_category)`.
/// Returns `None` for dry reference/chart/credits sections we should skip entirely.
pub fn classify_wikipedia_section(
    heading: &str,
    is_artist_article: bool,
) -> Option<(u8, &'static str)> {
    let lower = heading.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }

    // Hard-skip boring tabular / metadata sections
    let skip_keywords = [
        "track listing",
        "tracklist",
        "personnel",
        "credits",
        "chart",
        "certification",
        "release history",
        "discography",
        "filmography",
        "videography",
        "awards",
        "nominations",
        "references",
        "external links",
        "see also",
        "notes",
        "bibliography",
        "further reading",
        "sales",
        "band members",
        "members",
        "tour dates",
        "concert tours",
        "accolades",
    ];
    if skip_keywords.iter().any(|kw| lower.contains(kw)) {
        return None;
    }

    // Tier 1 (Highest): Controversies, Legal Battles, Feuds, Censorship & Scandals!
    let drama_keywords = [
        "controvers",
        "legal",
        "lawsuit",
        "plagiarism",
        "feud",
        "censor",
        "dispute",
        "scandal",
        "backlash",
        "incident",
        "arrest",
        "copyright",
        "conflict",
        "criticism",
        "ban",
        "allegation",
        "activism",
        "political",
    ];
    if drama_keywords.iter().any(|kw| lower.contains(kw)) {
        return Some((
            100,
            if is_artist_article {
                "BAND CONTROVERSY"
            } else {
                "CONTROVERSY"
            },
        ));
    }

    // Tier 2: Recording, Production, Background, Writing, Music Video & Artwork Stories
    let studio_keywords = [
        "recording",
        "production",
        "background",
        "composition",
        "writing",
        "development",
        "origin",
        "music video",
        "artwork",
        "cover art",
        "packaging",
        "sampl",
        "equipment",
        "gear",
        "lyrical",
        "lyrics",
        "concept",
        "inspiration",
        "sessions",
        "making of",
        "sound",
    ];
    if studio_keywords.iter().any(|kw| lower.contains(kw)) {
        return Some((
            80,
            if is_artist_article {
                "ARTIST CRAFT"
            } else {
                "STUDIO LORE"
            },
        ));
    }

    // Tier 3: Band History, Legacy, Cultural Impact, Style & Live Lore
    let lore_keywords = [
        "legacy",
        "impact",
        "influence",
        "musical style",
        "artistry",
        "history",
        "formation",
        "early life",
        "career",
        "breakup",
        "reunion",
        "live performance",
        "popular culture",
        "personal life",
        "trivia",
        "style",
    ];
    if lore_keywords.iter().any(|kw| lower.contains(kw)) {
        return Some((
            60,
            if is_artist_article {
                "BAND LORE"
            } else {
                "LEGACY & LORE"
            },
        ));
    }

    None
}

/// Extracts prioritized, high-signal VH1 Pop-Up Video trivia items `(category, headline, sentence)`
/// from a Wikipedia plain-text article, preferring Controversies > Studio Lore > Band Lore
/// and skipping already-shown session factoids.
pub fn extract_juicy_section_factoids(
    canonical_title: &str,
    plain_text: &str,
    is_artist_article: bool,
    max_items: usize,
) -> Vec<(String, String, String)> {
    let sections = parse_wikipedia_sections(plain_text);
    let mut ranked: Vec<(u8, String, String, String)> = Vec::new();

    for (heading, body) in sections {
        let Some((priority, category)) = classify_wikipedia_section(&heading, is_artist_article)
        else {
            continue;
        };
        let sentences = split_extract_into_sentences(&body, 2);
        for sentence in sentences {
            let headline = if heading.eq_ignore_ascii_case("Lead") {
                canonical_title.to_string()
            } else {
                format!("{canonical_title} — {heading}")
            };
            ranked.push((priority, category.to_string(), headline, sentence));
        }
    }

    // Sort highest-priority (Controversies = 100) first while preserving section order on ties
    ranked.sort_by(|a, b| b.0.cmp(&a.0));

    let mut out = Vec::new();
    let mut seen_categories_or_headlines: Vec<String> = Vec::new();
    for (_prio, cat, headline, sentence) in ranked {
        // Keep variety across sections so one single section doesn't hog every bubble
        let same_section_count = seen_categories_or_headlines
            .iter()
            .filter(|h| **h == headline)
            .count();
        if same_section_count >= 1 && out.len() + 1 < max_items {
            continue;
        }
        seen_categories_or_headlines.push(headline.clone());
        out.push((cat, headline, sentence));
        if out.len() >= max_items {
            break;
        }
    }
    out
}

fn query_wikipedia_full_extract(page_title: &str) -> Option<String> {
    let trimmed = page_title.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles={}&format=json&formatversion=2",
        url_encode_component(trimmed)
    );
    let body = http_get_text(
        &url,
        &[
            ("User-Agent", "IMP-MediaPlayer/1.0.2 (https://github.com/niiiitz/imp)"),
            ("Accept", "application/json"),
        ],
        5,
    )
    .ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let page = json
        .get("query")
        .and_then(|q| q.get("pages"))
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first())?;
    let extract = page.get("extract").and_then(|v| v.as_str())?;
    if extract.trim().is_empty() {
        None
    } else {
        Some(extract.to_string())
    }
}

fn query_wikipedia_summary(page_title: &str) -> Option<(String, String)> {
    let slug = page_title.trim().replace(' ', "_");
    if slug.is_empty() {
        return None;
    }
    let url = format!(
        "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
        url_encode_component(&slug)
    );
    let body = http_get_text(
        &url,
        &[
            ("User-Agent", "IMP-MediaPlayer/1.0.2 (https://github.com/niiiitz/imp)"),
            ("Accept", "application/json"),
        ],
        4,
    )
    .ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let page_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let description = json
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let extract = json.get("extract").and_then(|v| v.as_str()).unwrap_or("");
    let canonical_title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(page_title)
        .to_string();
    if extract.trim().is_empty()
        || !is_music_related_wikipedia_summary(page_type, description, extract)
    {
        return None;
    }
    Some((canonical_title, extract.to_string()))
}

fn query_wikipedia_search_fallback(search_query: &str) -> Option<(String, String)> {
    let trimmed = search_query.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&srlimit=3&format=json",
        url_encode_component(trimmed)
    );
    let body = http_get_text(
        &url,
        &[
            ("User-Agent", "IMP-MediaPlayer/1.0.2 (https://github.com/niiiitz/imp)"),
            ("Accept", "application/json"),
        ],
        4,
    )
    .ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let hits = json
        .get("query")
        .and_then(|q| q.get("search"))
        .and_then(|s| s.as_array())?;
    for hit in hits.iter().take(3) {
        if let Some(title) = hit.get("title").and_then(|t| t.as_str()) {
            if let Some(found) = query_wikipedia_summary(title) {
                return Some(found);
            }
        }
    }
    None
}

fn query_musicbrainz_recording_factoid(title: &str, artist: &str) -> Option<String> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return None;
    }
    let query = format!(
        "recording:\"{}\" AND artist:\"{}\"",
        title.replace('"', ""),
        artist.replace('"', "")
    );
    let url = format!(
        "https://musicbrainz.org/ws/2/recording/?query={}&limit=1&fmt=json",
        url_encode_component(&query)
    );
    let body = http_get_text(
        &url,
        &[
            ("User-Agent", "IMP-MediaPlayer/1.0.2 (https://github.com/niiiitz/imp)"),
            ("Accept", "application/json"),
        ],
        4,
    )
    .ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let rec = json
        .get("recordings")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())?;
    let score = rec.get("score").and_then(|v| v.as_u64()).unwrap_or(0);
    if score < 85 {
        return None;
    }
    let first_release = rec
        .get("first-release-date")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let release_info = rec
        .get("releases")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first());
    let release_title = release_info
        .and_then(|r| r.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let country = release_info
        .and_then(|r| r.get("country"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let disambig = rec
        .get("disambiguation")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tags: Vec<String> = rec
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                .take(4)
                .collect()
        })
        .unwrap_or_default();

    // Require genuine editorial/curatorial signal (disambiguation note or >= 2 genre/style tags)
    // so bare catalog dates or robotic "Region: XW" codes never clutter the visualizer.
    if disambig.is_empty() && tags.len() < 2 {
        return None;
    }

    let mut parts = Vec::new();
    if !first_release.is_empty() && !release_title.is_empty() {
        parts.push(format!(
            "First cataloged on \"{release_title}\" ({first_release})"
        ));
    }
    if !disambig.is_empty() {
        parts.push(disambig.to_string());
    }
    if !tags.is_empty() {
        parts.push(format!("Styles: {}", tags.join(", ")));
    }
    let _ = country;
    if parts.len() < 2 {
        None
    } else {
        let combined = truncate_factoid_sentence(&parts.join(" • "), 340);
        if is_high_signal_factoid_body(&combined) && !was_factoid_shown_in_session(&combined) {
            Some(combined)
        } else {
            None
        }
    }
}

fn is_continuation_bubble(prev: &FactoidBubble, next: &FactoidBubble) -> bool {
    if prev.category != next.category
        || prev.headline != next.headline
        || prev.source != next.source
    {
        return false;
    }
    let meta_continuation = prev.part_total.unwrap_or(1) > 1
        && prev.part_total == next.part_total
        && prev
            .part_index
            .zip(next.part_index)
            .map(|(a, b)| b == a.saturating_add(1))
            .unwrap_or(false);
    let ellipsis_continuation =
        prev.body.trim_end().ends_with('…') && next.body.trim_start().starts_with('…');
    meta_continuation || ellipsis_continuation
}

fn group_factoid_bubbles(bubbles: Vec<FactoidBubble>) -> Vec<Vec<FactoidBubble>> {
    let mut groups: Vec<Vec<FactoidBubble>> = Vec::new();
    for bubble in bubbles {
        if let Some(last_group) = groups.last_mut() {
            if let Some(prev) = last_group.last() {
                if is_continuation_bubble(prev, &bubble) {
                    last_group.push(bubble);
                    continue;
                }
            }
        }
        groups.push(vec![bubble]);
    }
    groups
}

fn coalesce_bubble_group(group: &[FactoidBubble]) -> Option<(String, String, String, String)> {
    let first = group.first()?;
    if group.len() == 1 {
        return Some((
            first.category.clone(),
            first.headline.clone(),
            first.body.clone(),
            first.source.clone(),
        ));
    }
    let mut segments = Vec::with_capacity(group.len());
    for (i, bubble) in group.iter().enumerate() {
        let mut s = bubble.body.trim();
        if i > 0 {
            s = s.trim_start_matches('…').trim_start();
        }
        if i + 1 < group.len() {
            s = s.trim_end_matches('…').trim_end();
        }
        if !s.is_empty() {
            segments.push(s);
        }
    }
    let joined_body = segments.join(" ");
    Some((
        first.category.clone(),
        first.headline.clone(),
        joined_body,
        first.source.clone(),
    ))
}

/// Rejoins split multi-part cached bubbles back into whole `(category, headline, body, source)` items.
pub fn coalesce_cached_factoid_bubbles(
    bubbles: Vec<FactoidBubble>,
) -> Vec<(String, String, String, String)> {
    group_factoid_bubbles(bubbles)
        .into_iter()
        .filter_map(|group| coalesce_bubble_group(&group))
        .collect()
}

/// Schedules 2–4 VH1-style "Pop-Up Video" factoid slots cleanly between `18s` and `duration_sec - 4s`
/// so they never collide with the `0.5s–8.5s` MTV Track Intro Chyron or cut off at track end.
/// Longer complete thoughts (`> 92` chars) are automatically split into a sequential N-part speech-bubble
/// chain (`Part 1/N` .. `Part N/N`, `5s` each back-to-back with `0s` gap) without overlapping the next slot.
pub fn schedule_factoid_bubbles(
    raw_items: Vec<(String, String, String, String)>,
    duration_ms: u32,
) -> Vec<FactoidBubble> {
    if raw_items.is_empty() {
        return Vec::new();
    }
    let total_sec = (duration_ms / 1000).max(90);
    let safe_start = 18u32;
    let safe_end = total_sec.saturating_sub(24).max(safe_start + 16);
    let hard_end = total_sec.saturating_sub(4);
    let count = raw_items.len().min(4);
    let span = safe_end.saturating_sub(safe_start);
    let step = if count > 1 {
        (span / (count as u32)).max(16)
    } else {
        0
    };

    let mut out = Vec::new();
    let mut next_earliest_start = safe_start;
    for (idx, (category, headline, body, source)) in raw_items.into_iter().take(4).enumerate() {
        let parts = split_sentence_into_bubble_parts(&body);
        if parts.is_empty() {
            continue;
        }
        let total_parts = parts.len();
        let total_dur = if total_parts >= 2 {
            (total_parts as u32) * 5
        } else {
            8
        };
        let requested_start = (safe_start + (idx as u32) * step).max(next_earliest_start);
        if !out.is_empty() && requested_start + total_dur > hard_end {
            continue;
        }
        let slot_start = requested_start.min(hard_end.saturating_sub(total_dur).max(safe_start));

        if total_parts >= 2 {
            let part_total_u8 = total_parts.min(u8::MAX as usize) as u8;
            for (p_idx, part_body) in parts.into_iter().enumerate() {
                out.push(FactoidBubble {
                    category: category.clone(),
                    headline: headline.clone(),
                    body: part_body,
                    source: source.clone(),
                    start_sec: slot_start + (p_idx as u32) * 5,
                    duration_sec: 5,
                    part_index: Some((p_idx + 1).min(u8::MAX as usize) as u8),
                    part_total: Some(part_total_u8),
                });
            }
        } else if let Some(single) = parts.into_iter().next() {
            out.push(FactoidBubble {
                category,
                headline,
                body: single,
                source,
                start_sec: slot_start,
                duration_sec: 8,
                part_index: None,
                part_total: None,
            });
        }
        next_earliest_start = slot_start + total_dur + 2;
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushFactoidsItem {
    pub track_uri: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub bubbles: Vec<FactoidBubble>,
}

/// Imports pre-fetched factoid bubbles from Imp Librarian into `lyrics.db` (`factoid_entries`).
pub fn import_cached_factoids(item: &PushFactoidsItem) -> anyhow::Result<TrackFactoidsResponse> {
    let (cleaned_title_str, cleaned_artist_str) =
        crate::lyrics::clean_metadata_for_lyrics(&item.title, &item.artist);
    let clean_title = if cleaned_title_str.is_empty() {
        item.title.trim()
    } else {
        cleaned_title_str.as_str()
    };
    let clean_artist = if cleaned_artist_str.is_empty() {
        item.artist.trim()
    } else {
        cleaned_artist_str.as_str()
    };
    let clean_album = item
        .album
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("unknown album"));

    let key = normalize_key(clean_title, clean_artist, clean_album);
    let mut provider = item
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("wikipedia_v2+librarian")
        .to_string();
    if !provider.contains("librarian") {
        provider.push_str("+librarian");
    }

    let resp = TrackFactoidsResponse {
        found: !item.bubbles.is_empty(),
        provider,
        bubbles: item.bubbles.clone(),
    };
    let uri_opt = {
        let u = item.track_uri.trim();
        (!u.is_empty()).then_some(u)
    };
    save_factoids_to_db(
        &key,
        uri_opt,
        clean_title,
        clean_artist,
        clean_album,
        &resp,
    );
    Ok(resp)
}

fn has_truncated_factoid(items: &[(String, String, String, String)]) -> bool {
    items.iter().any(|(_, _, body, _)| {
        let trimmed = body.trim_end();
        trimmed.ends_with('…') || trimmed.ends_with("...")
    })
}

pub fn fetch_track_factoids(
    track_uri: Option<&str>,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_ms: u32,
) -> TrackFactoidsResponse {
    let (cleaned_title_str, cleaned_artist_str) =
        crate::lyrics::clean_metadata_for_lyrics(title, artist);
    let clean_title = if cleaned_title_str.is_empty() {
        title.trim()
    } else {
        cleaned_title_str.as_str()
    };
    let clean_artist = if cleaned_artist_str.is_empty() {
        artist.trim()
    } else {
        cleaned_artist_str.as_str()
    };
    let clean_album = album.map(str::trim).filter(|s| !s.is_empty() && *s != "Unknown Album");
    let key = normalize_key(clean_title, clean_artist, clean_album);

    if let Some(mut cached) = load_factoids_from_db(&key, track_uri) {
        if cached.provider.contains("librarian") {
            let grouped = group_factoid_bubbles(cached.bubbles.clone());
            let unseen: Vec<Vec<FactoidBubble>> = grouped
                .iter()
                .filter(|g| {
                    coalesce_bubble_group(g)
                        .map(|(_, _, body, _)| !was_factoid_shown_in_session(&body))
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            let chosen_groups = if !unseen.is_empty() { unseen } else { grouped };
            if !chosen_groups.is_empty() {
                for g in &chosen_groups {
                    if let Some((_, _, combined, _)) = coalesce_bubble_group(g) {
                        mark_factoid_shown_in_session(&combined);
                    }
                }
                let needs_schedule = chosen_groups
                    .iter()
                    .all(|g| g.iter().all(|b| b.duration_sec == 0));
                cached.bubbles = if needs_schedule {
                    let raw: Vec<(String, String, String, String)> = chosen_groups
                        .iter()
                        .filter_map(|g| coalesce_bubble_group(g))
                        .collect();
                    schedule_factoid_bubbles(raw, duration_ms)
                } else {
                    chosen_groups.into_iter().flatten().collect()
                };
                cached.found = !cached.bubbles.is_empty();
                return cached;
            }
        }
        // Automatically upgrade legacy v1 rows and truncated v2 rows to complete-thought v3 factoids
        let is_modern_cache = cached.provider.contains("v3") || cached.provider.contains("v2");
        if is_modern_cache {
            let coalesced = coalesce_cached_factoid_bubbles(cached.bubbles);
            let should_upgrade_truncated_v2 = !cached.provider.contains("v3")
                && crate::is_online_factoids_fetch_enabled()
                && has_truncated_factoid(&coalesced);
            if !should_upgrade_truncated_v2 {
                let filtered_raw: Vec<(String, String, String, String)> = coalesced
                    .into_iter()
                    .filter(|(_, _, body, _)| {
                        is_high_signal_factoid_body(body) && !was_factoid_shown_in_session(body)
                    })
                    .collect();
                if !filtered_raw.is_empty() {
                    for (_, _, body, _) in &filtered_raw {
                        mark_factoid_shown_in_session(body);
                    }
                    cached.bubbles = schedule_factoid_bubbles(filtered_raw, duration_ms);
                    cached.found = !cached.bubbles.is_empty();
                    return cached;
                }
            }
        }
    }

    if !crate::is_online_factoids_fetch_enabled() {
        return TrackFactoidsResponse {
            found: false,
            provider: "offline_policy".to_string(),
            bubbles: Vec::new(),
        };
    }

    let primary_artist = clean_artist
        .split(&[',', '&', '/'][..])
        .next()
        .unwrap_or(clean_artist)
        .trim();

    let mut raw_items: Vec<(String, String, String, String)> = Vec::new();
    let mut providers: Vec<&str> = Vec::new();

    // 1. Wikipedia Deep-Section Lore — Song or Album (Controversies > Studio Lore > Legacy, fallback to Summary)
    {
        let mut work_candidates = Vec::new();
        if let Some(alb) = clean_album {
            work_candidates.push(format!("{alb} ({primary_artist} album)"));
            work_candidates.push(format!("{alb} (album)"));
        }
        if !clean_title.is_empty() && !primary_artist.is_empty() {
            work_candidates.push(format!("{clean_title} ({primary_artist} song)"));
            work_candidates.push(format!("{clean_title} (song)"));
        }
        let mut matched_work = None;
        for cand in &work_candidates {
            if let Some(res) = query_wikipedia_summary(cand) {
                matched_work = Some(res);
                break;
            }
        }
        if matched_work.is_none() && !primary_artist.is_empty() {
            if let Some(alb) = clean_album {
                matched_work =
                    query_wikipedia_search_fallback(&format!("{alb} {primary_artist} album"));
            }
            if matched_work.is_none() && !clean_title.is_empty() {
                matched_work =
                    query_wikipedia_search_fallback(&format!("{clean_title} {primary_artist} song"));
            }
        }
        if let Some((canon, summary_extract)) = matched_work {
            let mut work_added = 0usize;
            if let Some(full_text) = query_wikipedia_full_extract(&canon) {
                for (cat, headline, sentence) in
                    extract_juicy_section_factoids(&canon, &full_text, false, 2)
                {
                    raw_items.push((cat, headline, sentence, "Wikipedia".to_string()));
                    work_added += 1;
                }
            }
            if work_added == 0 {
                for sentence in split_extract_into_sentences(&summary_extract, 1) {
                    raw_items.push((
                        "TRACK & ALBUM LORE".to_string(),
                        canon.clone(),
                        sentence,
                        "Wikipedia".to_string(),
                    ));
                }
            }
            if !providers.contains(&"wikipedia-v3") {
                providers.push("wikipedia-v3");
            }
        }
    }

    // 2. Wikipedia Deep-Section Lore — Band / Artist (Always checked for Band Controversies, Feuds & Lore!)
    if !primary_artist.is_empty() && !primary_artist.eq_ignore_ascii_case("Unknown Artist") {
        let artist_candidates = [
            format!("{primary_artist} (band)"),
            format!("{primary_artist} (musician)"),
            format!("{primary_artist} (singer)"),
            primary_artist.to_string(),
        ];
        let mut matched_artist = None;
        for cand in &artist_candidates {
            if let Some(res) = query_wikipedia_summary(cand) {
                matched_artist = Some(res);
                break;
            }
        }
        if matched_artist.is_none() {
            matched_artist =
                query_wikipedia_search_fallback(&format!("{primary_artist} musician band"));
        }
        if let Some((canon, summary_extract)) = matched_artist {
            let artist_quota = (4usize).saturating_sub(raw_items.len()).max(1).min(2);
            let mut artist_added = 0usize;
            if let Some(full_text) = query_wikipedia_full_extract(&canon) {
                for (cat, headline, sentence) in
                    extract_juicy_section_factoids(&canon, &full_text, true, artist_quota)
                {
                    raw_items.push((cat, headline, sentence, "Wikipedia".to_string()));
                    artist_added += 1;
                }
            }
            if artist_added == 0 && raw_items.len() < 4 {
                for sentence in split_extract_into_sentences(&summary_extract, 1) {
                    raw_items.push((
                        "ARTIST PROFILE".to_string(),
                        canon.clone(),
                        sentence,
                        "Wikipedia".to_string(),
                    ));
                }
            }
            if !providers.contains(&"wikipedia-v3") {
                providers.push("wikipedia-v3");
            }
        }
    }

    // 3. MusicBrainz Recording / Release Metadata (curatorial fallback if < 4 bubbles)
    if raw_items.len() < 4 {
        if let Some(mb_fact) = query_musicbrainz_recording_factoid(clean_title, primary_artist) {
            raw_items.push((
                "RELEASE ARCHIVE".to_string(),
                clean_title.to_string(),
                mb_fact,
                "MusicBrainz".to_string(),
            ));
            providers.push("musicbrainz");
        }
    }

    // Bubble Controversies to the front so the juiciest pop-up fires early in the track!
    raw_items.sort_by_key(|(cat, _, _, _)| {
        if cat.contains("CONTROVERSY") {
            0u8
        } else if cat.contains("STUDIO") || cat.contains("CRAFT") {
            1u8
        } else if cat.contains("LORE") {
            2u8
        } else {
            3u8
        }
    });

    for (_, _, body, _) in &raw_items {
        mark_factoid_shown_in_session(body);
    }
    let bubbles = schedule_factoid_bubbles(raw_items, duration_ms);
    let provider_str = if providers.is_empty() {
        "none".to_string()
    } else {
        providers.join("+")
    };
    let resp = TrackFactoidsResponse {
        found: !bubbles.is_empty(),
        provider: provider_str,
        bubbles,
    };

    if resp.found {
        save_factoids_to_db(&key, track_uri, clean_title, clean_artist, clean_album, &resp);
    }

    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_music_wikipedia_filter_rejects_non_music_articles() {
        assert!(!is_music_related_wikipedia_summary(
            "standard",
            "Place used as a permanent or semi-permanent residence",
            "A home, or domicile, is a space used as a permanent or semi-permanent residence for one or more human occupants."
        ));
        assert!(!is_music_related_wikipedia_summary(
            "disambiguation",
            "Topics referred to by the same term",
            "Home may refer to an album or a song."
        ));
        assert!(is_music_related_wikipedia_summary(
            "standard",
            "2001 studio album by Electronic Duo",
            "Sample Album is the second studio album by French electronic music duo Example Artist, released in March 2001."
        ));
    }

    #[test]
    fn test_factoid_bubble_scheduling_avoids_intro_and_outro_and_splits_long_sentences() {
        let raw = vec![
            ("RELEASE".into(), "Track 01".into(), "Fact 1 is short.".into(), "MusicBrainz".into()),
            (
                "ALBUM".into(),
                "Sample Album".into(),
                "Sample Album is the second studio album by electronic music duo Example Artist, recorded in Paris and released worldwide in March 2001.".into(),
                "Wikipedia".into(),
            ),
            ("ARTIST".into(), "Example Artist".into(), "Fact 3 is short.".into(), "Wikipedia".into()),
        ];
        let bubbles = schedule_factoid_bubbles(raw, 200_000);
        // Item 1 (1 bubble) + Item 2 (2 sequential parts) + Item 3 (1 bubble) = 4 bubbles
        assert_eq!(bubbles.len(), 4);
        assert!(bubbles[0].start_sec >= 18);
        assert_eq!(bubbles[1].part_index, Some(1));
        assert_eq!(bubbles[1].part_total, Some(2));
        assert_eq!(bubbles[2].part_index, Some(2));
        assert_eq!(bubbles[2].part_total, Some(2));
        assert_eq!(bubbles[2].start_sec, bubbles[1].start_sec + 5);
        assert!(bubbles[3].start_sec + bubbles[3].duration_sec <= 188);
    }

    #[test]
    fn test_high_signal_filter_and_session_deduplication() {
        assert!(!is_high_signal_factoid_body("First cataloged on \"Track 01\" (2021) • Region: XW"));
        assert!(!is_high_signal_factoid_body("First release date recorded as 2019"));
        assert!(!is_high_signal_factoid_body("Too short."));
        assert!(!is_high_signal_factoid_body(
            "Sample Track peaked at number 14 on the Billboard Hot 100 and was certified Gold by the RIAA."
        ));
        // Drama/controversy hook rescues a sentence even if it references charts or bans
        assert!(is_high_signal_factoid_body(
            "Despite being banned from broadcast over censorship controversy, the track still topped the charts."
        ));
        assert!(is_high_signal_factoid_body(
            "Recorded at Abbey Road Studios using vintage analog synthesizers and tape loops."
        ));

        let extract = "Sentence alpha describes the studio recording process in detail. Sentence beta explains how the synthesizer patch was programmed on a classic modular rig. Sentence gamma covers the international chart reception.";
        let first_pass = split_extract_into_sentences(extract, 1);
        assert_eq!(first_pass.len(), 1);
        assert!(first_pass[0].starts_with("Sentence alpha"));
        mark_factoid_shown_in_session(&first_pass[0]);

        let second_pass = split_extract_into_sentences(extract, 1);
        assert_eq!(second_pass.len(), 1);
        assert!(second_pass[0].starts_with("Sentence beta"));
    }

    #[test]
    fn test_wikipedia_deep_sections_prioritize_controversies_and_skip_charts() {
        let article = r#"
Sample Band is an electronic group formed in 1998.

== Track listing ==
All tracks written by Example Artist and Co-Writer for the album release.

== Recording ==
The rhythm tracks were tracked live in an abandoned concrete warehouse using a salvaged tape machine.

== Charts and certifications ==
The album peaked at number 8 on the Billboard 200 and was certified Platinum worldwide.

=== Legal controversies ===
In 2003 the band faced a high-profile copyright lawsuit after sampling a vintage public-access jingle without clearance.

== Legacy ==
Critics later credited the group with pioneering DIY hardware live-coding performances across underground clubs.
"#;

        let sections = parse_wikipedia_sections(article);
        assert!(sections.len() >= 5);
        assert_eq!(
            classify_wikipedia_section("Legal controversies", true),
            Some((100, "BAND CONTROVERSY"))
        );
        assert_eq!(
            classify_wikipedia_section("Recording", false),
            Some((80, "STUDIO LORE"))
        );
        assert_eq!(
            classify_wikipedia_section("Charts and certifications", false),
            None
        );
        assert_eq!(classify_wikipedia_section("Track listing", false), None);

        let extracted = extract_juicy_section_factoids("Sample Band", article, true, 3);
        assert_eq!(extracted.len(), 3);
        // Controversies MUST rank #1 ahead of Recording & Legacy!
        assert_eq!(extracted[0].0, "BAND CONTROVERSY");
        assert!(extracted[0].2.contains("copyright lawsuit"));
        assert_eq!(extracted[1].0, "ARTIST CRAFT");
        assert!(extracted[1].2.contains("abandoned concrete warehouse"));
        assert_eq!(extracted[2].0, "BAND LORE");
    }

    #[test]
    fn test_import_cached_factoids_persists_and_returns_bubbles() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let uri = format!("file:///Volumes/Music/SampleArtist/SampleAlbum/{nanos}_fact.flac");
        let item = PushFactoidsItem {
            track_uri: uri.clone(),
            title: format!("Sample Fact Track {nanos}"),
            artist: "Sample Artist".to_string(),
            album: Some("Sample Album".to_string()),
            provider: Some("wikipedia_v2+librarian".to_string()),
            bubbles: vec![FactoidBubble {
                category: "recording".to_string(),
                headline: "Studio Session".to_string(),
                body: format!(
                    "Unique librarian factoid {nanos} recorded in a single take on analog tape."
                ),
                source: "Wikipedia".to_string(),
                start_sec: 24,
                duration_sec: 12,
                part_index: Some(1),
                part_total: Some(1),
            }],
        };

        let imported = import_cached_factoids(&item).unwrap();
        assert!(imported.found);
        assert_eq!(imported.bubbles.len(), 1);

        let fetched = fetch_track_factoids(
            Some(&uri),
            &format!("Sample Fact Track {nanos}"),
            "Sample Artist",
            Some("Sample Album"),
            200_000,
        );
        assert!(fetched.found);
        assert!(fetched.provider.contains("librarian"));
        assert_eq!(fetched.bubbles.len(), 1);
        assert_eq!(fetched.bubbles[0].headline, "Studio Session");
        assert_eq!(fetched.bubbles[0].start_sec, 24);
    }

    #[test]
    fn test_coalesce_cached_factoid_bubbles_preserves_pairs_and_four_factoids() {
        let raw = vec![
            (
                "STUDIO LORE".into(),
                "Track 01".into(),
                "The rhythm section was tracked live in a converted warehouse using vintage ribbon microphones and analog tape machines.".into(),
                "Wikipedia".into(),
            ),
            (
                "BAND LORE".into(),
                "Example Artist".into(),
                "Example Artist recorded early demos on a four-track cassette deck.".into(),
                "Wikipedia".into(),
            ),
            (
                "ALBUM".into(),
                "Sample Album".into(),
                "Sample Album was mixed overnight in a small coastal studio while a winter storm knocked out external telephone lines.".into(),
                "Wikipedia".into(),
            ),
            (
                "CRAFT".into(),
                "Example Artist".into(),
                "A custom spring reverb tank gave the lead synth its cavernous tail.".into(),
                "Wikipedia".into(),
            ),
        ];

        let scheduled = schedule_factoid_bubbles(raw, 240_000);
        assert_eq!(scheduled.len(), 6);

        let coalesced = coalesce_cached_factoid_bubbles(scheduled);
        assert_eq!(coalesced.len(), 4);

        let rescheduled = schedule_factoid_bubbles(coalesced, 240_000);
        assert_eq!(rescheduled.len(), 6);
        assert_eq!(rescheduled[0].part_index, Some(1));
        assert_eq!(rescheduled[0].part_total, Some(2));
        assert_eq!(rescheduled[1].part_index, Some(2));
        assert_eq!(rescheduled[1].part_total, Some(2));
        assert_eq!(rescheduled[1].start_sec, rescheduled[0].start_sec + 5);
        assert_eq!(rescheduled[3].part_index, Some(1));
        assert_eq!(rescheduled[3].part_total, Some(2));
        assert_eq!(rescheduled[4].part_index, Some(2));
        assert_eq!(rescheduled[4].part_total, Some(2));
        assert_eq!(rescheduled[4].start_sec, rescheduled[3].start_sec + 5);

        // Ellipsis fallback when part_index/part_total are missing
        let ellipsis_only = vec![
            FactoidBubble {
                category: "STUDIO LORE".into(),
                headline: "Track 02".into(),
                body: "First half of a long studio story recorded onto analog tape …".into(),
                source: "Wikipedia".into(),
                start_sec: 18,
                duration_sec: 0,
                part_index: None,
                part_total: None,
            },
            FactoidBubble {
                category: "STUDIO LORE".into(),
                headline: "Track 02".into(),
                body: "… and completed after adding vintage modular synthesizers.".into(),
                source: "Wikipedia".into(),
                start_sec: 0,
                duration_sec: 0,
                part_index: None,
                part_total: None,
            },
        ];
        let ellipsis_coalesced = coalesce_cached_factoid_bubbles(ellipsis_only);
        assert_eq!(ellipsis_coalesced.len(), 1);
        assert_eq!(
            ellipsis_coalesced[0].2,
            "First half of a long studio story recorded onto analog tape and completed after adding vintage modular synthesizers."
        );
    }

    #[test]
    fn test_cached_v2_replay_keeps_split_parts_back_to_back() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let uri = format!("file:///Volumes/Music/SampleArtist/SampleAlbum/{nanos}_v2_replay.flac");
        let title = format!("Sample V2 Replay {nanos}");
        let artist = "Sample Artist";
        let album = Some("Sample Album");

        let raw = vec![
            (
                "STUDIO LORE".into(),
                title.clone(),
                format!("Factoid one {nanos} was recorded in a converted theater with vintage ribbon microphones and analog tape machines."),
                "Wikipedia".into(),
            ),
            (
                "BAND LORE".into(),
                artist.to_string(),
                format!("Short factoid two {nanos} highlights early hardware experiments."),
                "Wikipedia".into(),
            ),
            (
                "ALBUM LORE".into(),
                "Sample Album".into(),
                format!("Factoid three {nanos} was mixed overnight during a winter storm using a custom analog console and spring reverb."),
                "Wikipedia".into(),
            ),
            (
                "CRAFT".into(),
                artist.to_string(),
                format!("Short factoid four {nanos} mentions modular synthesizer patches."),
                "Wikipedia".into(),
            ),
        ];
        let initial_bubbles = schedule_factoid_bubbles(raw, 240_000);
        assert_eq!(initial_bubbles.len(), 6);

        let key = normalize_key(&title, artist, album);
        let resp = TrackFactoidsResponse {
            found: true,
            provider: "wikipedia_v2".to_string(),
            bubbles: initial_bubbles,
        };
        save_factoids_to_db(&key, Some(&uri), &title, artist, album, &resp);

        let fetched = fetch_track_factoids(Some(&uri), &title, artist, album, 240_000);
        assert!(fetched.found);
        assert_eq!(fetched.bubbles.len(), 6);
        assert_eq!(fetched.bubbles[0].part_index, Some(1));
        assert_eq!(fetched.bubbles[0].part_total, Some(2));
        assert_eq!(fetched.bubbles[1].part_index, Some(2));
        assert_eq!(fetched.bubbles[1].part_total, Some(2));
        assert_eq!(
            fetched.bubbles[1].start_sec,
            fetched.bubbles[0].start_sec + fetched.bubbles[0].duration_sec
        );
        assert_eq!(fetched.bubbles[3].part_index, Some(1));
        assert_eq!(fetched.bubbles[3].part_total, Some(2));
        assert_eq!(fetched.bubbles[4].part_index, Some(2));
        assert_eq!(fetched.bubbles[4].part_total, Some(2));
        assert_eq!(
            fetched.bubbles[4].start_sec,
            fetched.bubbles[3].start_sec + fetched.bubbles[3].duration_sec
        );
    }

    #[test]
    fn test_split_sentence_into_three_or_four_parts_completes_thought_without_truncation() {
        let long_sentence = "During the marathon winter recording sessions at the coastal studio, the engineers custom-wired three vintage spring reverb tanks in series, bounced the analog tape drums through a guitar amplifier, and captured the final vocal take before dawn.";
        assert!(long_sentence.chars().count() > 210);

        let parts = split_sentence_into_bubble_parts(long_sentence);
        assert!(
            parts.len() == 3 || parts.len() == 4,
            "expected 3 or 4 parts, got {}: {:?}",
            parts.len(),
            parts
        );
        for (idx, p) in parts.iter().enumerate() {
            assert!(
                p.chars().count() <= 92,
                "part {} exceeded 92 chars ({}): {}",
                idx + 1,
                p.chars().count(),
                p
            );
            if idx == 0 {
                assert!(p.ends_with(" …"), "part 1 missing trailing ellipsis: {p}");
            } else if idx + 1 < parts.len() {
                assert!(p.starts_with("… "), "middle part missing leading ellipsis: {p}");
                assert!(p.ends_with(" …"), "middle part missing trailing ellipsis: {p}");
            } else {
                assert!(p.starts_with("… "), "final part missing leading ellipsis: {p}");
                assert!(
                    p.ends_with('.'),
                    "final part must complete the sentence without trailing ellipsis: {p}"
                );
                assert!(!p.ends_with('…'));
            }
        }

        let scheduled = schedule_factoid_bubbles(
            vec![(
                "STUDIO LORE".into(),
                "Track 01".into(),
                long_sentence.to_string(),
                "Wikipedia".into(),
            )],
            240_000,
        );
        assert_eq!(scheduled.len(), parts.len());
        for (idx, bubble) in scheduled.iter().enumerate() {
            assert_eq!(bubble.part_index, Some((idx + 1) as u8));
            assert_eq!(bubble.part_total, Some(parts.len() as u8));
            assert_eq!(bubble.duration_sec, 5);
            if idx > 0 {
                assert_eq!(bubble.start_sec, scheduled[idx - 1].start_sec + 5);
            }
        }

        let coalesced = coalesce_cached_factoid_bubbles(scheduled);
        assert_eq!(coalesced.len(), 1);
        assert!(coalesced[0].2.ends_with("before dawn."));
        let rescheduled = schedule_factoid_bubbles(coalesced, 240_000);
        assert_eq!(rescheduled.len(), parts.len());
        for idx in 1..rescheduled.len() {
            assert_eq!(rescheduled[idx].start_sec, rescheduled[idx - 1].start_sec + 5);
        }
    }

    #[test]
    fn test_sentence_splitter_handles_abbreviations_and_skips_mid_sentence_truncation() {
        let abbr_extract = "Dr. Example arrived in St. Louis before the No. 1 U.S. Billboard debut of the project. Critics noted how B. B. King influenced the studio arrangement during the late-night session.";
        let parsed = split_extract_into_sentences(abbr_extract, 4);
        assert_eq!(parsed.len(), 2, "got: {:?}", parsed);
        assert!(parsed[0].contains("Dr. Example") && parsed[0].contains("St. Louis"));
        assert!(parsed[1].contains("B. B. King"));

        let long_complete_plus_runon = "This overly dense encyclopedic run-on sentence goes far beyond three hundred and forty characters by stacking endless parenthetical trivia credits, unedited mastering engineer rosters, obscure catalog release variants, international cassette pressings, regional distribution footnotes, promotional sampler dates, and exhaustive remix tracklists into a single breath without stopping. Meanwhile, the shorter 230-character follow-up sentence about recording drums inside a concrete stairwell during a thunderstorm completes its entire musical thought cleanly and ends right here.";
        let picked = split_extract_into_sentences(long_complete_plus_runon, 2);
        assert_eq!(picked.len(), 1, "expected run-on >340 chars to be skipped: {:?}", picked);
        assert!(picked[0].starts_with("Meanwhile"));
        assert!(picked[0].ends_with("right here."));
    }

    #[test]
    fn test_schedule_factoid_bubbles_prevents_overlap_for_multipart_and_end_of_track() {
        let items = vec![
            (
                "STUDIO LORE".into(),
                "Track 01".into(),
                "During the marathon winter recording sessions at the coastal studio, the engineers custom-wired three vintage spring reverb tanks in series, bounced the analog tape drums through a guitar amplifier, and captured the final vocal take before dawn.".into(),
                "Wikipedia".into(),
            ),
            (
                "BAND LORE".into(),
                "Example Artist".into(),
                "In a later interview, the rhythm section explained that half of the percussive loops came from tapping empty studio tape reels with drumsticks while testing the control room monitors.".into(),
                "Wikipedia".into(),
            ),
            (
                "LEGACY & LORE".into(),
                "Sample Album".into(),
                "Music historians eventually highlighted the album's sparse nocturnal production for inspiring a wave of bedroom electronic producers who worked exclusively with portable four-track hardware.".into(),
                "Wikipedia".into(),
            ),
            (
                "CRAFT".into(),
                "Example Artist".into(),
                "Even years afterward, mastering engineers praised the wide dynamic headroom left intact on the original stereo mixdown before loudness wars reshaped pop radio mastering.".into(),
                "Wikipedia".into(),
            ),
        ];

        // Standard track: verify multi-part bubbles never collide with the next factoid slot
        let scheduled = schedule_factoid_bubbles(items.clone(), 200_000);
        for pair in scheduled.windows(2) {
            assert!(
                pair[1].start_sec >= pair[0].start_sec + pair[0].duration_sec,
                "overlapping bubbles: {:?} vs {:?}",
                pair[0],
                pair[1]
            );
        }

        // Short 90s track: verify nothing extends past track_sec - 4 (86s)
        let short_scheduled = schedule_factoid_bubbles(items, 90_000);
        assert!(!short_scheduled.is_empty());
        for b in &short_scheduled {
            assert!(
                b.start_sec + b.duration_sec <= 86,
                "bubble exceeded short track hard_end 86s: {:?}",
                b
            );
        }
    }
}
