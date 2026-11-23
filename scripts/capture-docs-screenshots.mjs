#!/usr/bin/env node
/**
 * IMP Sanitized Docs Screenshot Capture Harness (Wave 10.5)
 *
 * Zero-dependency script using Node 22 + local Google Chrome CDP + an in-process
 * mock IMP HTTP/WS server with 100% synthetic placeholder metadata and SVG art.
 *
 * Usage:
 *   node scripts/capture-docs-screenshots.mjs
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const UI_DIST_DIR = path.join(REPO_ROOT, 'ui', 'dist');
const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');
const DAEMON_PORT = 18888;
const CDP_PORT = Number(process.env.IMP_DOCS_CDP_PORT || '9229');

if (!fs.existsSync(path.join(UI_DIST_DIR, 'index.html'))) {
  console.error('❌ Missing ui/dist/index.html — run `npm run build:ui` first.');
  process.exit(1);
}
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// -----------------------------------------------------------------------------
// 100% Synthetic Placeholder Catalog & Generated Vector Artwork (Zero PII)
// -----------------------------------------------------------------------------
const SYNTH_ARTWORKS = {
  'cover-1.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1b2232"/><stop offset="100%" stop-color="#0f1219"/></linearGradient></defs>
    <rect width="400" height="400" fill="url(#g1)"/>
    <circle cx="200" cy="185" r="96" fill="none" stroke="#e8b86d" stroke-width="5" opacity="0.9"/>
    <circle cx="200" cy="185" r="62" fill="#e8b86d" opacity="0.16"/>
    <path d="M40 280 H360 M70 308 H330 M110 336 H290" stroke="#7dd3fc" stroke-width="4" stroke-linecap="round" opacity="0.65"/>
    <rect x="44" y="44" width="60" height="6" rx="3" fill="#e8b86d"/>
  </svg>`,
  'cover-2.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <rect width="400" height="400" fill="#171923"/>
    <rect x="52" y="52" width="296" height="296" rx="28" fill="#1f2536" stroke="#fda4af" stroke-width="4" opacity="0.85"/>
    <circle cx="200" cy="200" r="78" fill="#fb7185" opacity="0.24"/>
    <circle cx="200" cy="200" r="26" fill="#fecdd3"/>
    <path d="M110 300 L200 110 L290 300 Z" fill="none" stroke="#fda4af" stroke-width="4"/>
  </svg>`,
  'cover-3.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <rect width="400" height="400" fill="#131a1c"/>
    <circle cx="200" cy="200" r="130" fill="#16282a" stroke="#34d399" stroke-width="3" opacity="0.8"/>
    <circle cx="200" cy="200" r="88" fill="none" stroke="#6ee7b7" stroke-width="3" stroke-dasharray="14 10"/>
    <rect x="132" y="188" width="16" height="64" rx="4" fill="#34d399"/>
    <rect x="166" y="148" width="16" height="104" rx="4" fill="#6ee7b7"/>
    <rect x="200" y="124" width="16" height="128" rx="4" fill="#a7f3d0"/>
    <rect x="234" y="162" width="16" height="90" rx="4" fill="#6ee7b7"/>
    <rect x="268" y="196" width="16" height="56" rx="4" fill="#34d399"/>
  </svg>`,
  'cover-4.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <rect width="400" height="400" fill="#1c1614"/>
    <rect x="64" y="64" width="272" height="272" rx="16" fill="#271e19" stroke="#fdba74" stroke-width="4"/>
    <path d="M90 250 Q145 140 200 220 T310 175" fill="none" stroke="#fb923c" stroke-width="8" stroke-linecap="round"/>
    <circle cx="200" cy="130" r="32" fill="#fed7aa" opacity="0.78"/>
  </svg>`,
  'cover-5.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <rect width="400" height="400" fill="#161822"/>
    <polygon points="200,56 336,136 336,264 200,344 64,264 64,136" fill="#1f2437" stroke="#93c5fd" stroke-width="4"/>
    <polygon points="200,112 284,160 284,240 200,288 116,240 116,160" fill="#38bdf8" opacity="0.22" stroke="#bae6fd" stroke-width="2"/>
    <circle cx="200" cy="200" r="18" fill="#e0f2fe"/>
  </svg>`,
  'cover-6.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <rect width="400" height="400" fill="#181620"/>
    <circle cx="200" cy="200" r="126" fill="#231f33" stroke="#c4b5fd" stroke-width="4"/>
    <circle cx="200" cy="200" r="40" fill="#121418" stroke="#ddd6fe" stroke-width="4"/>
    <circle cx="200" cy="200" r="10" fill="#e8b86d"/>
  </svg>`,
};

const ART = (n) => `http://127.0.0.1:${DAEMON_PORT}/mock-art/cover-${n}.svg`;

const SYNTH_ALBUMS = [
  {
    id: 'local:album:glass_skyline',
    title: 'Glass Skyline',
    album_artist: 'Neon Horizon',
    release_year: 2025,
    steam_app_id: null,
    art_url: ART(1),
    track_count: 10,
    genre: 'Synthwave',
    parent_folder: '/Music/Neon Horizon/Glass Skyline',
  },
  {
    id: 'local:album:analog_drift',
    title: 'Analog Drift',
    album_artist: 'Signal Ensemble',
    release_year: 2024,
    steam_app_id: null,
    art_url: ART(2),
    track_count: 8,
    genre: 'Electronic',
    parent_folder: '/Music/Signal Ensemble/Analog Drift',
  },
  {
    id: 'local:album:orbital_echoes',
    title: 'Orbital Echoes',
    album_artist: 'Static Garden',
    release_year: 2023,
    steam_app_id: null,
    art_url: ART(3),
    track_count: 12,
    genre: 'Ambient',
    parent_folder: '/Music/Static Garden/Orbital Echoes',
  },
  {
    id: 'local:album:night_bus',
    title: 'Night Bus Sessions',
    album_artist: 'harborline',
    release_year: 2024,
    steam_app_id: null,
    art_url: ART(4),
    track_count: 9,
    genre: 'Downtempo',
    parent_folder: '/Music/harborline/Night Bus Sessions',
  },
  {
    id: 'local:album:telemetry',
    title: 'Velvet Telemetry',
    album_artist: 'Silver Transit',
    release_year: 2022,
    steam_app_id: null,
    art_url: ART(5),
    track_count: 11,
    genre: 'IDM',
    parent_folder: '/Music/Silver Transit/Velvet Telemetry',
  },
  {
    id: 'local:album:rain_static',
    title: 'Static & Rain',
    album_artist: 'Northbound Quartet',
    release_year: 2021,
    steam_app_id: null,
    art_url: ART(6),
    track_count: 7,
    genre: 'Post-Rock',
    parent_folder: '/Music/Northbound Quartet/Static & Rain',
  },
];

const SYNTH_TRACKS = [
  {
    uri: 'file:///Music/Neon%20Horizon/Glass%20Skyline/01%20Midnight%20Signal.flac',
    title: 'Midnight Signal',
    artists: ['Neon Horizon'],
    album: 'Glass Skyline',
    album_id: 'local:album:glass_skyline',
    track_number: 1,
    disc_number: 1,
    art_url: ART(1),
    duration_ms: 224000,
    source: 'local',
    mount_root: '/Music',
    genre: 'Synthwave',
    release_year: 2025,
    parent_folder: 'Neon Horizon/Glass Skyline',
  },
  {
    uri: 'file:///Music/Signal%20Ensemble/Analog%20Drift/02%20Chrome%20Vector.flac',
    title: 'Chrome Vector',
    artists: ['Signal Ensemble'],
    album: 'Analog Drift',
    album_id: 'local:album:analog_drift',
    track_number: 2,
    disc_number: 1,
    art_url: ART(2),
    duration_ms: 198000,
    source: 'local',
    mount_root: '/Music',
    genre: 'Electronic',
    release_year: 2024,
    parent_folder: 'Signal Ensemble/Analog Drift',
  },
  {
    uri: 'file:///Music/Static%20Garden/Orbital%20Echoes/03%20Solar%20Wind.flac',
    title: 'Solar Wind',
    artists: ['Static Garden'],
    album: 'Orbital Echoes',
    album_id: 'local:album:orbital_echoes',
    track_number: 3,
    disc_number: 1,
    art_url: ART(3),
    duration_ms: 251000,
    source: 'local',
    mount_root: '/Music',
    genre: 'Ambient',
    release_year: 2023,
    parent_folder: 'Static Garden/Orbital Echoes',
  },
  {
    uri: 'file:///Music/harborline/Night%20Bus/04%20Crosswalk%20Rain.mp3',
    title: 'Crosswalk Rain',
    artists: ['harborline'],
    album: 'Night Bus Sessions',
    album_id: 'local:album:night_bus',
    track_number: 4,
    disc_number: 1,
    art_url: ART(4),
    duration_ms: 212000,
    source: 'local',
    mount_root: '/Music',
    genre: 'Downtempo',
    release_year: 2024,
    parent_folder: 'harborline/Night Bus Sessions',
  },
  {
    uri: 'file:///Music/Silver%20Transit/Telemetry/05%20Substation.flac',
    title: 'Substation Nine',
    artists: ['Silver Transit'],
    album: 'Velvet Telemetry',
    album_id: 'local:album:telemetry',
    track_number: 5,
    disc_number: 1,
    art_url: ART(5),
    duration_ms: 267000,
    source: 'local',
    mount_root: '/Music',
    genre: 'IDM',
    release_year: 2022,
    parent_folder: 'Silver Transit/Velvet Telemetry',
  },
  {
    uri: 'file:///Music/Northbound/Static%20Rain/06%20After%20Hours.flac',
    title: 'After Hours Broadcast',
    artists: ['Northbound Quartet'],
    album: 'Static & Rain',
    album_id: 'local:album:rain_static',
    track_number: 6,
    disc_number: 1,
    art_url: ART(6),
    duration_ms: 239000,
    source: 'local',
    mount_root: '/Music',
    genre: 'Post-Rock',
    release_year: 2021,
    parent_folder: 'Northbound Quartet/Static & Rain',
  },
];

const SYNTH_PLAYLISTS = [
  {
    id: 'simp:playlist:synthwave',
    name: 'Late Night Synthwave',
    description: 'Hybrid local + lossless synth mix',
    origin: 'simp_local',
    cover_art_url: ART(1),
    track_count: 18,
    updated_at: 1763890000,
    has_local: true,
    has_apple: true,
    has_soundcloud: false,
    has_archive: false,
  },
  {
    id: 'simp:playlist:study',
    name: 'Ambient Focus Mix',
    description: 'Instrumental downtime rotation',
    origin: 'simp_local',
    cover_art_url: ART(3),
    track_count: 24,
    updated_at: 1763880000,
    has_local: true,
    has_apple: false,
    has_soundcloud: true,
    has_archive: false,
  },
  {
    id: 'simp:playlist:cinema',
    name: 'Classic Concert Vault',
    description: 'Live recordings & archival sets',
    origin: 'archive_remote',
    cover_art_url: ART(5),
    track_count: 14,
    updated_at: 1763870000,
    has_local: false,
    has_apple: false,
    has_soundcloud: false,
    has_archive: true,
  },
  {
    id: 'simp:playlist:transit',
    name: 'Morning Transit Mix',
    description: 'Electronic & downtempo picks',
    origin: 'simp_local',
    cover_art_url: ART(4),
    track_count: 16,
    updated_at: 1763860000,
    has_local: true,
    has_apple: false,
    has_soundcloud: false,
    has_archive: false,
  },
  {
    id: 'simp:playlist:telemetry',
    name: 'Signal Discovery',
    description: 'Weekend crate-digging favorites',
    origin: 'apple_remote',
    cover_art_url: ART(2),
    track_count: 20,
    updated_at: 1763850000,
    has_local: false,
    has_apple: true,
    has_soundcloud: false,
    has_archive: false,
  },
];

const SYNTH_LOCAL_DISCOVER = {
  recent_albums: SYNTH_ALBUMS,
  rediscover_albums: [...SYNTH_ALBUMS].reverse(),
  smart_stations: [
    {
      id: 'smart:synth',
      title: 'Synthwave & Electronic Mix',
      subtitle: 'Local lossless + dynamic transitions',
      art_url: ART(1),
      track_count: 24,
      tracks: SYNTH_TRACKS,
    },
    {
      id: 'smart:ambient',
      title: 'Late Night Ambient Drift',
      subtitle: 'Curated from your studio folders',
      art_url: ART(3),
      track_count: 19,
      tracks: SYNTH_TRACKS,
    },
    {
      id: 'smart:deep_cuts',
      title: 'Deep Folder Cuts',
      subtitle: 'Unplayed tracks across indexed mounts',
      art_url: ART(5),
      track_count: 32,
      tracks: SYNTH_TRACKS,
    },
    {
      id: 'smart:flac',
      title: '24-Bit Studio Masters',
      subtitle: 'Pure FLAC / ALAC rotation',
      art_url: ART(6),
      track_count: 15,
      tracks: SYNTH_TRACKS,
    },
    {
      id: 'smart:downtown',
      title: 'Downtempo Sessions',
      subtitle: 'Balanced 90–110 BPM groove',
      art_url: ART(4),
      track_count: 22,
      tracks: SYNTH_TRACKS,
    },
  ],
};

const SYNTH_LYRICS = {
  found: true,
  instrumental: false,
  source: 'local_lrc',
  track_name: 'Midnight Signal',
  artist_name: 'Neon Horizon',
  album_name: 'Glass Skyline',
  synced_lines: [
    { timestamp_ms: 12000, text: 'Streetlights flicker down the wet avenue' },
    { timestamp_ms: 28000, text: 'Static hums across the dial at 2 AM' },
    { timestamp_ms: 42000, text: 'Carrier wave locked in through the static haze' },
    { timestamp_ms: 49000, text: 'Silver towers mirror neon in the rain' },
    { timestamp_ms: 61000, text: 'Hold the frequency until the skyline wakes' },
    { timestamp_ms: 78000, text: 'Out beyond the overpass the tape winds clear' },
  ],
  plain_lyrics: 'Carrier wave locked in through the static haze\nSilver towers mirror neon in the rain',
};

const INITIAL_SNAPSHOT = {
  kind: 'state_snapshot',
  active_engine: 'local',
  is_playing: true,
  position_ms: 46500,
  volume: 0.78,
  shuffle: false,
  repeat_mode: 'queue',
  current_track: SYNTH_TRACKS[0],
  up_next: SYNTH_TRACKS.slice(1, 4),
  queue: SYNTH_TRACKS,
  queue_length: SYNTH_TRACKS.length,
  queue_index: 0,
  mounts: [
    {
      mount_root: '/Music',
      label: 'Studio Library',
      mount_kind: 'user_custom',
      is_online: true,
    },
  ],
  power: { on_battery: false, battery_pct: null },
  apple_authenticated: false,
  soundcloud_authenticated: false,
  internet_archive_authenticated: true,
  brightness_pct: 100,
  daemon_version: '1.1.1',
};

// -----------------------------------------------------------------------------
// Lightweight RFC 6455 WebSocket Frame Encoder / Decoder
// -----------------------------------------------------------------------------
function encodeWsText(obj) {
  const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function createWsDecoder(onText) {
  let acc = Buffer.alloc(0);
  return (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 2) {
      const b0 = acc[0];
      const b1 = acc[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (acc.length < 4) return;
        len = acc.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (acc.length < 10) return;
        len = Number(acc.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (acc.length < offset + maskLen + len) return;
      const payload = Buffer.from(acc.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) {
        const mask = acc.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }
      acc = acc.subarray(offset + maskLen + len);
      if (opcode === 0x8) return; // close
      if (opcode === 0x1) {
        onText(payload.toString('utf8'));
      }
    }
  };
}

function handleMockWsQuery(reqId, query, params) {
  switch (query) {
    case 'get_state_snapshot':
      return { ...INITIAL_SNAPSHOT, kind: 'query_response', req_id: reqId, ok: true, data: INITIAL_SNAPSHOT };
    case 'get_albums':
      return { kind: 'query_response', req_id: reqId, ok: true, data: SYNTH_ALBUMS, error: null };
    case 'get_playlists':
      return { kind: 'query_response', req_id: reqId, ok: true, data: SYNTH_PLAYLISTS, error: null };
    case 'get_tracks':
      return { kind: 'query_response', req_id: reqId, ok: true, data: SYNTH_TRACKS, error: null };
    case 'get_album_tracks':
    case 'get_playlist_items':
      return { kind: 'query_response', req_id: reqId, ok: true, data: SYNTH_TRACKS, error: null };
    case 'get_mount_roots':
      return { kind: 'query_response', req_id: reqId, ok: true, data: INITIAL_SNAPSHOT.mounts, error: null };
    case 'get_settings':
      return { kind: 'query_response', req_id: reqId, ok: true, data: {}, error: null };
    case 'get_apple_music_auth_config':
      return {
        kind: 'query_response',
        req_id: reqId,
        ok: true,
        data: {
          configured: false,
          apple_authenticated: false,
          has_private_key: false,
          pair_url: null,
        },
        error: null,
      };
    case 'get_soundcloud_auth_config':
      return {
        kind: 'query_response',
        req_id: reqId,
        ok: true,
        data: {
          configured: true,
          soundcloud_authenticated: false,
          auth_mode: 'client_credentials',
          username: 'Public Discovery (Client Credentials)',
        },
        error: null,
      };
    case 'get_internet_archive_config':
      return {
        kind: 'query_response',
        req_id: reqId,
        ok: true,
        data: { enabled: true, internet_archive_authenticated: true, username: '', safe_search: true },
        error: null,
      };
    default:
      return { kind: 'query_response', req_id: reqId, ok: true, data: [], error: null };
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

function startMockServer() {
  const wsSockets = new Set();
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${DAEMON_PORT}`);
    const pathname = reqUrl.pathname;

    if (pathname.startsWith('/mock-art/')) {
      const name = path.basename(pathname);
      const svg = SYNTH_ARTWORKS[name];
      if (svg) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        res.end(svg);
        return;
      }
    }

    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (pathname === '/api/v1/system/perf') {
        res.end(JSON.stringify({ cpu_percent: 1.4, rss_mb: 34.2, platform: 'Linux', audio_backend: 'PipeWire' }));
      } else if (pathname === '/api/settings/privacy') {
        res.end(JSON.stringify({
          ok: true,
          fetch_lyrics_online: true,
          fetch_artwork_online: true,
          fetch_factoids_online: true,
          fetch_disc_metadata_online: true,
          fetch_sc_comments_online: true,
          update_channel: 'alpha',
        }));
      } else if (pathname === '/api/history') {
        res.end(JSON.stringify({ ok: true, tracks: SYNTH_TRACKS }));
      } else if (pathname === '/api/favorites') {
        res.end(JSON.stringify({ ok: true, uris: [SYNTH_TRACKS[0].uri, SYNTH_TRACKS[2].uri], tracks: [SYNTH_TRACKS[0], SYNTH_TRACKS[2]] }));
      } else if (pathname === '/api/library/lyrics-status') {
        res.end(JSON.stringify({
          ok: true,
          synced_uris: SYNTH_TRACKS.map((t) => t.uri),
          all_lyrics_uris: SYNTH_TRACKS.map((t) => t.uri),
        }));
      } else if (pathname === '/api/library/local-discover') {
        res.end(JSON.stringify({ ok: true, data: SYNTH_LOCAL_DISCOVER }));
      } else if (pathname === '/api/fyp/shelves') {
        res.end(JSON.stringify({ ok: true, now_unix: Math.floor(Date.now() / 1000), shelves: [], snapshots: [] }));
      } else if (pathname === '/api/cache/shelves') {
        res.end(JSON.stringify({ ok: true, now_unix: Math.floor(Date.now() / 1000), shelves: [] }));
      } else if (pathname === '/api/lyrics') {
        res.end(JSON.stringify({ ok: true, data: SYNTH_LYRICS }));
      } else if (pathname === '/api/waveform') {
        const bars = Array.from({ length: 180 }, (_, i) => Math.round(28 + 56 * Math.abs(Math.sin(i * 0.21)) + 16 * Math.cos(i * 0.67)));
        res.end(JSON.stringify({ ok: true, bars }));
      } else if (pathname === '/api/update/check') {
        res.end(JSON.stringify({ ok: true, update_available: false, channel: 'stable', current_version: '1.1.1', latest_version: '1.1.1' }));
      } else if (pathname === '/api/factoids') {
        res.end(JSON.stringify({ ok: true, found: false, factoids: [], track_summary: null, artist_bio: null }));
      } else if (pathname === '/api/auth/probe') {
        res.end(JSON.stringify({ ok: true, apple: { status: 'never_used' }, soundcloud: { status: 'never_used' } }));
      } else {
        res.end(JSON.stringify({ ok: true, data: [] }));
      }
      return;
    }

    let filePath = path.join(UI_DIST_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(UI_DIST_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(UI_DIST_DIR, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );

    wsSockets.add(socket);
    socket.write(encodeWsText(INITIAL_SNAPSHOT));

    const decoder = createWsDecoder((rawText) => {
      try {
        const msg = JSON.parse(rawText);
        if (msg.kind === 'query') {
          const resp = handleMockWsQuery(msg.req_id, msg.query, msg.params);
          socket.write(encodeWsText(resp));
        }
      } catch {
        // Ignore malformed WS message
      }
    });
    socket.on('data', decoder);
    socket.on('close', () => wsSockets.delete(socket));
    socket.on('error', () => wsSockets.delete(socket));
  });

  let tick = 0;
  const specTimer = setInterval(() => {
    tick += 1;
    const bands = Array.from({ length: 16 }, (_, idx) => {
      const wave = 0.45 + 0.52 * Math.abs(Math.sin(tick * 0.24 + idx * 0.48));
      return Math.min(255, Math.max(18, Math.round(wave * (240 - idx * 7))));
    });
    const frame = encodeWsText({
      kind: 'event',
      event: 'audio_spectrum_tick',
      data: {
        rms: 0.44 + 0.18 * Math.sin(tick * 0.2),
        peak: 0.84,
        onset: tick % 8 === 0 ? 0.92 : 0.12,
        bands,
      },
    });
    for (const sock of wsSockets) {
      if (!sock.destroyed) sock.write(frame);
    }
  }, 55);

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearInterval(specTimer);
      reject(err);
    });
    server.listen(DAEMON_PORT, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise((r) => {
            clearInterval(specTimer);
            for (const s of wsSockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

// -----------------------------------------------------------------------------
// Chrome CDP Harness
// -----------------------------------------------------------------------------
function findChromeBin() {
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Google Chrome / Chromium binary not found');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function waitForCdpTarget() {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for Chrome CDP on port ${CDP_PORT}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(e));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(`Page eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res?.result?.value;
  }

  async screenshot(outFile) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outFile, Buffer.from(res.data, 'base64'));
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-docs-chrome-'));
  let mockServer = null;
  let chromeProc = null;
  let cdp = null;

  try {
    mockServer = await startMockServer();
    const chromeBin = findChromeBin();
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${CDP_PORT}`,
        '--window-size=1280,720',
        `http://127.0.0.1:${DAEMON_PORT}/?sanitized=1`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    const wsUrl = await waitForCdpTarget();
    cdp = new CdpClient(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Seed clean sanitized presentation preferences and reload
    await cdp.evalJs(`(() => {
      localStorage.setItem('simp_oobe_help_seen_v1', '1');
      localStorage.setItem('imp_stats_hud_enabled_v1', '1');
      localStorage.setItem('simp.visualizer_mode', 'rhythm_hologram');
      localStorage.setItem('simp_lyrics_karaoke_enabled', '1');
      localStorage.setItem('simp_lyrics_viz_enabled', '1');
      localStorage.setItem('imp_ui_scale_preset_v1', '100');
      localStorage.setItem('simp_source_visibility_v2', JSON.stringify({
        internet_archive: true,
        apple_music: false,
        soundcloud: false,
        optical_drive: false,
      }));
    })()`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2200);

    // Move mouse subtly so player HUD + Stats HUD pill remain clearly visible
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 640 });
    await sleep(600);

    // 1. Player + Visualizer + Synced Lyrics + Stats HUD
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'lyrics_viz.png'));
    console.log('✓ Captured docs/screenshots/lyrics_viz.png');

    // 2. Unified 3-Column XMB START Menu over Player
    await cdp.evalJs(`(() => {
      const btn = document.querySelector('button[title*="Settings Menu"]');
      if (btn) btn.click();
    })()`);
    await sleep(500);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'player_with_select_overlay.png'));
    console.log('✓ Captured docs/screenshots/player_with_select_overlay.png');

    // 3. System & Network -> Networked Retrieval Sub-Panel inside XMB Menu
    await cdp.evalJs(`(() => {
      const sysTab = document.querySelector('[data-xmb-tab="system_network"]');
      if (sysTab) sysTab.click();
    })()`);
    await sleep(250);
    await cdp.evalJs(`(() => {
      const row = document.querySelector('[data-xmb-sub-id="networked_retrieval"]');
      if (row) row.click();
    })()`);
    await sleep(450);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'settings_sources.png'));
    console.log('✓ Captured docs/screenshots/settings_sources.png');

    // 4. Close menu & switch to Library Browser (`Local` hub showing Studio Graphite 1-row shelves + See All ›)
    await cdp.evalJs(`(() => {
      const closeBtn = document.querySelector('[data-xmb-close="true"]');
      if (closeBtn) closeBtn.click();
    })()`);
    await sleep(250);
    await cdp.evalJs(`(() => {
      const libBtn = Array.from(document.querySelectorAll('header button')).find((b) =>
        b.textContent && b.textContent.trim().startsWith('Library')
      );
      if (libBtn) libBtn.click();
    })()`);
    await sleep(900);
    // Click into Local -> Albums to showcase Studio Graphite square-tile grid, left XMB rail & Mini-Player
    await cdp.evalJs(`(() => {
      const albumsBtn = Array.from(document.querySelectorAll('[data-nav-col="left"] button')).find((b) =>
        b.textContent && b.textContent.includes('Albums (')
      );
      if (albumsBtn) albumsBtn.click();
    })()`);
    await sleep(900);
    await cdp.screenshot(path.join(SCREENSHOTS_DIR, 'library_queue.png'));
    console.log('✓ Captured docs/screenshots/library_queue.png');
  } finally {
    if (cdp) cdp.close();
    if (chromeProc) {
      chromeProc.kill('SIGTERM');
      await sleep(200);
      if (!chromeProc.killed) chromeProc.kill('SIGKILL');
    }
    if (mockServer) await mockServer.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌ Screenshot capture failed:', err);
  process.exit(1);
});
