import type { SQLiteDatabase } from 'expo-sqlite';
import type { AppSettings, CardPreview, DeckSummary, SpotifySession } from '../types';

const DEFAULT_SETTINGS: AppSettings = {
  gameMode: 'previews',
  playbackSeconds: 30,
  startSecond: 0,
  startMode: 'fixed',
  flipPhoneEnabled: true,
  flipTrigger: 'gyroscope',
  country: 'Bolivia',
  language: 'Espanol',
  spotifyProduct: 'unknown',
};

export async function getSettings(db: SQLiteDatabase): Promise<AppSettings> {
  const rows = await db.getAllAsync<{ key: keyof AppSettings; value: string }>(
    'SELECT key, value FROM app_settings',
  );

  const settings = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    if (row.key === 'playbackSeconds' || row.key === 'startSecond') {
      settings[row.key] = Number(row.value);
    } else if (row.key === 'flipPhoneEnabled') {
      settings[row.key] = row.value === 'true';
    } else {
      settings[row.key] = row.value as never;
    }
  }

  return settings;
}

export async function saveSetting(db: SQLiteDatabase, key: keyof AppSettings, value: string | number | boolean) {
  await db.runAsync(
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
    key,
    String(value),
  );
}

export async function saveSpotifySession(db: SQLiteDatabase, session: SpotifySession) {
  const entries = [
    ['spotifyAccessToken', session.accessToken],
    ['spotifyRefreshToken', session.refreshToken ?? ''],
    ['spotifyExpiresAt', session.expiresAt ? String(session.expiresAt) : ''],
    ['spotifyProduct', session.product],
    ['spotifyUserId', session.userId ?? ''],
    ['spotifyDisplayName', session.displayName ?? ''],
    ['spotifyEmail', session.email ?? ''],
  ];

  for (const [key, value] of entries) {
    await db.runAsync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', key, value);
  }
}

export async function getSpotifySession(db: SQLiteDatabase): Promise<SpotifySession | null> {
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings
     WHERE key IN (
      'spotifyAccessToken', 'spotifyRefreshToken', 'spotifyExpiresAt',
      'spotifyProduct', 'spotifyUserId', 'spotifyDisplayName', 'spotifyEmail'
     )`,
  );

  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  if (!values.spotifyAccessToken) {
    return null;
  }

  return {
    accessToken: values.spotifyAccessToken,
    refreshToken: values.spotifyRefreshToken || undefined,
    expiresAt: values.spotifyExpiresAt ? Number(values.spotifyExpiresAt) : undefined,
    product: (values.spotifyProduct as SpotifySession['product']) || 'unknown',
    userId: values.spotifyUserId || undefined,
    displayName: values.spotifyDisplayName || undefined,
    email: values.spotifyEmail || undefined,
  };
}

export async function getDeckSummary(db: SQLiteDatabase): Promise<DeckSummary> {
  const decksRow = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM decks');
  const cardsRow = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM cards');

  return {
    decks: decksRow?.count ?? 0,
    cards: cardsRow?.count ?? 0,
  };
}

export async function getRecentCards(db: SQLiteDatabase): Promise<CardPreview[]> {
  const rows = await db.getAllAsync<{
    id: string;
    title: string;
    artist: string;
    year: number;
    qr_payload: string;
  }>('SELECT id, title, artist, year, qr_payload FROM cards ORDER BY created_at DESC LIMIT 5');

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    artist: row.artist,
    year: row.year,
    qrPayload: row.qr_payload,
  }));
}
