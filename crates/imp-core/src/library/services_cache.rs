use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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

const FYP_SEEDED_PREF_KEY: &str = "fyp_seeded_v1";

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

            CREATE TABLE IF NOT EXISTS ui_prefs (
                pref_key   TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            ",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn mark_fyp_seeded_conn(conn: &Connection) -> Result<()> {
        conn.execute(
            "INSERT INTO ui_prefs (pref_key, value_json, updated_at)
             VALUES (?1, 'true', ?2)
             ON CONFLICT(pref_key) DO UPDATE SET
                 value_json = excluded.value_json,
                 updated_at = excluded.updated_at",
            params![FYP_SEEDED_PREF_KEY, current_unix_sec()],
        )?;
        Ok(())
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
        Self::mark_fyp_seeded_conn(&tx)?;
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
        Self::mark_fyp_seeded_conn(&conn)?;
        Ok(())
    }

    pub fn delete_fyp_shelf(&self, shelf_uid: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute(
            "DELETE FROM fyp_shelves WHERE shelf_uid = ?1",
            params![shelf_uid],
        )?;
        Self::mark_fyp_seeded_conn(&conn)?;
        Ok(deleted > 0)
    }

    pub fn set_fyp_shelf_enabled(&self, shelf_uid: &str, enabled: bool) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE fyp_shelves SET enabled = ?1 WHERE shelf_uid = ?2",
            params![if enabled { 1i64 } else { 0i64 }, shelf_uid],
        )?;
        Self::mark_fyp_seeded_conn(&conn)?;
        Ok(updated > 0)
    }

    pub fn is_fyp_seeded(&self) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let pref: Option<String> = conn
            .query_row(
                "SELECT value_json FROM ui_prefs WHERE pref_key = ?1",
                params![FYP_SEEDED_PREF_KEY],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(raw) = pref {
            let trimmed = raw.trim();
            if trimmed == "true" || trimmed == "1" {
                return Ok(true);
            }
            if trimmed == "false" || trimmed == "0" {
                return Ok(false);
            }
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM fyp_shelves", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(count > 0)
    }

    pub fn mark_fyp_seeded(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        Self::mark_fyp_seeded_conn(&conn)
    }

    pub fn get_ui_pref(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let val = conn
            .query_row(
                "SELECT value_json FROM ui_prefs WHERE pref_key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(val)
    }

    pub fn list_ui_prefs(&self) -> Result<std::collections::BTreeMap<String, String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT pref_key, value_json FROM ui_prefs ORDER BY pref_key ASC",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        let mut out = std::collections::BTreeMap::new();
        for pair in rows.flatten() {
            out.insert(pair.0, pair.1);
        }
        Ok(out)
    }

    pub fn set_ui_pref(&self, key: &str, value_json: &str) -> Result<()> {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO ui_prefs (pref_key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(pref_key) DO UPDATE SET
                 value_json = excluded.value_json,
                 updated_at = excluded.updated_at",
            params![trimmed, value_json, current_unix_sec()],
        )?;
        Ok(())
    }

    pub fn delete_ui_pref(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute(
            "DELETE FROM ui_prefs WHERE pref_key = ?1",
            params![key],
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
        Ok(c1 + c2)
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

    #[test]
    fn test_fyp_seeded_persists_after_delete_and_atomic_toggle() {
        let db_path = temp_cache_db_path("fyp_seeded_toggle");
        let db = ServicesCacheDatabase::open(&db_path).unwrap();
        assert!(!db.is_fyp_seeded().unwrap());

        let shelf = FypShelfRecord {
            shelf_uid: "local:discover:recent".to_string(),
            provider: "local".to_string(),
            shelf_kind: "albums".to_string(),
            title: "Recently Added Local Releases".to_string(),
            descriptor_json: "{}".to_string(),
            sort_order: 0,
            enabled: true,
        };
        db.save_fyp_shelves(&[shelf]).unwrap();
        assert!(db.is_fyp_seeded().unwrap());

        assert!(db.set_fyp_shelf_enabled("local:discover:recent", false).unwrap());
        let after_disable = db.list_fyp_shelves().unwrap();
        assert_eq!(after_disable.len(), 1);
        assert!(!after_disable[0].enabled);

        assert!(db.delete_fyp_shelf("local:discover:recent").unwrap());
        assert!(db.list_fyp_shelves().unwrap().is_empty());
        assert!(db.is_fyp_seeded().unwrap());

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_ui_prefs_roundtrip_and_delete() {
        let db_path = temp_cache_db_path("ui_prefs");
        let db = ServicesCacheDatabase::open(&db_path).unwrap();

        assert!(db.get_ui_pref("stats_hud_enabled_v1").unwrap().is_none());
        db.set_ui_pref("stats_hud_enabled_v1", "true").unwrap();
        db.set_ui_pref(
            "source_visibility_v2",
            r#"{"apple_music":true,"soundcloud":false}"#,
        )
        .unwrap();

        assert_eq!(
            db.get_ui_pref("stats_hud_enabled_v1").unwrap().as_deref(),
            Some("true")
        );
        let listed = db.list_ui_prefs().unwrap();
        assert_eq!(listed.len(), 2);

        assert!(db.delete_ui_pref("stats_hud_enabled_v1").unwrap());
        assert!(db.get_ui_pref("stats_hud_enabled_v1").unwrap().is_none());

        let _ = std::fs::remove_dir_all(db_path.parent().unwrap());
    }
}