use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CachedShelfRecord {
    pub cache_key: String,
    pub provider: String,
    pub shelf_id: String,
    pub title: String,
    pub payload_json: String,
    pub fetched_at: i64,
    pub ttl_sec: i64,
}

impl CachedShelfRecord {
    pub fn is_stale(&self, now_unix: i64) -> bool {
        now_unix.saturating_sub(self.fetched_at) > self.ttl_sec.max(1)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FypShelfRecord {
    pub shelf_uid: String,
    pub provider: String,
    pub shelf_kind: String,
    pub title: String,
    pub descriptor_json: String,
    pub sort_order: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiberationTrackRecord {
    pub library_song_id: String,
    pub catalog_id: Option<String>,
    pub purchased_id: Option<String>,
    pub isrc: Option<String>,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub library_album_id: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub album_track_count: Option<u32>,
    pub duration_ms: u64,
    pub year: Option<u32>,
    pub genre: String,
    pub artwork_url: Option<String>,
    pub cloud_origin_hint: String,
    pub ownership_class: String,
    pub asset_flavor: Option<String>,
    pub asset_url_kind: Option<String>,
    pub observed_flavors_json: String,
    pub content_length_bytes: Option<u64>,
    pub probe_status: String,
    pub verification_status: String,
    pub blake3_hash: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiberationFlavorStat {
    pub flavor: String,
    pub count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiberationCensusSummary {
    pub total_tracks: usize,
    pub probed_tracks: usize,
    pub pending_tracks: usize,
    pub reclaimable_direct: usize,
    pub reclaimable_clear_hls: usize,
    pub subscription_drm_excluded: usize,
    pub unavailable_tracks: usize,
    pub error_tracks: usize,
    pub origin_purchased: usize,
    pub origin_matched: usize,
    pub origin_uploaded: usize,
    pub origin_subscription: usize,
    pub origin_unknown: usize,
    pub estimated_reclaimable_bytes: u64,
    pub observed_flavors: Vec<LiberationFlavorStat>,
}

#[derive(Clone)]
pub struct ServicesCacheDatabase {
    conn: Arc<Mutex<Connection>>,
}

pub fn current_unix_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn normalize_cache_provider(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "apple" | "apple_music" => "apple_music".to_string(),
        "sc" | "soundcloud" => "soundcloud".to_string(),
        "ia" | "archive" | "internet_archive" | "ia_video" => "internet_archive".to_string(),
        "local" | "local_video" | "local_audio" => "local".to_string(),
        other => other.to_string(),
    }
}

impl ServicesCacheDatabase {
    /// Opens or initializes `servicesCache.db` in SQLite WAL mode.
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
        conn.execute_batch(
            "
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -1500;

            CREATE TABLE IF NOT EXISTS cached_shelves (
                cache_key    TEXT PRIMARY KEY,
                provider     TEXT NOT NULL,
                shelf_id     TEXT NOT NULL,
                title        TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                fetched_at   INTEGER NOT NULL,
                ttl_sec      INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_cached_shelves_provider
                ON cached_shelves(provider);

            CREATE TABLE IF NOT EXISTS fyp_shelves (
                shelf_uid       TEXT PRIMARY KEY,
                provider        TEXT NOT NULL,
                shelf_kind      TEXT NOT NULL,
                title           TEXT NOT NULL,
                descriptor_json TEXT NOT NULL,
                sort_order      INTEGER NOT NULL,
                enabled         INTEGER NOT NULL DEFAULT 1
            );

            CREATE INDEX IF NOT EXISTS idx_fyp_shelves_order
                ON fyp_shelves(sort_order ASC, shelf_uid ASC);

            CREATE TABLE IF NOT EXISTS liberation_tracks (
                library_song_id       TEXT PRIMARY KEY,
                catalog_id            TEXT,
                purchased_id          TEXT,
                isrc                  TEXT,
                title                 TEXT NOT NULL,
                artist                TEXT NOT NULL,
                album_artist          TEXT NOT NULL DEFAULT '',
                album                 TEXT NOT NULL,
                library_album_id      TEXT,
                track_number          INTEGER,
                disc_number           INTEGER,
                album_track_count     INTEGER,
                duration_ms           INTEGER NOT NULL DEFAULT 0,
                year                  INTEGER,
                genre                 TEXT NOT NULL DEFAULT '',
                artwork_url           TEXT,
                cloud_origin_hint     TEXT NOT NULL DEFAULT 'unknown',
                ownership_class       TEXT NOT NULL DEFAULT 'pending',
                asset_flavor          TEXT,
                asset_url_kind        TEXT,
                observed_flavors_json TEXT NOT NULL DEFAULT '[]',
                content_length_bytes  INTEGER,
                probe_status          TEXT NOT NULL DEFAULT 'pending',
                verification_status   TEXT NOT NULL DEFAULT 'not_downloaded',
                blake3_hash           TEXT,
                last_error            TEXT,
                updated_at            INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_liberation_tracks_ownership
                ON liberation_tracks(ownership_class);
            CREATE INDEX IF NOT EXISTS idx_liberation_tracks_probe_status
                ON liberation_tracks(probe_status);
            CREATE INDEX IF NOT EXISTS idx_liberation_tracks_album
                ON liberation_tracks(artist, album);
            ",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn get_cached_shelf(&self, cache_key: &str) -> Result<Option<CachedShelfRecord>> {
        let conn = self.conn.lock().unwrap();
        let rec = conn
            .query_row(
                "SELECT cache_key, provider, shelf_id, title, payload_json, fetched_at, ttl_sec
                 FROM cached_shelves
                 WHERE cache_key = ?1",
                params![cache_key],
                |row| {
                    Ok(CachedShelfRecord {
                        cache_key: row.get(0)?,
                        provider: row.get(1)?,
                        shelf_id: row.get(2)?,
                        title: row.get(3)?,
                        payload_json: row.get(4)?,
                        fetched_at: row.get(5)?,
                        ttl_sec: row.get(6)?,
                    })
                },
            )
            .optional()?;
        Ok(rec)
    }

    pub fn list_cached_shelves(&self, provider: Option<&str>) -> Result<Vec<CachedShelfRecord>> {
        let conn = self.conn.lock().unwrap();
        let normalized = provider.map(normalize_cache_provider);
        let mut stmt = conn.prepare(
            "SELECT cache_key, provider, shelf_id, title, payload_json, fetched_at, ttl_sec
             FROM cached_shelves
             WHERE (?1 IS NULL OR provider = ?1)
             ORDER BY fetched_at DESC, cache_key ASC",
        )?;
        let rows = stmt.query_map(params![normalized], |row| {
            Ok(CachedShelfRecord {
                cache_key: row.get(0)?,
                provider: row.get(1)?,
                shelf_id: row.get(2)?,
                title: row.get(3)?,
                payload_json: row.get(4)?,
                fetched_at: row.get(5)?,
                ttl_sec: row.get(6)?,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn upsert_cached_shelf(&self, rec: &CachedShelfRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let fetched_at = if rec.fetched_at > 0 {
            rec.fetched_at
        } else {
            current_unix_sec()
        };
        let provider = normalize_cache_provider(&rec.provider);
        conn.execute(
            "INSERT INTO cached_shelves (cache_key, provider, shelf_id, title, payload_json, fetched_at, ttl_sec)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(cache_key) DO UPDATE SET
                 provider = excluded.provider,
                 shelf_id = excluded.shelf_id,
                 title = excluded.title,
                 payload_json = excluded.payload_json,
                 fetched_at = excluded.fetched_at,
                 ttl_sec = excluded.ttl_sec",
            params![
                rec.cache_key,
                provider,
                rec.shelf_id,
                rec.title,
                rec.payload_json,
                fetched_at,
                rec.ttl_sec.max(1)
            ],
        )?;
        Ok(())
    }

    pub fn list_fyp_shelves(&self) -> Result<Vec<FypShelfRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT shelf_uid, provider, shelf_kind, title, descriptor_json, sort_order, enabled
             FROM fyp_shelves
             ORDER BY sort_order ASC, shelf_uid ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let enabled_i: i64 = row.get(6)?;
            Ok(FypShelfRecord {
                shelf_uid: row.get(0)?,
                provider: row.get(1)?,
                shelf_kind: row.get(2)?,
                title: row.get(3)?,
                descriptor_json: row.get(4)?,
                sort_order: row.get(5)?,
                enabled: enabled_i != 0,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn save_fyp_shelves(&self, shelves: &[FypShelfRecord]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM fyp_shelves", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO fyp_shelves (shelf_uid, provider, shelf_kind, title, descriptor_json, sort_order, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (idx, s) in shelves.iter().enumerate() {
                stmt.execute(params![
                    s.shelf_uid,
                    normalize_cache_provider(&s.provider),
                    s.shelf_kind,
                    s.title,
                    s.descriptor_json,
                    idx as i64,
                    if s.enabled { 1i64 } else { 0i64 }
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_fyp_shelf(&self, shelf: &FypShelfRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let existing_order: Option<i64> = conn
            .query_row(
                "SELECT sort_order FROM fyp_shelves WHERE shelf_uid = ?1",
                params![shelf.shelf_uid],
                |r| r.get(0),
            )
            .optional()?;
        let sort_order = match existing_order {
            Some(ord) => ord,
            None => {
                let max_ord: i64 = conn
                    .query_row(
                        "SELECT COALESCE(MAX(sort_order), -1) FROM fyp_shelves",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(-1);
                max_ord + 1
            }
        };
        conn.execute(
            "INSERT INTO fyp_shelves (shelf_uid, provider, shelf_kind, title, descriptor_json, sort_order, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(shelf_uid) DO UPDATE SET
                 provider = excluded.provider,
                 shelf_kind = excluded.shelf_kind,
                 title = excluded.title,
                 descriptor_json = excluded.descriptor_json,
                 enabled = excluded.enabled",
            params![
                shelf.shelf_uid,
                normalize_cache_provider(&shelf.provider),
                shelf.shelf_kind,
                shelf.title,
                shelf.descriptor_json,
                sort_order,
                if shelf.enabled { 1i64 } else { 0i64 }
            ],
        )?;
        Ok(())
    }

    pub fn delete_fyp_shelf(&self, shelf_uid: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute(
            "DELETE FROM fyp_shelves WHERE shelf_uid = ?1",
            params![shelf_uid],
        )?;
        Ok(deleted > 0)
    }

    pub fn purge_provider_cache(&self, provider: &str) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let normalized = normalize_cache_provider(provider);
        let c1 = conn.execute(
            "DELETE FROM cached_shelves WHERE provider = ?1",
            params![normalized],
        )?;
        let c2 = conn.execute(
            "DELETE FROM fyp_shelves WHERE provider = ?1",
            params![normalized],
        )?;
        let c3 = if normalized == "apple_music" {
            conn.execute("DELETE FROM liberation_tracks", [])?
        } else {
            0
        };
        Ok(c1 + c2 + c3)
    }

    pub fn upsert_liberation_tracks_batch(&self, tracks: &[LiberationTrackRecord]) -> Result<usize> {
        if tracks.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut count = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO liberation_tracks (
                    library_song_id, catalog_id, purchased_id, isrc, title, artist, album_artist, album,
                    library_album_id, track_number, disc_number, album_track_count, duration_ms, year, genre,
                    artwork_url, cloud_origin_hint, ownership_class, asset_flavor, asset_url_kind,
                    observed_flavors_json, content_length_bytes, probe_status, verification_status, blake3_hash,
                    last_error, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                    ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, ?18, ?19, ?20,
                    ?21, ?22, ?23, ?24, ?25,
                    ?26, ?27
                 )
                 ON CONFLICT(library_song_id) DO UPDATE SET
                    catalog_id = COALESCE(excluded.catalog_id, liberation_tracks.catalog_id),
                    purchased_id = COALESCE(excluded.purchased_id, liberation_tracks.purchased_id),
                    isrc = COALESCE(excluded.isrc, liberation_tracks.isrc),
                    title = excluded.title,
                    artist = excluded.artist,
                    album_artist = excluded.album_artist,
                    album = excluded.album,
                    library_album_id = COALESCE(excluded.library_album_id, liberation_tracks.library_album_id),
                    track_number = COALESCE(excluded.track_number, liberation_tracks.track_number),
                    disc_number = COALESCE(excluded.disc_number, liberation_tracks.disc_number),
                    album_track_count = COALESCE(excluded.album_track_count, liberation_tracks.album_track_count),
                    duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE liberation_tracks.duration_ms END,
                    year = COALESCE(excluded.year, liberation_tracks.year),
                    genre = CASE WHEN excluded.genre != '' THEN excluded.genre ELSE liberation_tracks.genre END,
                    artwork_url = COALESCE(excluded.artwork_url, liberation_tracks.artwork_url),
                    cloud_origin_hint = CASE WHEN liberation_tracks.probe_status != 'probed' THEN excluded.cloud_origin_hint ELSE liberation_tracks.cloud_origin_hint END,
                    updated_at = excluded.updated_at",
            )?;
            for t in tracks {
                stmt.execute(params![
                    t.library_song_id,
                    t.catalog_id,
                    t.purchased_id,
                    t.isrc,
                    t.title,
                    t.artist,
                    t.album_artist,
                    t.album,
                    t.library_album_id,
                    t.track_number.map(|v| v as i64),
                    t.disc_number.map(|v| v as i64),
                    t.album_track_count.map(|v| v as i64),
                    t.duration_ms as i64,
                    t.year.map(|v| v as i64),
                    t.genre,
                    t.artwork_url,
                    t.cloud_origin_hint,
                    t.ownership_class,
                    t.asset_flavor,
                    t.asset_url_kind,
                    t.observed_flavors_json,
                    t.content_length_bytes.map(|v| v as i64),
                    t.probe_status,
                    t.verification_status,
                    t.blake3_hash,
                    t.last_error,
                    t.updated_at,
                ])?;
                count += 1;
            }
        }
        tx.commit()?;
        Ok(count)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_liberation_probe_result(
        &self,
        library_song_id: &str,
        ownership_class: &str,
        cloud_origin_hint_override: Option<&str>,
        asset_flavor: Option<&str>,
        asset_url_kind: Option<&str>,
        observed_flavors_json: &str,
        content_length_bytes: Option<u64>,
        probe_status: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = current_unix_sec();
        conn.execute(
            "UPDATE liberation_tracks
             SET ownership_class = ?2,
                 cloud_origin_hint = COALESCE(?3, cloud_origin_hint),
                 asset_flavor = ?4,
                 asset_url_kind = ?5,
                 observed_flavors_json = ?6,
                 content_length_bytes = COALESCE(?7, content_length_bytes),
                 probe_status = ?8,
                 last_error = ?9,
                 updated_at = ?10
             WHERE library_song_id = ?1",
            params![
                library_song_id,
                ownership_class,
                cloud_origin_hint_override,
                asset_flavor,
                asset_url_kind,
                observed_flavors_json,
                content_length_bytes.map(|v| v as i64),
                probe_status,
                last_error,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn list_pending_liberation_tracks(
        &self,
        limit: usize,
    ) -> Result<Vec<(String, Option<String>, Option<String>, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT library_song_id, catalog_id, purchased_id, cloud_origin_hint
             FROM liberation_tracks
             WHERE probe_status = 'pending'
             ORDER BY
               CASE cloud_origin_hint
                 WHEN 'purchased' THEN 0
                 WHEN 'uploaded' THEN 1
                 ELSE 2
               END ASC,
               artist ASC, album ASC, disc_number ASC, track_number ASC, library_song_id ASC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.max(1) as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn list_stratified_sample_liberation_tracks(
        &self,
        per_bucket: usize,
    ) -> Result<Vec<(String, Option<String>, Option<String>, String)>> {
        let conn = self.conn.lock().unwrap();
        let cap = per_bucket.max(1) as i64;
        let queries = [
            "SELECT library_song_id, catalog_id, purchased_id, cloud_origin_hint
             FROM liberation_tracks
             WHERE probe_status = 'pending' AND cloud_origin_hint = 'purchased'
             ORDER BY artist ASC, album ASC, library_song_id ASC
             LIMIT ?1",
            "SELECT library_song_id, catalog_id, purchased_id, cloud_origin_hint
             FROM liberation_tracks
             WHERE probe_status = 'pending' AND cloud_origin_hint = 'uploaded'
             ORDER BY artist ASC, album ASC, library_song_id ASC
             LIMIT ?1",
            "SELECT library_song_id, catalog_id, purchased_id, cloud_origin_hint
             FROM liberation_tracks
             WHERE probe_status = 'pending' AND cloud_origin_hint NOT IN ('purchased', 'uploaded')
             ORDER BY artist ASC, album ASC, library_song_id ASC
             LIMIT ?1",
        ];
        let mut combined = Vec::with_capacity((cap as usize) * 3);
        for sql in queries {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![cap], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            combined.extend(rows.filter_map(Result::ok));
        }
        Ok(combined)
    }

    pub fn reset_liberation_error_probes(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE liberation_tracks
             SET probe_status = 'pending',
                 ownership_class = 'pending',
                 asset_flavor = NULL,
                 asset_url_kind = NULL,
                 observed_flavors_json = '[]',
                 last_error = NULL
             WHERE probe_status = 'error' OR ownership_class = 'error'",
            [],
        )?;
        Ok(updated)
    }

    pub fn get_liberation_census_summary(&self) -> Result<LiberationCensusSummary> {
        let conn = self.conn.lock().unwrap();
        let mut summary = LiberationCensusSummary::default();

        summary.total_tracks = conn
            .query_row("SELECT COUNT(*) FROM liberation_tracks", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(0)
            .max(0) as usize;
        summary.probed_tracks = conn
            .query_row(
                "SELECT COUNT(*) FROM liberation_tracks WHERE probe_status != 'pending'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
            .max(0) as usize;
        summary.pending_tracks = summary.total_tracks.saturating_sub(summary.probed_tracks);

        {
            let mut stmt = conn.prepare(
                "SELECT ownership_class, COUNT(*) FROM liberation_tracks GROUP BY ownership_class",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows.flatten() {
                let c = row.1.max(0) as usize;
                match row.0.as_str() {
                    "reclaimable_direct" => summary.reclaimable_direct += c,
                    "reclaimable_clear_hls" => summary.reclaimable_clear_hls += c,
                    "subscription_drm_excluded" => summary.subscription_drm_excluded += c,
                    "unavailable" => summary.unavailable_tracks += c,
                    "error" => summary.error_tracks += c,
                    _ => {}
                }
            }
        }

        {
            let mut stmt = conn.prepare(
                "SELECT cloud_origin_hint, COUNT(*) FROM liberation_tracks GROUP BY cloud_origin_hint",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows.flatten() {
                let c = row.1.max(0) as usize;
                match row.0.as_str() {
                    "purchased" => summary.origin_purchased += c,
                    "matched" => summary.origin_matched += c,
                    "uploaded" => summary.origin_uploaded += c,
                    "subscription" => summary.origin_subscription += c,
                    _ => summary.origin_unknown += c,
                }
            }
        }

        let est_bytes: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(COALESCE(content_length_bytes, CAST(duration_ms AS INTEGER) * 32)), 0)
                 FROM liberation_tracks
                 WHERE ownership_class IN ('reclaimable_direct', 'reclaimable_clear_hls')",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        summary.estimated_reclaimable_bytes = est_bytes.max(0) as u64;

        let mut flavor_counts: HashMap<String, usize> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT observed_flavors_json FROM liberation_tracks WHERE observed_flavors_json != '[]'",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for json_str in rows.flatten() {
                if let Ok(flavors) = serde_json::from_str::<Vec<String>>(&json_str) {
                    for f in flavors {
                        if !f.trim().is_empty() {
                            *flavor_counts.entry(f).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
        let mut observed_flavors: Vec<LiberationFlavorStat> = flavor_counts
            .into_iter()
            .map(|(flavor, count)| LiberationFlavorStat { flavor, count })
            .collect();
        observed_flavors.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.flavor.cmp(&b.flavor)));
        summary.observed_flavors = observed_flavors;

        Ok(summary)
    }

    pub fn query_liberation_tracks(
        &self,
        ownership_filter: Option<&str>,
        origin_filter: Option<&str>,
        search: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<LiberationTrackRecord>, usize)> {
        let conn = self.conn.lock().unwrap();
        let ownership_opt = ownership_filter
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "all")
            .map(str::to_ascii_lowercase);
        let origin_opt = origin_filter
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "all")
            .map(str::to_ascii_lowercase);
        let search_like = search
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{}%", s.to_ascii_lowercase()));

        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM liberation_tracks
             WHERE (?1 IS NULL OR ownership_class = ?1)
               AND (?2 IS NULL OR (
                   CASE WHEN ?2 = 'unknown'
                        THEN cloud_origin_hint NOT IN ('purchased', 'matched', 'uploaded', 'subscription')
                        ELSE cloud_origin_hint = ?2
                   END
               ))
               AND (?3 IS NULL OR lower(title) LIKE ?3 OR lower(artist) LIKE ?3 OR lower(album) LIKE ?3 OR lower(library_song_id) LIKE ?3)",
            params![ownership_opt, origin_opt, search_like],
            |r| r.get(0),
        )?;

        let mut stmt = conn.prepare(
            "SELECT library_song_id, catalog_id, purchased_id, isrc, title, artist, album_artist, album,
                    library_album_id, track_number, disc_number, album_track_count, duration_ms, year, genre,
                    artwork_url, cloud_origin_hint, ownership_class, asset_flavor, asset_url_kind,
                    observed_flavors_json, content_length_bytes, probe_status, verification_status, blake3_hash,
                    last_error, updated_at
             FROM liberation_tracks
             WHERE (?1 IS NULL OR ownership_class = ?1)
               AND (?2 IS NULL OR (
                   CASE WHEN ?2 = 'unknown'
                        THEN cloud_origin_hint NOT IN ('purchased', 'matched', 'uploaded', 'subscription')
                        ELSE cloud_origin_hint = ?2
                   END
               ))
               AND (?3 IS NULL OR lower(title) LIKE ?3 OR lower(artist) LIKE ?3 OR lower(album) LIKE ?3 OR lower(library_song_id) LIKE ?3)
             ORDER BY artist ASC, album ASC, COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC, title ASC
             LIMIT ?4 OFFSET ?5",
        )?;

        let rows = stmt.query_map(
            params![
                ownership_opt,
                origin_opt,
                search_like,
                limit.clamp(1, 500) as i64,
                offset as i64
            ],
            Self::map_liberation_track_row,
        )?;
        Ok((rows.filter_map(Result::ok).collect(), total.max(0) as usize))
    }

    pub fn list_all_liberation_tracks(&self) -> Result<Vec<LiberationTrackRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT library_song_id, catalog_id, purchased_id, isrc, title, artist, album_artist, album,
                    library_album_id, track_number, disc_number, album_track_count, duration_ms, year, genre,
                    artwork_url, cloud_origin_hint, ownership_class, asset_flavor, asset_url_kind,
                    observed_flavors_json, content_length_bytes, probe_status, verification_status, blake3_hash,
                    last_error, updated_at
             FROM liberation_tracks
             ORDER BY artist ASC, album ASC, COALESCE(disc_number, 1) ASC, COALESCE(track_number, 0) ASC, title ASC",
        )?;
        let rows = stmt.query_map([], Self::map_liberation_track_row)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn clear_liberation_tracks(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute("DELETE FROM liberation_tracks", [])?;
        Ok(deleted)
    }

    fn map_liberation_track_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiberationTrackRecord> {
        let tn: Option<i64> = row.get(9)?;
        let dn: Option<i64> = row.get(10)?;
        let atc: Option<i64> = row.get(11)?;
        let dur: i64 = row.get(12)?;
        let yr: Option<i64> = row.get(13)?;
        let clb: Option<i64> = row.get(21)?;
        Ok(LiberationTrackRecord {
            library_song_id: row.get(0)?,
            catalog_id: row.get(1)?,
            purchased_id: row.get(2)?,
            isrc: row.get(3)?,
            title: row.get(4)?,
            artist: row.get(5)?,
            album_artist: row.get(6)?,
            album: row.get(7)?,
            library_album_id: row.get(8)?,
            track_number: tn.and_then(|v| if v > 0 { Some(v as u32) } else { None }),
            disc_number: dn.and_then(|v| if v > 0 { Some(v as u32) } else { None }),
            album_track_count: atc.and_then(|v| if v > 0 { Some(v as u32) } else { None }),
            duration_ms: dur.max(0) as u64,
            year: yr.and_then(|v| if v > 0 { Some(v as u32) } else { None }),
            genre: row.get(14)?,
            artwork_url: row.get(15)?,
            cloud_origin_hint: row.get(16)?,
            ownership_class: row.get(17)?,
            asset_flavor: row.get(18)?,
            asset_url_kind: row.get(19)?,
            observed_flavors_json: row.get(20)?,
            content_length_bytes: clb.and_then(|v| if v >= 0 { Some(v as u64) } else { None }),
            probe_status: row.get(22)?,
            verification_status: row.get(23)?,
            blake3_hash: row.get(24)?,
            last_error: row.get(25)?,
            updated_at: row.get(26)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cache_db_path(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("simp_services_cache_{label}_{nanos}"))
            .join("servicesCache.db")
    }

    #[test]
    fn test_services_cache_upsert_and_staleness() {
        let db_path = temp_cache_db_path("ttl");
        let db = ServicesCacheDatabase::open(&db_path).unwrap();

        let rec = CachedShelfRecord {
            cache_key: "apple:for_you:mixes".to_string(),
            provider: "apple".to_string(),
            shelf_id: "mixes".to_string(),
            title: "Made For You Mixes".to_string(),
            payload_json: r#"[{"id":"pl-1","name":"Sample Mix"}]"#.to_string(),
            fetched_at: 1_000,
            ttl_sec: 1_800,
        };
        db.upsert_cached_shelf(&rec).unwrap();

        let loaded = db.get_cached_shelf("apple:for_you:mixes").unwrap().unwrap();
        assert_eq!(loaded.provider, "apple_music");
        assert_eq!(loaded.title, "Made For You Mixes");
        assert!(!loaded.is_stale(2_500));
        assert!(loaded.is_stale(2_900));

        let by_provider = db.list_cached_shelves(Some("apple_music")).unwrap();
        assert_eq!(by_provider.len(), 1);

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_fyp_shelves_ordering_and_purge() {
        let db_path = temp_cache_db_path("order_purge");
        let db = ServicesCacheDatabase::open(&db_path).unwrap();

        db.upsert_cached_shelf(&CachedShelfRecord {
            cache_key: "sc:discover:for_you".to_string(),
            provider: "sc".to_string(),
            shelf_id: "for_you".to_string(),
            title: "More of what you like".to_string(),
            payload_json: "[]".to_string(),
            fetched_at: 500,
            ttl_sec: 1800,
        })
        .unwrap();
        db.upsert_cached_shelf(&CachedShelfRecord {
            cache_key: "local:discover:recent".to_string(),
            provider: "local".to_string(),
            shelf_id: "recent".to_string(),
            title: "Recently Added Local Releases".to_string(),
            payload_json: "[]".to_string(),
            fetched_at: 500,
            ttl_sec: 3600,
        })
        .unwrap();

        let s1 = FypShelfRecord {
            shelf_uid: "sc:discover:for_you".to_string(),
            provider: "soundcloud".to_string(),
            shelf_kind: "tracks".to_string(),
            title: "More of what you like".to_string(),
            descriptor_json: "{}".to_string(),
            sort_order: 5,
            enabled: true,
        };
        let s2 = FypShelfRecord {
            shelf_uid: "local:discover:recent".to_string(),
            provider: "local".to_string(),
            shelf_kind: "albums".to_string(),
            title: "Recently Added Local Releases".to_string(),
            descriptor_json: "{}".to_string(),
            sort_order: 1,
            enabled: true,
        };
        db.save_fyp_shelves(&[s2.clone(), s1.clone()]).unwrap();
        let ordered = db.list_fyp_shelves().unwrap();
        assert_eq!(ordered.len(), 2);
        assert_eq!(ordered[0].shelf_uid, "local:discover:recent");
        assert_eq!(ordered[0].sort_order, 0);
        assert_eq!(ordered[1].shelf_uid, "sc:discover:for_you");
        assert_eq!(ordered[1].sort_order, 1);

        let purged = db.purge_provider_cache("soundcloud").unwrap();
        assert_eq!(purged, 2);
        assert!(db.get_cached_shelf("sc:discover:for_you").unwrap().is_none());
        assert_eq!(db.list_fyp_shelves().unwrap().len(), 1);
        assert_eq!(
            db.list_fyp_shelves().unwrap()[0].shelf_uid,
            "local:discover:recent"
        );

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }

    fn sample_liberation_track(id: &str, title: &str) -> LiberationTrackRecord {
        LiberationTrackRecord {
            library_song_id: id.to_string(),
            catalog_id: Some("900001".to_string()),
            purchased_id: None,
            isrc: Some("USXXX0000001".to_string()),
            title: title.to_string(),
            artist: "Sample Artist".to_string(),
            album_artist: "Sample Artist".to_string(),
            album: "Sample Album".to_string(),
            library_album_id: Some("l.album01".to_string()),
            track_number: Some(1),
            disc_number: Some(1),
            album_track_count: Some(10),
            duration_ms: 180_000,
            year: Some(2020),
            genre: "Electronic".to_string(),
            artwork_url: None,
            cloud_origin_hint: "matched_or_subscription".to_string(),
            ownership_class: "pending".to_string(),
            asset_flavor: None,
            asset_url_kind: None,
            observed_flavors_json: "[]".to_string(),
            content_length_bytes: None,
            probe_status: "pending".to_string(),
            verification_status: "not_downloaded".to_string(),
            blake3_hash: None,
            last_error: None,
            updated_at: 1_000,
        }
    }

    #[test]
    fn test_liberation_tracks_checkpoint_summary_filter_and_reset() {
        let db_path = temp_cache_db_path("liberation");
        let db = ServicesCacheDatabase::open(&db_path).unwrap();

        let mut t1 = sample_liberation_track("i.sample1", "Track 01");
        t1.purchased_id = Some("777777".to_string());
        t1.cloud_origin_hint = "purchased".to_string();

        let mut t2 = sample_liberation_track("i.sample2", "Track 02");
        t2.track_number = Some(2);
        t2.duration_ms = 200_000; // fallback estimate: 200_000 * 32 = 6_400_000 bytes

        let mut t3 = sample_liberation_track("i.sample3", "Track 03");
        t3.track_number = Some(3);

        let mut t4 = sample_liberation_track("i.sample4", "Track 04");
        t4.cloud_origin_hint = "uploaded".to_string();
        t4.track_number = Some(4);

        let inserted = db
            .upsert_liberation_tracks_batch(&[t1.clone(), t2.clone(), t3.clone(), t4.clone()])
            .unwrap();
        assert_eq!(inserted, 4);

        db.update_liberation_probe_result(
            "i.sample1",
            "reclaimable_direct",
            Some("purchased"),
            Some("itemDownload"),
            Some("direct_audio"),
            r#"["itemDownload","28:ctrp256"]"#,
            Some(8_000_000),
            "probed",
            None,
        )
        .unwrap();

        db.update_liberation_probe_result(
            "i.sample2",
            "reclaimable_clear_hls",
            Some("matched"),
            Some("plus256"),
            Some("clear_hls_fmp4"),
            r#"["plus256","28:ctrp256"]"#,
            None,
            "probed",
            None,
        )
        .unwrap();

        // Simulate legacy probed+error classification as well as probe_status='error'
        db.update_liberation_probe_result(
            "i.sample3",
            "error",
            None,
            Some("clear_hls"),
            None,
            r#"["unknown"]"#,
            None,
            "probed",
            Some("HLS verification failed"),
        )
        .unwrap();

        // Re-ingesting updated metadata MUST preserve probed ownership & flavor results on t1/t2
        let mut t1_reingest = sample_liberation_track("i.sample1", "Track 01 (Remastered)");
        t1_reingest.cloud_origin_hint = "unknown".to_string();
        db.upsert_liberation_tracks_batch(&[t1_reingest]).unwrap();

        let (rows, total) = db
            .query_liberation_tracks(Some("reclaimable_direct"), Some("purchased"), Some("remastered"), 50, 0)
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].title, "Track 01 (Remastered)");
        assert_eq!(rows[0].ownership_class, "reclaimable_direct");
        assert_eq!(rows[0].cloud_origin_hint, "purchased");

        let summary = db.get_liberation_census_summary().unwrap();
        assert_eq!(summary.total_tracks, 4);
        assert_eq!(summary.probed_tracks, 3);
        assert_eq!(summary.reclaimable_direct, 1);
        assert_eq!(summary.reclaimable_clear_hls, 1);
        assert_eq!(summary.error_tracks, 1);
        assert_eq!(summary.origin_purchased, 1);
        assert_eq!(summary.origin_matched, 1);
        assert_eq!(summary.origin_uploaded, 1);
        assert_eq!(summary.origin_unknown, 1);
        assert_eq!(summary.estimated_reclaimable_bytes, 8_000_000 + 6_400_000);
        assert_eq!(summary.observed_flavors[0].flavor, "28:ctrp256");
        assert_eq!(summary.observed_flavors[0].count, 2);

        let reset = db.reset_liberation_error_probes().unwrap();
        assert_eq!(reset, 1);

        // Now add a purchased pending track too and check stratified sample picks 1 from uploaded + matched_or_subscription + purchased
        let mut t5 = sample_liberation_track("i.sample5", "Track 05");
        t5.purchased_id = Some("999999".to_string());
        t5.cloud_origin_hint = "purchased".to_string();
        db.upsert_liberation_tracks_batch(&[t5]).unwrap();

        let stratified = db.list_stratified_sample_liberation_tracks(1).unwrap();
        assert_eq!(stratified.len(), 3);
        let hints: Vec<&str> = stratified.iter().map(|s| s.3.as_str()).collect();
        assert_eq!(hints, vec!["purchased", "uploaded", "matched_or_subscription"]);

        // Full pending order prioritizes purchased first
        let pending = db.list_pending_liberation_tracks(10).unwrap();
        assert_eq!(pending.len(), 3);
        assert_eq!(pending[0].0, "i.sample5");

        let deleted = db.clear_liberation_tracks().unwrap();
        assert_eq!(deleted, 5);
        assert_eq!(db.get_liberation_census_summary().unwrap().total_tracks, 0);

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }
}
