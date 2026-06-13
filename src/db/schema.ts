import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'hitster_personal.db';

const DATABASE_VERSION = 1;

export async function migrateDbIfNeeded(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let currentVersion = row?.user_version ?? 0;

  if (currentVersion >= DATABASE_VERSION) {
    return;
  }

  if (currentVersion === 0) {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decks (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY NOT NULL,
        deck_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        year INTEGER NOT NULL,
        source TEXT NOT NULL,
        spotify_track_id TEXT,
        youtube_video_id TEXT,
        preview_url TEXT,
        qr_payload TEXT NOT NULL UNIQUE,
        start_second INTEGER NOT NULL DEFAULT 0,
        duration_seconds INTEGER NOT NULL DEFAULT 30,
        random_start INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS official_card_links (
        pack_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        local_card_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pack_id, card_id),
        FOREIGN KEY (local_card_id) REFERENCES cards(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cards_deck_id ON cards(deck_id);
      CREATE INDEX IF NOT EXISTS idx_cards_qr_payload ON cards(qr_payload);
    `);

    await seedDefaults(db);
    currentVersion = 1;
  }

  await db.execAsync(`PRAGMA user_version = ${currentVersion}`);
}

async function seedDefaults(db: SQLiteDatabase) {
  const now = new Date().toISOString();

  await db.runAsync(
    'INSERT OR IGNORE INTO decks (id, name, source, created_at) VALUES (?, ?, ?, ?)',
    'demo-deck',
    'Mazo de prueba',
    'manual',
    now,
  );

  await db.runAsync(
    `INSERT OR IGNORE INTO cards (
      id, deck_id, title, artist, year, source, spotify_track_id, qr_payload,
      start_second, duration_seconds, random_start, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'demo-card-001',
    'demo-deck',
    'Tu primera carta',
    'Hitster Personal',
    2026,
    'spotify',
    null,
    'hitsterpersonal://card/demo-deck/demo-card-001',
    0,
    30,
    0,
    now,
  );

  const defaults = [
    ['gameMode', 'previews'],
    ['playbackSeconds', '30'],
    ['startSecond', '0'],
    ['startMode', 'fixed'],
    ['flipPhoneEnabled', 'true'],
    ['flipTrigger', 'gyroscope'],
    ['country', 'Bolivia'],
    ['language', 'Espanol'],
    ['spotifyProduct', 'unknown'],
  ];

  for (const [key, value] of defaults) {
    await db.runAsync('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', key, value);
  }
}
