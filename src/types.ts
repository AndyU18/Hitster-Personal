export type ScreenName =
  | 'home'
  | 'settings'
  | 'import'
  | 'playlists'
  | 'playlistDetail'
  | 'cardPdf'
  | 'scanner'
  | 'rotate'
  | 'player'
  | 'songMenu';

export type GameMode = 'full_tracks' | 'previews';

export type StartMode = 'fixed' | 'random';

export type FlipTrigger = 'gyroscope' | 'countdown';

export type AppSettings = {
  gameMode: GameMode;
  playbackSeconds: number;
  startSecond: number;
  startMode: StartMode;
  flipPhoneEnabled: boolean;
  flipTrigger: FlipTrigger;
  country: string;
  language: string;
  spotifyProduct: 'unknown' | 'free' | 'premium';
};

export type SpotifySession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  product: AppSettings['spotifyProduct'];
  userId?: string;
  displayName?: string;
  email?: string;
};

export type SpotifyPlaylist = {
  id: string;
  name: string;
  tracksTotal: number;
  ownerName?: string;
  ownerId?: string;
  collaborative?: boolean;
  canReadTracks?: boolean;
  imageUrl?: string;
  tracksHref?: string;
};

export type SpotifyTrack = {
  id: string;
  title: string;
  artist: string;
  year: number;
  albumName?: string;
  imageUrl?: string;
  previewUrl?: string;
  spotifyUri?: string;
};

export type TrackViewMode = 'list' | 'grid';

export type SpotifyAuthState = {
  isConfigured: boolean;
  isLoading: boolean;
  statusMessage: string;
  displayName?: string;
  product: AppSettings['spotifyProduct'];
  login: () => void | Promise<void>;
};

export type DeckSummary = {
  decks: number;
  cards: number;
};

export type CardPreview = {
  id: string;
  title: string;
  artist: string;
  year: number;
  qrPayload: string;
};
