import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera';
import { Accelerometer } from 'expo-sensors';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  CirclePlus,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Globe,
  HelpCircle,
  ListMusic,
  Music2,
  Pause,
  Play,
  QrCode,
  ScanLine,
  Settings,
  Share2,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react-native';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { DATABASE_NAME, migrateDbIfNeeded } from './src/db/schema';
import {
  getDeckSummary,
  getRecentCards,
  getSettings,
  getSpotifySession,
  saveSetting,
  saveSpotifySession,
} from './src/db/repository';
import type {
  AppSettings,
  CardPreview,
  DeckSummary,
  FlipTrigger,
  GameMode,
  ScreenName,
  StartMode,
  SpotifyAuthState,
  SpotifyPlaylist,
  SpotifySession,
  SpotifyTrack,
  TrackViewMode,
} from './src/types';

const isSpotifyRedirectPage =
  typeof window !== 'undefined' && window.location.pathname === '/redirect';
const canUseBrowserStorage =
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
const isWebRuntime = typeof window !== 'undefined';

if (isSpotifyRedirectPage) {
  WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
} else {
  WebBrowser.maybeCompleteAuthSession();
}

const SPOTIFY_CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? '';
const SPOTIFY_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};
const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'playlist-read-private',
  'playlist-read-collaborative',
];
const SPOTIFY_AUTH_REQUEST_KEY = 'hitster.spotify.authRequest';
const SPOTIFY_AUTH_CALLBACK_KEY = 'hitster.spotify.authCallback';

const demoPlaylists = [
  { id: 'rock', name: 'Rock de fiesta', songs: 42, source: 'Spotify' },
  { id: 'latinos', name: 'Clasicos latinos', songs: 36, source: 'Spotify' },
  { id: 'ochentas', name: '80s y 90s', songs: 58, source: 'YouTube' },
];

const demoSongs = [
  { title: 'Faith', artist: 'George Michael', year: 1987 },
  { title: 'La camisa negra', artist: 'Juanes', year: 2004 },
  { title: 'Billie Jean', artist: 'Michael Jackson', year: 1982 },
  { title: 'Rayando el sol', artist: 'Mana', year: 1990 },
];

type SpotifyProfileResponse = {
  id?: string;
  display_name?: string;
  email?: string;
  product?: string;
};

async function fetchSpotifyProfile(accessToken: string): Promise<SpotifyProfileResponse> {
  const response = await fetch('https://api.spotify.com/v1/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify /me fallo con estado ${response.status}`);
  }

  return response.json();
}

function normalizeSpotifyProduct(product?: string): AppSettings['spotifyProduct'] {
  return product === 'premium' ? 'premium' : product === 'free' ? 'free' : 'unknown';
}

type ParsedCard = {
  title: string;
  artist: string;
  year: number;
  spotifyUri?: string;
  previewUrl?: string;
  youtubeId?: string;
  isOfficial?: boolean;
  packId?: string;
  cardId?: string;
};

function parseQrPayload(payload: string | null): ParsedCard | null {
  if (!payload) return null;

  try {
    if (payload.startsWith('hitsterpersonal://card?')) {
      const url = new URL(payload.replace('hitsterpersonal://', 'https://'));
      const title = url.searchParams.get('title') || 'Canción Desconocida';
      const artist = url.searchParams.get('artist') || 'Artista Desconocido';
      const year = Number(url.searchParams.get('year')) || 0;
      const spotifyUri = url.searchParams.get('spotifyUri') || undefined;
      const previewUrl = url.searchParams.get('previewUrl') || undefined;
      const youtubeId = url.searchParams.get('youtubeId') || undefined;

      return {
        title,
        artist,
        year,
        spotifyUri,
        previewUrl,
        youtubeId,
        isOfficial: false,
      };
    }

    if (payload.includes('hitstergame.com/')) {
      const cleanPath = payload.replace(/(https?:\/\/)?(www\.)?hitstergame\.com\//, '');
      const parts = cleanPath.split('/');
      let packId = '';
      let cardId = '';
      if (parts.length >= 3) {
        packId = parts[1];
        cardId = parts[2];
      } else if (parts.length >= 2) {
        packId = parts[0];
        cardId = parts[1];
      }

      if (packId && cardId) {
        return {
          title: 'Carta Oficial',
          artist: 'Hitster',
          year: 0,
          isOfficial: true,
          packId,
          cardId,
        };
      }
    }
  } catch (err) {
    console.error('Error parsing QR payload:', err);
  }

  if (payload === 'hitsterpersonal://card/demo-deck/demo-card-001') {
    return {
      title: 'Tu primera carta',
      artist: 'Hitster Personal',
      year: 2026,
      isOfficial: false,
    };
  }

  return null;
}

export default function App() {
  if (isSpotifyRedirectPage) {
    return <AuthCallbackScreen />;
  }

  return (
    <Suspense fallback={<LoadingScreen />}>
      <SQLiteProvider databaseName={DATABASE_NAME} onInit={migrateDbIfNeeded} useSuspense>
        <HitsterApp />
      </SQLiteProvider>
    </Suspense>
  );
}

function AuthCallbackScreen() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payload = {
      code: params.get('code'),
      state: params.get('state'),
      error: params.get('error'),
      href: window.location.href,
      createdAt: Date.now(),
    };

    window.localStorage.setItem(SPOTIFY_AUTH_CALLBACK_KEY, JSON.stringify(payload));

    const timer = window.setTimeout(() => {
      window.close();
    }, 600);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <View style={styles.authCallback}>
      <ActivityIndicator color="#1ed760" />
      <Text style={styles.authCallbackText}>Completando login de Spotify...</Text>
    </View>
  );
}

function HitsterApp() {
  const db = useSQLiteContext();
  const [screen, setScreen] = useState<ScreenName>('home');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [summary, setSummary] = useState<DeckSummary>({ decks: 0, cards: 0 });
  const [cards, setCards] = useState<CardPreview[]>([]);
  const [lastQrPayload, setLastQrPayload] = useState<string | null>(null);
  const [spotifySession, setSpotifySession] = useState<SpotifySession | null>(null);
  const [spotifyStatus, setSpotifyStatus] = useState('Spotify no conectado');
  const [spotifyLoading, setSpotifyLoading] = useState(false);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [spotifyPlaylistsStatus, setSpotifyPlaylistsStatus] = useState('Conecta Spotify para ver tus playlists.');
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [selectedPlaylistTracks, setSelectedPlaylistTracks] = useState<SpotifyTrack[]>([]);
  const [selectedPlaylistStatus, setSelectedPlaylistStatus] = useState('Selecciona una playlist.');
  const spotifyExchangeInProgressRef = useRef(false);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'hitsterpersonal', path: 'redirect' });

  const [spotifyRequest, spotifyResponse, promptSpotifyAsync] = AuthSession.useAuthRequest(
    {
      clientId: SPOTIFY_CLIENT_ID || 'missing-client-id',
      scopes: SPOTIFY_SCOPES,
      redirectUri,
      usePKCE: true,
    },
    SPOTIFY_DISCOVERY,
  );

  const refresh = useCallback(async () => {
    const [nextSettings, nextSummary, nextCards] = await Promise.all([
      getSettings(db),
      getDeckSummary(db),
      getRecentCards(db),
    ]);
    setSettings(nextSettings);
    setSummary(nextSummary);
    setCards(nextCards);
    setSpotifySession(await getSpotifySession(db));
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateSetting = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((current) => (current ? { ...current, [key]: value } : current));
      await saveSetting(db, key, value);
    },
    [db],
  );

  const handleSpotifyLogout = useCallback(async () => {
    try {
      const keys = [
        'spotifyAccessToken',
        'spotifyRefreshToken',
        'spotifyExpiresAt',
        'spotifyProduct',
        'spotifyUserId',
        'spotifyDisplayName',
        'spotifyEmail',
      ];
      for (const key of keys) {
        await db.runAsync('DELETE FROM app_settings WHERE key = ?', key);
      }
      await saveSetting(db, 'spotifyProduct', 'unknown');
      setSpotifySession(null);
      setSettings((current) => (current ? { ...current, spotifyProduct: 'unknown' } : current));
      setSpotifyStatus('Spotify no conectado');
    } catch (err) {
      console.error('Error logging out of Spotify:', err);
    }
  }, [db]);

  const getOrRefreshSpotifySession = useCallback(async (): Promise<SpotifySession | null> => {
    if (!spotifySession) return null;

    // Check if token is expired or expires soon (within 2 minutes)
    const isExpired = spotifySession.expiresAt ? Date.now() > (spotifySession.expiresAt - 120000) : false;
    if (!isExpired) {
      return spotifySession;
    }

    if (!spotifySession.refreshToken) {
      console.log('Token expired and no refresh token available. Logging out...');
      await handleSpotifyLogout();
      return null;
    }

    try {
      setSpotifyLoading(true);
      setSpotifyStatus('Renovando sesion de Spotify...');

      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: spotifySession.refreshToken,
          client_id: SPOTIFY_CLIENT_ID,
        }).toString(),
      });

      if (!response.ok) {
        throw new Error(`Error en refresh_token: ${response.status}`);
      }

      const data = await response.json();
      const nextAccessToken = data.access_token;
      const nextRefreshToken = data.refresh_token || spotifySession.refreshToken;
      const nextExpiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : undefined;

      const profile = await fetchSpotifyProfile(nextAccessToken);
      const product = normalizeSpotifyProduct(profile.product);

      const nextSession: SpotifySession = {
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
        expiresAt: nextExpiresAt,
        product,
        userId: profile.id,
        displayName: profile.display_name,
        email: profile.email,
      };

      await saveSpotifySession(db, nextSession);
      await saveSetting(db, 'spotifyProduct', product);
      setSpotifySession(nextSession);
      setSettings((current) => (current ? { ...current, spotifyProduct: product } : current));
      setSpotifyStatus(product === 'premium' ? 'Spotify Premium conectado' : 'Spotify Free conectado');
      return nextSession;
    } catch (error) {
      console.warn('Failed to refresh Spotify token:', error);
      await handleSpotifyLogout();
      return null;
    } finally {
      setSpotifyLoading(false);
    }
  }, [db, spotifySession, handleSpotifyLogout]);

  const completeSpotifyLogin = useCallback(
    async (code: string, codeVerifier: string) => {
      setSpotifyLoading(true);
      setSpotifyStatus('Terminando login de Spotify...');

      try {
        const token = await AuthSession.exchangeCodeAsync(
          {
            clientId: SPOTIFY_CLIENT_ID,
            code,
            redirectUri,
            extraParams: {
              code_verifier: codeVerifier,
            },
          },
          SPOTIFY_DISCOVERY,
        );
        const profile = await fetchSpotifyProfile(token.accessToken);
        const product = normalizeSpotifyProduct(profile.product);
        const session: SpotifySession = {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1000 : undefined,
          product,
          userId: profile.id,
          displayName: profile.display_name,
          email: profile.email,
        };

        await saveSpotifySession(db, session);
        await saveSetting(db, 'spotifyProduct', product);
        setSpotifySession(session);
        setSettings((current) => (current ? { ...current, spotifyProduct: product } : current));
        setSpotifyStatus(product === 'premium' ? 'Spotify Premium conectado' : 'Spotify Free conectado');
        if (canUseBrowserStorage) {
          window.localStorage.removeItem(SPOTIFY_AUTH_CALLBACK_KEY);
          window.localStorage.removeItem(SPOTIFY_AUTH_REQUEST_KEY);
        }
      } catch (error) {
        setSpotifyStatus(error instanceof Error ? error.message : 'No se pudo completar Spotify OAuth');
      } finally {
        setSpotifyLoading(false);
      }
    },
    [db, redirectUri],
  );

  useEffect(() => {
    if (!spotifySession) {
      return;
    }

    setSpotifyStatus(
      spotifySession.displayName
        ? `Conectado como ${spotifySession.displayName}`
        : 'Spotify conectado',
    );
  }, [spotifySession]);

  const loadSpotifyPlaylists = useCallback(async () => {
    const session = await getOrRefreshSpotifySession();
    if (!session) {
      setSpotifyPlaylistsStatus('Conecta Spotify para cargar tus playlists reales.');
      return;
    }

    setSpotifyPlaylistsStatus('Cargando playlists de Spotify...');

    try {
      const playlists = await fetchSpotifyPlaylists(session.accessToken);
      setSpotifyPlaylists(playlists);
      setSpotifyPlaylistsStatus(
        playlists.length > 0
          ? `${playlists.length} playlists cargadas desde Spotify. Solo se pueden leer canciones de playlists tuyas o colaborativas.`
          : 'Tu cuenta no devolvio playlists.',
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'No se pudieron cargar playlists.';
      setSpotifyPlaylistsStatus(msg);
      if (msg.includes('401')) {
        await handleSpotifyLogout();
      }
    }
  }, [getOrRefreshSpotifySession, handleSpotifyLogout]);

  const openPlaylist = useCallback((playlist: SpotifyPlaylist) => {
    setSelectedPlaylist(playlist);
    setSelectedPlaylistTracks([]);
    setSelectedPlaylistStatus(`Cargando canciones de ${playlist.name}...`);
    setScreen('playlistDetail');
  }, []);

  const loadSelectedPlaylistTracks = useCallback(async () => {
    const session = await getOrRefreshSpotifySession();
    if (!session || !selectedPlaylist) {
      setSelectedPlaylistStatus('No hay playlist seleccionada o Spotify no esta conectado.');
      return;
    }

    setSelectedPlaylistStatus(`Cargando canciones de ${selectedPlaylist.name}...`);

    try {
      const tracks = await fetchSpotifyPlaylistTracks(session.accessToken, selectedPlaylist.id);
      setSelectedPlaylistTracks(tracks);
      setSelectedPlaylistStatus(`${tracks.length} canciones cargadas`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'No se pudieron cargar canciones.';
      setSelectedPlaylistStatus(msg);
      if (msg.includes('401')) {
        await handleSpotifyLogout();
      }
    }
  }, [selectedPlaylist, getOrRefreshSpotifySession, handleSpotifyLogout]);

  useEffect(() => {
    async function finishSpotifyLogin() {
      if (isWebRuntime) {
        return;
      }

      if (spotifyResponse?.type !== 'success' || !spotifyRequest?.codeVerifier) {
        return;
      }

      await completeSpotifyLogin(spotifyResponse.params.code, spotifyRequest.codeVerifier);
    }

    finishSpotifyLogin();
  }, [completeSpotifyLogin, spotifyRequest?.codeVerifier, spotifyResponse]);

  useEffect(() => {
    if (!spotifyRequest) {
      return;
    }

    const readCallback = async () => {
      if (!canUseBrowserStorage) {
        return;
      }

      if (spotifyExchangeInProgressRef.current) {
        return;
      }

      const rawCallback = window.localStorage.getItem(SPOTIFY_AUTH_CALLBACK_KEY);
      const rawRequest = window.localStorage.getItem(SPOTIFY_AUTH_REQUEST_KEY);

      if (!rawCallback || !rawRequest) {
        return;
      }

      const callback = JSON.parse(rawCallback) as {
        code?: string | null;
        state?: string | null;
        error?: string | null;
      };
      const savedRequest = JSON.parse(rawRequest) as {
        state?: string;
        codeVerifier?: string;
      };

      if (callback.error) {
        setSpotifyStatus(`Spotify devolvio error: ${callback.error}`);
        window.localStorage.removeItem(SPOTIFY_AUTH_CALLBACK_KEY);
        return;
      }

      if (!callback.code || !callback.state || !savedRequest.codeVerifier) {
        if (callback.code && !savedRequest.codeVerifier) {
          setSpotifyStatus('No se encontro el verificador PKCE. Presiona Conectar Spotify otra vez.');
          window.localStorage.removeItem(SPOTIFY_AUTH_CALLBACK_KEY);
        }
        return;
      }

      if (savedRequest.state && callback.state !== savedRequest.state) {
        setSpotifyStatus('Spotify devolvio un state distinto. Intenta conectar de nuevo.');
        window.localStorage.removeItem(SPOTIFY_AUTH_CALLBACK_KEY);
        return;
      }

      spotifyExchangeInProgressRef.current = true;
      window.localStorage.removeItem(SPOTIFY_AUTH_CALLBACK_KEY);

      try {
        await completeSpotifyLogin(callback.code, savedRequest.codeVerifier);
      } finally {
        spotifyExchangeInProgressRef.current = false;
      }
    };

    const interval = window.setInterval(() => {
      readCallback();
    }, 500);

    window.addEventListener('storage', readCallback);
    readCallback();

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('storage', readCallback);
    };
  }, [completeSpotifyLogin, spotifyRequest]);

  const spotifyAuth = useMemo<SpotifyAuthState>(
    () => ({
      isConfigured: Boolean(SPOTIFY_CLIENT_ID),
      isLoading: spotifyLoading,
      statusMessage: spotifyStatus,
      displayName: spotifySession?.displayName,
      product: spotifySession?.product ?? 'unknown',
      login: async () => {
        if (!SPOTIFY_CLIENT_ID) {
          setSpotifyStatus('Falta EXPO_PUBLIC_SPOTIFY_CLIENT_ID en el entorno');
          return;
        }

        if (!spotifyRequest) {
          setSpotifyStatus('Preparando OAuth de Spotify...');
          return;
        }

        await spotifyRequest.makeAuthUrlAsync(SPOTIFY_DISCOVERY);
        if (!spotifyRequest.codeVerifier) {
          setSpotifyStatus('No se pudo preparar PKCE. Intenta de nuevo.');
          return;
        }

        if (canUseBrowserStorage) {
          window.localStorage.setItem(
            SPOTIFY_AUTH_REQUEST_KEY,
            JSON.stringify({
              state: spotifyRequest.state,
              codeVerifier: spotifyRequest.codeVerifier,
              createdAt: Date.now(),
            }),
          );
          window.localStorage.removeItem(SPOTIFY_AUTH_CALLBACK_KEY);
        }
        setSpotifyStatus('Abriendo Spotify...');
        promptSpotifyAsync();
      },
    }),
    [promptSpotifyAsync, settings?.spotifyProduct, spotifyLoading, spotifyRequest, spotifySession, spotifyStatus],
  );

  const title = useMemo(() => {
    const titles: Record<ScreenName, string> = {
      home: 'Hitster Personal',
      settings: 'Normas y configuracion',
      import: 'Importar canciones',
      playlists: 'Playlists',
      playlistDetail: 'Canciones',
      cardPdf: 'Cartas y PDF',
      scanner: 'Escanear carta',
      rotate: 'Gira el telefono',
      player: 'Reproduciendo',
      songMenu: 'Opciones',
    };
    return titles[screen];
  }, [screen]);

  if (!settings) {
    return <LoadingScreen />;
  }

  const goHome = () => setScreen('home');

  return (
    <LinearGradient colors={['#120717', '#23112a', '#08050d']} style={styles.appShell}>
      <StatusBar style="light" />
      <View style={styles.phoneViewport}>
        {screen !== 'home' && screen !== 'scanner' && (
        <Header
          title={title}
          onBack={
            screen === 'playlistDetail'
              ? () => setScreen('playlists')
              : screen === 'cardPdf'
                ? () => setScreen('playlistDetail')
                : screen === 'playlists'
                  ? () => setScreen('import')
                  : screen === 'rotate' || screen === 'player' || screen === 'songMenu'
                    ? goHome
                    : () => setScreen('home')
          }
        />
        )}

        {screen === 'home' && (
          <HomeScreen summary={summary} settings={settings} onNavigate={setScreen} />
        )}
        {screen === 'settings' && (
          <SettingsScreen settings={settings} spotifyAuth={spotifyAuth} onUpdate={updateSetting} />
        )}
        {screen === 'import' && (
          <ImportScreen onNavigate={setScreen} summary={summary} spotifyAuth={spotifyAuth} />
        )}
      {screen === 'playlists' && (
        <PlaylistsScreen
          onNavigate={setScreen}
          playlists={spotifyPlaylists}
          status={spotifyPlaylistsStatus}
          onRefresh={loadSpotifyPlaylists}
          onOpenPlaylist={openPlaylist}
        />
      )}
      {screen === 'playlistDetail' && (
        <PlaylistDetailScreen
          playlist={selectedPlaylist}
          tracks={selectedPlaylistTracks}
          status={selectedPlaylistStatus}
          onRefresh={loadSelectedPlaylistTracks}
          onNavigate={setScreen}
        />
      )}
      {screen === 'cardPdf' && (
        <CardPdfScreen
          cards={cards}
          playlist={selectedPlaylist}
          tracks={selectedPlaylistTracks}
          onNavigate={setScreen}
        />
      )}
        {screen === 'scanner' && (
          <ScannerScreen
            settings={settings}
            onClose={goHome}
            onScanned={(payload) => {
              setLastQrPayload(payload);
              setScreen('rotate');
            }}
          />
        )}
        {screen === 'rotate' && (
          <RotateScreen settings={settings} qrPayload={lastQrPayload} onReady={() => setScreen('player')} />
        )}
        {screen === 'player' && (
          <PlayerScreen
            settings={settings}
            qrPayload={lastQrPayload}
            onMenu={() => setScreen('songMenu')}
            onNext={() => setScreen('scanner')}
          />
        )}
        {screen === 'songMenu' && (
          <SongMenuScreen onClose={() => setScreen('player')} onNext={() => setScreen('scanner')} />
        )}
      </View>
    </LinearGradient>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <IconButton onPress={onBack}>
        <ArrowLeft color="#fff" size={28} />
      </IconButton>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function HomeScreen({
  summary,
  settings,
  onNavigate,
}: {
  summary: DeckSummary;
  settings: AppSettings;
  onNavigate: (screen: ScreenName) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.homeContent}>
      <View style={styles.logoBlock}>
        <Text style={styles.logo}>HITSTER</Text>
        <View style={styles.neonFrame}>
          <Text style={styles.logoSubline}>EL JUEGO DE LOS</Text>
          <Text style={styles.logoSubline}>GRANDES EXITOS</Text>
        </View>
      </View>

      <Speaker />

      <View style={styles.statsRow}>
        <Stat label="Mazos" value={summary.decks} />
        <Stat label="Cartas" value={summary.cards} />
        <Stat label="Audio" value={`${settings.playbackSeconds}s`} />
      </View>

      <View style={styles.buttonStack}>
        <PrimaryButton label="Jugar ahora" icon={<Play color="#fff" size={24} />} onPress={() => onNavigate('scanner')} />
        <SecondaryButton label="Importar canciones" icon={<Download color="#fff" size={22} />} onPress={() => onNavigate('import')} />
        <SecondaryButton label="Normas y configuracion" icon={<Settings color="#fff" size={22} />} onPress={() => onNavigate('settings')} />
      </View>
    </ScrollView>
  );
}

function SettingsScreen({
  settings,
  spotifyAuth,
  onUpdate,
}: {
  settings: AppSettings;
  spotifyAuth: SpotifyAuthState;
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenHero}>NORMAS Y{'\n'}CONFIGURACION</Text>

      <Panel>
        <LinkRow label="Como jugar" icon={<HelpCircle color="#fff" size={24} />} />
        <LinkRow label="Preguntas frecuentes" icon={<HelpCircle color="#fff" size={24} />} />
        <LinkRow label="Novedades" icon={<Sparkles color="#fff" size={24} />} />
      </Panel>

      <SectionLabel>Hitster en redes sociales</SectionLabel>
      <View style={styles.socialRow}>
        <SocialButton icon={<Text style={styles.socialText}>IG</Text>} />
        <SocialButton icon={<Music2 color="#00d7ff" size={36} />} accent="#ff2aa3" />
        <SocialButton icon={<Text style={styles.socialText}>FB</Text>} />
      </View>

      <SectionLabel>Configuracion de Spotify</SectionLabel>
      <Panel>
        <Pressable style={styles.spotifyRow} onPress={spotifyAuth.login}>
          <Text style={styles.spotifyText}>Spotify</Text>
          <Text style={styles.spotifyPlan}>
            {spotifyAuth.isLoading ? '...' : spotifyAuth.product === 'unknown' ? 'Login' : spotifyAuth.product}
          </Text>
        </Pressable>
        <Text style={styles.spotifyStatus}>{spotifyAuth.statusMessage}</Text>
      </Panel>

      <SectionLabel>Modo de juego</SectionLabel>
      <Panel>
        <ChoiceRow
          title="Canciones completas"
          description="Reproduce canciones completas desde el inicio. Requiere Spotify Premium."
          selected={settings.gameMode === 'full_tracks'}
          onPress={() => onUpdate('gameMode', 'full_tracks' satisfies GameMode)}
        />
        <ChoiceRow
          title={`Vistas previas de ${settings.playbackSeconds}s`}
          description="Reproduce vistas previas de las canciones cuando esten disponibles."
          selected={settings.gameMode === 'previews'}
          onPress={() => onUpdate('gameMode', 'previews' satisfies GameMode)}
        />
      </Panel>

      <SectionLabel>Girar el telefono</SectionLabel>
      <Panel>
        <View style={styles.switchRow}>
          <View style={styles.switchCopy}>
            <Text style={styles.rowTitle}>Usar "Girar el telefono"</Text>
            <Text style={styles.rowDescription}>Tras escanear una carta, pon tu dispositivo boca abajo.</Text>
          </View>
          <Switch
            value={settings.flipPhoneEnabled}
            onValueChange={(value) => onUpdate('flipPhoneEnabled', value)}
            trackColor={{ false: '#44324d', true: '#08aeea' }}
            thumbColor="#fff"
          />
        </View>
        <ChoiceRow
          title="Usar el giroscopio"
          description="La cancion empieza a sonar cuando giras el telefono boca abajo."
          selected={settings.flipTrigger === 'gyroscope'}
          onPress={() => onUpdate('flipTrigger', 'gyroscope' satisfies FlipTrigger)}
        />
        <ChoiceRow
          title="Usar cuenta atras"
          description="La cancion empieza a sonar tras una breve cuenta atras."
          selected={settings.flipTrigger === 'countdown'}
          onPress={() => onUpdate('flipTrigger', 'countdown' satisfies FlipTrigger)}
        />
      </Panel>

      <SectionLabel>Tiempo de reproduccion</SectionLabel>
      <Panel>
        <View style={styles.pillRow}>
          {[15, 30, 45, 60].map((seconds) => (
            <Pill
              key={seconds}
              label={`${seconds}s`}
              selected={settings.playbackSeconds === seconds}
              onPress={() => onUpdate('playbackSeconds', seconds)}
            />
          ))}
        </View>
        <ChoiceRow
          title="Desde segundo fijo"
          description={`Empieza desde el segundo ${settings.startSecond}.`}
          selected={settings.startMode === 'fixed'}
          onPress={() => onUpdate('startMode', 'fixed' satisfies StartMode)}
        />
        <ChoiceRow
          title="Inicio aleatorio"
          description="La app escogera un punto distinto cada vez."
          selected={settings.startMode === 'random'}
          onPress={() => onUpdate('startMode', 'random' satisfies StartMode)}
        />
      </Panel>

      <SectionLabel>Configuracion de la app</SectionLabel>
      <Panel>
        <SettingValue label="Cambiar pais" value={settings.country} />
        <SettingValue label="Cambiar idioma" value={settings.language} />
      </Panel>

      <SectionLabel>Privacidad y avisos legales</SectionLabel>
      <Panel>
        <LinkRow label="Politica de privacidad" icon={<Globe color="#fff" size={24} />} />
      </Panel>
    </ScrollView>
  );
}

function ImportScreen({
  onNavigate,
  summary,
  spotifyAuth,
}: {
  onNavigate: (screen: ScreenName) => void;
  summary: DeckSummary;
  spotifyAuth: SpotifyAuthState;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenHero}>IMPORTAR{'\n'}CANCIONES</Text>
      <Panel padded>
        <Text style={styles.rowTitle}>Biblioteca local</Text>
        <Text style={styles.rowDescription}>
          Todo vive en SQLite dentro del telefono. No necesitas nube para jugar ni para consultar tus cartas.
        </Text>
        <View style={styles.statsRowCompact}>
          <Stat label="Mazos" value={summary.decks} />
          <Stat label="Cartas" value={summary.cards} />
        </View>
      </Panel>
      <Panel padded>
        <Text style={styles.rowTitle}>Spotify</Text>
        <Text style={styles.rowDescription}>{spotifyAuth.statusMessage}</Text>
        {!spotifyAuth.isConfigured && (
          <Text style={styles.warningText}>Define EXPO_PUBLIC_SPOTIFY_CLIENT_ID para activar el login real.</Text>
        )}
      </Panel>
      <PrimaryButton
        label={spotifyAuth.product === 'unknown' ? 'Conectar Spotify' : 'Ver playlists'}
        icon={<Music2 color="#fff" size={24} />}
        onPress={spotifyAuth.product === 'unknown' ? spotifyAuth.login : () => onNavigate('playlists')}
      />
      <SecondaryButton label="Ver playlists demo" icon={<ListMusic color="#fff" size={22} />} onPress={() => onNavigate('playlists')} />
      <SecondaryButton label="Generar cartas" icon={<QrCode color="#fff" size={22} />} onPress={() => onNavigate('cardPdf')} />
    </ScrollView>
  );
}

function PlaylistsScreen({
  onNavigate,
  playlists,
  status,
  onRefresh,
  onOpenPlaylist,
}: {
  onNavigate: (screen: ScreenName) => void;
  playlists: SpotifyPlaylist[];
  status: string;
  onRefresh: () => void;
  onOpenPlaylist: (playlist: SpotifyPlaylist) => void;
}) {
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const visiblePlaylists: Array<{
    id: string;
    name: string;
    songs: number;
    source: string;
    imageUrl?: string;
    playlist: SpotifyPlaylist | null;
  }> =
    playlists.length > 0
      ? playlists.map((playlist) => ({
          id: playlist.id,
          name: playlist.name,
          songs: playlist.tracksTotal,
          source: `${playlist.canReadTracks ? 'Legible' : 'Solo listado'} · ${
            playlist.ownerName ? `Spotify · ${playlist.ownerName}` : 'Spotify'
          }`,
          imageUrl: playlist.imageUrl,
          playlist,
        }))
      : demoPlaylists.map((playlist) => ({
          ...playlist,
          playlist: null,
        }));

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenHero}>TUS{'\n'}PLAYLISTS</Text>
      <Panel padded>
        <Text style={styles.rowTitle}>Spotify</Text>
        <Text style={styles.rowDescription}>{status}</Text>
      </Panel>
      <SecondaryButton label="Actualizar playlists" icon={<ListMusic color="#fff" size={22} />} onPress={onRefresh} />
      {visiblePlaylists.map((playlist, index) => (
        <Pressable
          key={`${playlist.id}-${index}`}
          style={[styles.playlistCard, playlist.playlist && !playlist.playlist.canReadTracks && styles.playlistCardDisabled]}
          onPress={() => {
            if (playlist.playlist?.canReadTracks || !playlist.playlist) {
              playlist.playlist ? onOpenPlaylist(playlist.playlist) : onNavigate('playlistDetail');
            }
          }}
        >
          {playlist.imageUrl ? (
            <Image source={{ uri: playlist.imageUrl }} style={styles.playlistImage} />
          ) : (
            <View style={styles.playlistIcon}>
              <ListMusic color="#55d8ff" size={28} />
            </View>
          )}
          <View style={styles.playlistCopy}>
            <Text style={styles.rowTitle}>{playlist.name}</Text>
            <Text style={styles.rowDescription}>{playlist.songs} canciones · {playlist.source}</Text>
          </View>
          <ArrowRight color="#fff" size={24} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function PlaylistDetailScreen({
  playlist,
  tracks,
  status,
  onRefresh,
  onNavigate,
}: {
  playlist: SpotifyPlaylist | null;
  tracks: SpotifyTrack[];
  status: string;
  onRefresh: () => void;
  onNavigate: (screen: ScreenName) => void;
}) {
  const pageSize = 24;
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<TrackViewMode>('list');

  useEffect(() => {
    if (playlist) {
      setPage(1);
      onRefresh();
    }
  }, [onRefresh, playlist]);

  const visibleTracks: Array<SpotifyTrack> =
    playlist && tracks.length > 0
      ? tracks
      : playlist
        ? []
      : demoSongs.map((song, index) => ({
          id: `demo-${index}`,
          title: song.title,
          artist: song.artist,
          year: song.year,
        }));
  const totalPages = Math.max(1, Math.ceil(visibleTracks.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageTracks = visibleTracks.slice(pageStart, pageStart + pageSize);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenHero}>REVISAR{'\n'}CANCIONES</Text>
      <Panel padded>
        <Text style={styles.rowTitle}>{playlist?.name ?? 'Playlist demo'}</Text>
        <Text style={styles.rowDescription}>{status}</Text>
        <Text style={styles.rowDescription}>Corrige artista, titulo y año antes de imprimir.</Text>
      </Panel>
      <View style={styles.stickyActions}>
        <PrimaryButton label="Preparar impresion" icon={<FileText color="#fff" size={24} />} onPress={() => onNavigate('cardPdf')} />
        <SecondaryButton label="Actualizar canciones" icon={<ListMusic color="#fff" size={22} />} onPress={onRefresh} />
      </View>
      <Panel padded>
        <View style={styles.trackToolbar}>
          <Text style={styles.toolbarText}>
            {visibleTracks.length} canciones · pagina {safePage}/{totalPages}
          </Text>
          <View style={styles.viewToggle}>
            <Pill label="Lista" selected={viewMode === 'list'} onPress={() => setViewMode('list')} />
            <Pill label="Cuadros" selected={viewMode === 'grid'} onPress={() => setViewMode('grid')} />
          </View>
        </View>
        <View style={styles.paginationRow}>
          <Pressable
            style={[styles.pageButton, safePage === 1 && styles.pageButtonDisabled]}
            disabled={safePage === 1}
            onPress={() => setPage((current) => Math.max(1, current - 1))}
          >
            <Text style={styles.pageButtonText}>Anterior</Text>
          </Pressable>
          <Pressable
            style={[styles.pageButton, safePage === totalPages && styles.pageButtonDisabled]}
            disabled={safePage === totalPages}
            onPress={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            <Text style={styles.pageButtonText}>Siguiente</Text>
          </Pressable>
        </View>
      </Panel>
      {playlist && visibleTracks.length === 0 && (
        <Panel padded>
          <Text style={styles.rowTitle}>Sin canciones para mostrar</Text>
          <Text style={styles.rowDescription}>{status}</Text>
        </Panel>
      )}
      {viewMode === 'list' ? (
        pageTracks.map((song, index) => <TrackListItem key={`${song.id}-${pageStart + index}`} song={song} />)
      ) : (
        <View style={styles.trackGrid}>
          {pageTracks.map((song, index) => (
            <TrackGridItem key={`${song.id}-${pageStart + index}`} song={song} />
          ))}
        </View>
      )}
      {visibleTracks.length > pageSize && (
        <View style={styles.paginationRow}>
          <Pressable
            style={[styles.pageButton, safePage === 1 && styles.pageButtonDisabled]}
            disabled={safePage === 1}
            onPress={() => setPage((current) => Math.max(1, current - 1))}
          >
            <Text style={styles.pageButtonText}>Anterior</Text>
          </Pressable>
          <Pressable
            style={[styles.pageButton, safePage === totalPages && styles.pageButtonDisabled]}
            disabled={safePage === totalPages}
            onPress={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            <Text style={styles.pageButtonText}>Siguiente</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

function TrackListItem({ song }: { song: SpotifyTrack }) {
  return (
    <View style={styles.songRow}>
      <Text style={styles.cardYear}>{song.year || '-'}</Text>
      {song.imageUrl && <Image source={{ uri: song.imageUrl }} style={styles.trackImage} />}
      <View style={styles.songCopy}>
        <Text style={styles.rowTitle}>{song.title}</Text>
        <Text style={styles.rowDescription}>{song.artist}</Text>
      </View>
      <Check color="#1ed760" size={24} />
    </View>
  );
}

function TrackGridItem({ song }: { song: SpotifyTrack }) {
  return (
    <View style={styles.trackTile}>
      {song.imageUrl ? (
        <Image source={{ uri: song.imageUrl }} style={styles.trackTileImage} />
      ) : (
        <View style={styles.trackTileImageFallback}>
          <Music2 color="#55d8ff" size={28} />
        </View>
      )}
      <Text style={styles.trackTileYear}>{song.year || '-'}</Text>
      <Text style={styles.trackTileTitle} numberOfLines={2}>{song.title}</Text>
      <Text style={styles.trackTileArtist} numberOfLines={1}>{song.artist}</Text>
    </View>
  );
}

type PrintableCard = {
  id: string;
  shortCode: string;
  qrPayload: string;
  title: string;
  artist: string;
  year: number;
  backColor: string;
};

const CARD_COLORS = ['#f07f6d', '#f2c84b', '#5cc8ff', '#d357f1', '#5ee0a0', '#f05aa6'];

function buildPrintableCards(playlist: SpotifyPlaylist | null, tracks: SpotifyTrack[]): PrintableCard[] {
  if (!playlist || tracks.length === 0) {
    return [];
  }

  return tracks.map((track, index) => {
    const shortCode = `HP${String(index + 1).padStart(3, '0')}`;
    const qrParams = new URLSearchParams({
      playlistId: playlist.id,
      trackId: track.id,
      index: String(index),
      title: track.title,
      artist: track.artist,
      year: String(track.year || ''),
    });

    if (track.spotifyUri) {
      qrParams.set('spotifyUri', track.spotifyUri);
    }

    if (track.previewUrl) {
      qrParams.set('previewUrl', track.previewUrl);
    }

    return {
      id: `${playlist.id}-${track.id}-${index}`,
      shortCode,
      qrPayload: `hitsterpersonal://card?${qrParams.toString()}`,
      title: track.title,
      artist: track.artist,
      year: track.year,
      backColor: CARD_COLORS[index % CARD_COLORS.length],
    };
  });
}

function DecorativeRings() {
  return (
    <View style={styles.ringStack} pointerEvents="none">
      <View style={[styles.ring, styles.ringPink]} />
      <View style={[styles.ring, styles.ringBlue]} />
      <View style={[styles.ring, styles.ringYellow]} />
      <View style={[styles.ring, styles.ringRed]} />
      <View style={[styles.ring, styles.ringPurple]} />
    </View>
  );
}

function openPrintableHtml(html: string) {
  const printWindow = globalThis.window?.open('', '_blank');
  if (!printWindow) {
    throw new Error('El navegador bloqueo la ventana de impresion.');
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 600);
}

async function buildCardsPdfHtml(cards: PrintableCard[]) {
  const qrById = new Map<string, string>();

  for (const card of cards) {
    qrById.set(
      card.id,
      await QRCode.toDataURL(card.qrPayload, {
        margin: 1,
        width: 420,
        color: {
          dark: '#111111',
          light: '#ffffff',
        },
      }),
    );
  }

  const fronts = cards
    .map((card) => buildCardFrontHtml(card, qrById.get(card.id) ?? ''))
    .join('');
  const backs = cards.map(buildCardBackHtml).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111; }
    .sheet { page-break-after: always; display: grid; grid-template-columns: repeat(3, 58mm); grid-auto-rows: 58mm; gap: 7mm; align-content: start; justify-content: center; }
    .card { width: 58mm; height: 58mm; border-radius: 2mm; overflow: hidden; position: relative; break-inside: avoid; }
    .front { background: #07070a; display: flex; align-items: center; justify-content: center; }
    .front .qr { width: 33mm; height: 33mm; background: white; padding: 2mm; z-index: 2; }
    .front .code { position: absolute; bottom: 3mm; right: 4mm; color: #777; font-size: 9pt; z-index: 3; }
    .front .codeLeft { position: absolute; bottom: 3mm; left: 4mm; color: #555; font-size: 8pt; z-index: 3; }
    .rings span { position: absolute; border: 1.3mm solid transparent; border-radius: 50%; inset: 5mm; }
    .rings span:nth-child(1) { border-top-color: #ff2aa3; border-right-color: #ff2aa3; transform: rotate(12deg); }
    .rings span:nth-child(2) { inset: 8mm; border-left-color: #29d9ff; border-bottom-color: #29d9ff; transform: rotate(-18deg); }
    .rings span:nth-child(3) { inset: 11mm; border-top-color: #f7d429; border-right-color: #f7d429; transform: rotate(48deg); }
    .rings span:nth-child(4) { inset: 14mm; border-left-color: #ee554d; border-bottom-color: #ee554d; transform: rotate(80deg); }
    .rings span:nth-child(5) { inset: 17mm; border-top-color: #b845e8; border-right-color: #b845e8; transform: rotate(120deg); }
    .back { display: flex; align-items: center; justify-content: center; text-align: center; padding: 6mm; }
    .back .title { font-size: 15pt; font-weight: 700; line-height: 1.1; }
    .back .year { font-size: 42pt; font-weight: 900; line-height: 1; margin: 3mm 0; }
    .back .artist { font-size: 13pt; font-style: italic; }
    .back .miniCode { position: absolute; bottom: 3mm; right: 4mm; color: rgba(0,0,0,0.35); font-size: 8pt; }
  </style>
</head>
<body>
  <section class="sheet">${fronts}</section>
  <section class="sheet">${backs}</section>
</body>
</html>`;
}

function buildCardFrontHtml(card: PrintableCard, qrDataUrl: string) {
  return `<div class="card front">
    <div class="rings"><span></span><span></span><span></span><span></span><span></span></div>
    <img class="qr" src="${qrDataUrl}" />
    <div class="codeLeft">HP</div>
    <div class="code">${escapeHtml(card.shortCode)}</div>
  </div>`;
}

function buildCardBackHtml(card: PrintableCard) {
  return `<div class="card back" style="background:${card.backColor}">
    <div>
      <div class="title">${escapeHtml(card.title)}</div>
      <div class="year">${card.year || '-'}</div>
      <div class="artist">${escapeHtml(card.artist)}</div>
    </div>
    <div class="miniCode">${escapeHtml(card.shortCode)}</div>
  </div>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function CardPdfScreen({
  cards,
  playlist,
  tracks,
  onNavigate,
}: {
  cards: CardPreview[];
  playlist: SpotifyPlaylist | null;
  tracks: SpotifyTrack[];
  onNavigate: (screen: ScreenName) => void;
}) {
  const [qrPreview, setQrPreview] = useState<string | null>(null);
  const [previewQrById, setPreviewQrById] = useState<Record<string, string>>({});
  const [showAllPreviewCards, setShowAllPreviewCards] = useState(false);
  const [exportStatus, setExportStatus] = useState('Listo para generar PDF.');
  const printableCards = useMemo(
    () => buildPrintableCards(playlist, tracks),
    [playlist, tracks],
  );
  const previewCards = useMemo(() => printableCards.slice(0, 4), [printableCards]);
  const firstCard = printableCards[0];

  useEffect(() => {
    let cancelled = false;

    async function buildPreviewQr() {
      if (!firstCard) {
        setQrPreview(null);
        return;
      }

      const dataUrl = await QRCode.toDataURL(firstCard.qrPayload, {
        margin: 1,
        width: 420,
        color: {
          dark: '#111111',
          light: '#ffffff',
        },
      });

      if (!cancelled) {
        setQrPreview(dataUrl);
      }
    }

    buildPreviewQr();

    return () => {
      cancelled = true;
    };
  }, [firstCard]);

  useEffect(() => {
    let cancelled = false;

    async function buildPreviewQrs() {
      const entries = await Promise.all(
        previewCards.map(async (card) => [
          card.id,
          await QRCode.toDataURL(card.qrPayload, {
            margin: 1,
            width: 260,
            color: {
              dark: '#111111',
              light: '#ffffff',
            },
          }),
        ] as const),
      );

      if (!cancelled) {
        setPreviewQrById(Object.fromEntries(entries));
      }
    }

    if (previewCards.length === 0) {
      setPreviewQrById({});
      return;
    }

    buildPreviewQrs();

    return () => {
      cancelled = true;
    };
  }, [previewCards]);

  const exportPdf = useCallback(async () => {
    if (printableCards.length === 0) {
      setExportStatus('No hay canciones cargadas para imprimir.');
      return;
    }

    setExportStatus('Generando QR y PDF...');

    try {
      const html = await buildCardsPdfHtml(printableCards);

      if (isWebRuntime) {
        openPrintableHtml(html);
        setExportStatus(`Ventana de impresion abierta: ${printableCards.length} cartas`);
        return;
      }

      const { uri } = await Print.printToFileAsync({
        html,
        width: 794,
        height: 1123,
      });

      setExportStatus(`PDF generado: ${printableCards.length} cartas`);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          UTI: 'com.adobe.pdf',
        });
      } else if (typeof window !== 'undefined') {
        window.open(uri, '_blank');
      }
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : 'No se pudo exportar el PDF.');
    }
  }, [printableCards]);

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.screenHero}>CARTAS{'\n'}PARA IMPRIMIR</Text>
      <Panel padded>
        <Text style={styles.rowTitle}>{playlist?.name ?? 'Sin playlist seleccionada'}</Text>
        <Text style={styles.rowDescription}>{printableCards.length} cartas preparadas. Cada QR usa un payload unico de la app.</Text>
        <Text style={styles.rowDescription}>{exportStatus}</Text>
      </Panel>
      {firstCard ? (
        <View style={styles.cardSides}>
          <View style={styles.printCardFront}>
            <DecorativeRings />
            <View style={styles.realQrBox}>
              {qrPreview ? <Image source={{ uri: qrPreview }} style={styles.realQrImage} /> : <QrCode color="#111" size={112} />}
            </View>
            <Text style={styles.printCardCode}>{firstCard.shortCode}</Text>
          </View>
          <View style={[styles.printCardBack, { backgroundColor: firstCard.backColor }]}>
            <Text style={styles.printCardTitle}>{firstCard.title}</Text>
            <Text style={styles.printCardYear}>{firstCard.year || '-'}</Text>
            <Text style={styles.printCardArtist}>{firstCard.artist}</Text>
          </View>
        </View>
      ) : null}
      <Panel padded>
        <Text style={styles.rowTitle}>Formato de carta</Text>
        <Text style={styles.rowDescription}>
          Anverso con QR unico. Reverso con artista, titulo y año para verificar la linea de tiempo.
        </Text>
      </Panel>
      <PrimaryButton label="Exportar PDF" icon={<Download color="#fff" size={24} />} onPress={exportPdf} />
      <SecondaryButton
        label={showAllPreviewCards ? 'Ocultar 4 cartas' : 'Ver 4 cartas'}
        icon={<QrCode color="#fff" size={22} />}
        onPress={() => setShowAllPreviewCards((current) => !current)}
      />
      <SecondaryButton label="Probar escaneo" icon={<ScanLine color="#fff" size={22} />} onPress={() => onNavigate('scanner')} />
      {showAllPreviewCards && (
        <View style={styles.cardPreviewGrid}>
          {previewCards.map((card) => (
            <View key={card.id} style={styles.previewPair}>
              <View style={styles.miniCardFront}>
                <DecorativeRings />
                <View style={styles.miniQrBox}>
                  {previewQrById[card.id] ? (
                    <Image source={{ uri: previewQrById[card.id] }} style={styles.miniQrImage} />
                  ) : (
                    <QrCode color="#111" size={58} />
                  )}
                </View>
                <Text style={styles.miniCardCode}>{card.shortCode}</Text>
              </View>
              <View style={[styles.miniCardBack, { backgroundColor: card.backColor }]}>
                <Text style={styles.miniCardYear}>{card.year || '-'}</Text>
                <Text style={styles.miniCardTitle} numberOfLines={2}>{card.title}</Text>
                <Text style={styles.miniCardArtist} numberOfLines={1}>{card.artist}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function ScannerScreen({
  settings,
  onClose,
  onScanned,
}: {
  settings: AppSettings;
  onClose: () => void;
  onScanned: (payload: string) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      if (scanned) {
        return;
      }

      setScanned(true);
      onScanned(result.data);
    },
    [onScanned, scanned],
  );

  if (!permission) {
    return <LoadingScreen />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.blackScreen}>
        <Pressable style={styles.closeButton} onPress={onClose}>
          <X color="#fff" size={36} />
        </Pressable>
        <Camera color="#ff2aa3" size={58} />
        <Text style={styles.scannerTitle}>Permiso de camara</Text>
        <Text style={styles.scannerHint}>Necesitamos la camara para leer los QR de tus cartas.</Text>
        <PrimaryButton label="Permitir camara" icon={<Camera color="#fff" size={24} />} onPress={requestPermission} />
      </View>
    );
  }

  return (
    <View style={styles.blackScreen}>
      <CameraView
        active
        facing="back"
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        onMountError={(event) => setCameraError(event.message)}
      />
      <View style={styles.cameraScrim} />
      <Pressable style={styles.closeButton} onPress={onClose}>
        <X color="#fff" size={36} />
      </Pressable>
      <View style={styles.onlineDot} />
      <View style={styles.scanFrame}>
        <ScanCorner position="tl" />
        <ScanCorner position="tr" />
        <ScanCorner position="bl" />
        <ScanCorner position="br" />
      </View>
      <Text style={styles.scannerTitle}>Escanea el reverso de la siguiente carta de Hitster</Text>
      <Text style={styles.scannerHint}>
        {cameraError ?? `${settings.gameMode === 'previews' ? 'Vistas previas' : 'Canciones completas'} · apunta al QR`}
      </Text>
      <Pressable style={styles.scanTapTarget} onPress={() => onScanned('hitsterpersonal://card/demo-deck/demo-card-001')}>
        <Camera color="#ff2aa3" size={28} />
      </Pressable>
    </View>
  );
}

function RotateScreen({
  settings,
  qrPayload,
  onReady,
}: {
  settings: AppSettings;
  qrPayload: string | null;
  onReady: () => void;
}) {
  const [z, setZ] = useState(0);
  const [isFaceDown, setIsFaceDown] = useState(false);
  const [hasSensor, setHasSensor] = useState(true);

  useEffect(() => {
    if (!settings.flipPhoneEnabled || settings.flipTrigger !== 'gyroscope') {
      return;
    }

    let subscription: { remove: () => void } | null = null;
    let active = true;

    async function setupSensor() {
      try {
        const isAvailable = await Accelerometer.isAvailableAsync();
        if (!isAvailable) {
          setHasSensor(false);
          return;
        }

        if (!active) return;
        Accelerometer.setUpdateInterval(120);
        subscription = Accelerometer.addListener((data) => {
          setZ(data.z);
          if (data.z < -0.85) {
            setIsFaceDown(true);
          }
        });
      } catch (err) {
        console.warn('Accelerometer setup failed:', err);
        setHasSensor(false);
      }
    }

    setupSensor();

    return () => {
      active = false;
      if (subscription) {
        subscription.remove();
      }
    };
  }, [settings.flipPhoneEnabled, settings.flipTrigger]);

  useEffect(() => {
    if (!isFaceDown) {
      return;
    }

    const timer = setTimeout(onReady, 450);
    return () => clearTimeout(timer);
  }, [isFaceDown, onReady]);

  useEffect(() => {
    if (settings.flipTrigger !== 'countdown') {
      return;
    }

    const timer = setTimeout(onReady, 2500);
    return () => clearTimeout(timer);
  }, [onReady, settings.flipTrigger]);

  return (
    <LinearGradient colors={['#5f326d', '#473074', '#ac2c91']} style={styles.playShell}>
      <ModeBadge settings={settings} />
      <View style={styles.phoneIcon}>
        <Smartphone color="#20d7ff" size={148} strokeWidth={1.4} />
        <Music2 color="#ff2aa3" size={58} style={styles.phoneMusicIcon} />
      </View>
      <Text style={styles.rotateTitle}>{settings.flipTrigger === 'gyroscope' ? 'GIRA EL TELEFONO' : 'CUENTA ATRAS'}</Text>
      <Text style={styles.rotateSubtitle}>
        {settings.flipTrigger === 'gyroscope' ? 'Entonces la musica empezara' : 'La musica empezara en unos segundos'}
      </Text>
      <View style={styles.sensorPanel}>
        <Text style={styles.sensorText}>QR: {qrPayload ?? 'sin lectura'}</Text>
        {hasSensor ? (
          <>
            <Text style={styles.sensorText}>Acelerometro Z: {z.toFixed(2)}</Text>
            <Text style={styles.sensorText}>{isFaceDown ? 'Telefono boca abajo detectado' : 'Esperando z < -0.85'}</Text>
          </>
        ) : (
          <Text style={[styles.sensorText, { color: '#ffbe5b', fontStyle: 'italic' }]}>
            Sensor no disponible en web/emulador. Usa el boton de abajo para simular.
          </Text>
        )}
      </View>
      <PrimaryButton label="Simular inicio" icon={<Play color="#fff" size={24} />} onPress={onReady} />
    </LinearGradient>
  );
}

function PlayerScreen({
  settings,
  onMenu,
  onNext,
  qrPayload,
}: {
  settings: AppSettings;
  onMenu: () => void;
  onNext: () => void;
  qrPayload: string | null;
}) {
  const [revealed, setRevealed] = useState(false);
  const parsedCard = useMemo(() => parseQrPayload(qrPayload), [qrPayload]);

  const title = parsedCard?.title || 'Faith';
  const artist = parsedCard?.artist || 'George Michael';
  const year = parsedCard?.year || 1987;

  return (
    <LinearGradient colors={['#5f326d', '#473074', '#ac2c91']} style={styles.playShell}>
      <ModeBadge settings={settings} />
      <View style={styles.spotifyCard}>
        <Music2 color="#fff" size={28} style={styles.spotifyCornerIcon} />
        
        {!revealed ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 20, marginVertical: 30 }}>
            <View style={[styles.albumArt, { marginTop: 0, backgroundColor: '#0f0918', borderWidth: 2, borderColor: '#ff2aa3', shadowColor: '#ff2aa3', shadowRadius: 10, shadowOpacity: 0.8 }]}>
              <Music2 color="#ff2aa3" size={64} />
            </View>
            <Text style={[styles.trackTitle, { textAlign: 'center', fontSize: 28, marginTop: 10 }]}>¿Qué canción es?</Text>
            <Text style={[styles.trackArtist, { textAlign: 'center', color: '#b7a8bd', fontSize: 16, lineHeight: 22 }]}>
              Escucha con atención y colócala en tu línea de tiempo
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <View style={styles.albumArt}>
              <Text style={styles.albumText}>{String(title).toUpperCase().slice(0, 10)}</Text>
            </View>
            <Text style={styles.trackTitle} numberOfLines={2}>{title}</Text>
            <View style={styles.trackMetaRow}>
              <Text style={styles.samplePill}>{year}</Text>
              <Text style={styles.trackArtist} numberOfLines={1}>{artist}</Text>
            </View>
            <View style={styles.saveRow}>
              <CirclePlus color="#fff" size={30} />
              <Text style={styles.saveText}>Guardar en Spotify</Text>
            </View>
          </View>
        )}

        <Pressable style={styles.moreButton} onPress={onMenu}>
          <Text style={styles.moreText}>...</Text>
        </Pressable>
        <Pause color="#fff" size={48} style={styles.pauseIcon} />
      </View>

      {!revealed ? (
        <PrimaryButton label="Revelar canción" icon={<Sparkles color="#fff" size={24} />} onPress={() => setRevealed(true)} />
      ) : (
        <PrimaryButton label="Siguiente carta" icon={<ArrowRight color="#fff" size={28} />} onPress={onNext} />
      )}
    </LinearGradient>
  );
}

function SongMenuScreen({ onClose, onNext }: { onClose: () => void; onNext: () => void }) {
  return (
    <LinearGradient colors={['#5f326d', '#473074', '#ac2c91']} style={styles.playShell}>
      <ModeBadge settings={{ gameMode: 'previews', playbackSeconds: 30 } as AppSettings} />
      <View style={styles.spotifyModal}>
        <Pressable style={styles.modalClose} onPress={onClose}>
          <X color="#fff" size={34} />
        </Pressable>
        <MenuAction icon={<Music2 color="#fff" size={28} />} label="Reproducir en Spotify" />
        <MenuAction icon={<CirclePlus color="#fff" size={28} />} label="Guardar en Spotify" />
        <MenuAction icon={<Share2 color="#fff" size={28} />} label="Copiar enlace" />
        <Text style={styles.legalText}>Politica de privacidad · Terminos y condiciones</Text>
      </View>
      <PrimaryButton label="Siguiente carta" icon={<ArrowRight color="#fff" size={28} />} onPress={onNext} />
    </LinearGradient>
  );
}

function LoadingScreen() {
  return (
    <LinearGradient colors={['#130818', '#211126']} style={styles.loadingScreen}>
      <ActivityIndicator color="#ff2aa3" />
      <Text style={styles.loadingText}>Preparando biblioteca local...</Text>
    </LinearGradient>
  );
}

function Speaker() {
  return (
    <View style={styles.speaker}>
      <View style={styles.speakerRing}>
        <View style={styles.screwTopLeft} />
        <View style={styles.screwTopRight} />
        <View style={styles.screwBottomLeft} />
        <View style={styles.screwBottomRight} />
        <View style={styles.speakerCone}>
          <LinearGradient colors={['#f5f5f5', '#9c9c9c', '#f8f8f8']} style={styles.speakerMetal} />
          <View style={styles.speakerCore} />
        </View>
      </View>
    </View>
  );
}

function Panel({ children, padded = false }: { children: React.ReactNode; padded?: boolean }) {
  return <View style={[styles.panel, padded && styles.panelPadded]}>{children}</View>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

function PrimaryButton({ label, icon, onPress }: { label: string; icon: React.ReactNode; onPress: () => void }) {
  return (
    <Pressable style={styles.primaryButton} onPress={onPress}>
      <Text style={styles.primaryButtonText}>{label}</Text>
      {icon}
    </Pressable>
  );
}

function SecondaryButton({ label, icon, onPress }: { label: string; icon: React.ReactNode; onPress: () => void }) {
  return (
    <Pressable style={styles.secondaryButton} onPress={onPress}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
      {icon}
    </Pressable>
  );
}

function IconButton({ children, onPress }: { children: React.ReactNode; onPress: () => void }) {
  return (
    <Pressable style={styles.iconButton} onPress={onPress}>
      {children}
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function LinkRow({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <Pressable style={styles.linkRow}>
      <View style={styles.linkIconWrap}>{icon}</View>
      <Text style={styles.linkLabel}>{label}</Text>
      <ExternalLink color="#fff" size={24} />
    </Pressable>
  );
}

function SocialButton({ icon, accent }: { icon: React.ReactNode; accent?: string }) {
  return (
    <Pressable style={styles.socialButton}>
      {icon}
      {accent && <View style={[styles.socialAccent, { backgroundColor: accent }]} />}
    </Pressable>
  );
}

function ChoiceRow({
  title,
  description,
  selected,
  onPress,
}: {
  title: string;
  description: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.choiceRow} onPress={onPress}>
      <View style={styles.choiceCopy}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDescription}>{description}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioInner} />}</View>
    </Pressable>
  );
}

function Pill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.pill, selected && styles.pillSelected]} onPress={onPress}>
      <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function SettingValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.settingValue}>
      <View>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingText}>{value}</Text>
      </View>
      <ChevronDown color="#7b6d82" size={22} />
    </View>
  );
}

function ScanCorner({ position }: { position: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <View style={[styles.scanCorner, styles[`scanCorner_${position}`]]} />;
}

function ModeBadge({ settings }: { settings: AppSettings }) {
  return (
    <View style={styles.modeBadge}>
      <Text style={styles.modeBadgeLabel}>Modo de juego</Text>
      <Text style={styles.modeBadgeValue}>
        {settings.gameMode === 'previews' ? `Vistas previas de ${settings.playbackSeconds}s` : 'Canciones completas'}
      </Text>
    </View>
  );
}

function MenuAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <Pressable style={styles.menuAction}>
      {icon}
      <Text style={styles.menuActionText}>{label}</Text>
    </Pressable>
  );
}



type SpotifyPlaylistApiItem = {
  id: string;
  name: string;
  owner?: {
    id?: string;
    display_name?: string;
  };
  images?: Array<{
    url: string;
  }>;
  collaborative?: boolean;
  items?: {
    href?: string;
    total?: number;
  };
  tracks?:
    | {
        total?: number;
      }
    | {
        href: string;
        total?: number;
      };
};

type SpotifyPlaylistsApiResponse = {
  items: SpotifyPlaylistApiItem[];
  next: string | null;
};

async function fetchSpotifyPlaylists(accessToken: string): Promise<SpotifyPlaylist[]> {
  const profile = await fetchSpotifyProfile(accessToken);
  const currentUserId = profile.id;
  const playlistsByKey = new Map<string, SpotifyPlaylist>();
  let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Spotify playlists fallo con estado ${response.status}`);
    }

    const page = (await response.json()) as SpotifyPlaylistsApiResponse;
    for (const item of page.items) {
      if (!item?.id || !item.name) {
        continue;
      }

      const playlist = {
        id: item.id,
        name: item.name,
        tracksTotal: item.items?.total ?? item.tracks?.total ?? 0,
        ownerName: item.owner?.display_name,
        ownerId: item.owner?.id,
        collaborative: item.collaborative ?? false,
        canReadTracks: Boolean(currentUserId && item.owner?.id === currentUserId) || Boolean(item.collaborative),
        imageUrl: item.images?.[0]?.url,
        tracksHref: item.items?.href ?? (item.tracks && 'href' in item.tracks ? item.tracks.href : undefined),
      };
      playlistsByKey.set(`${playlist.id}:${playlist.ownerName ?? ''}`, playlist);
    }
    url = page.next;
  }

  return Array.from(playlistsByKey.values());
}

type SpotifyPlaylistTracksApiResponse = {
  items: Array<{
    item?: {
      id?: string;
      name?: string;
      preview_url?: string | null;
      uri?: string;
      artists?: Array<{
        name: string;
      }>;
      album?: {
        name?: string;
        release_date?: string;
        images?: Array<{
          url: string;
        }>;
      };
    } | null;
  }>;
  next: string | null;
};

async function fetchSpotifyPlaylistTracks(accessToken: string, playlistId: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url: string | null = `https://api.spotify.com/v1/playlists/${encodeURIComponent(
    playlistId,
  )}/items?limit=50&fields=items(item(id,name,preview_url,uri,artists(name),album(name,release_date,images(url)))),next`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(
          'Spotify no permite leer canciones de esta playlist porque no eres el propietario ni colaborador.',
        );
      }
      throw new Error(`Spotify tracks fallo con estado ${response.status}`);
    }

    const page = (await response.json()) as SpotifyPlaylistTracksApiResponse;

    for (const item of page.items) {
      const track = item.item;
      if (!track?.id || !track.name) {
        continue;
      }

      tracks.push({
        id: track.id,
        title: track.name,
        artist: track.artists?.map((artist) => artist.name).join(', ') || 'Artista desconocido',
        year: parseReleaseYear(track.album?.release_date),
        albumName: track.album?.name,
        imageUrl: track.album?.images?.[0]?.url,
        previewUrl: track.preview_url ?? undefined,
        spotifyUri: track.uri,
      });
    }

    url = page.next;
  }

  return tracks;
}

function parseReleaseYear(releaseDate?: string): number {
  if (!releaseDate) {
    return 0;
  }

  const year = Number(releaseDate.slice(0, 4));
  return Number.isFinite(year) ? year : 0;
}

const styles = StyleSheet.create({
  appShell: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingTop: 42,
  },
  phoneViewport: {
    alignSelf: 'center',
    flex: 1,
    maxWidth: 430,
    width: '100%',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  loadingText: {
    color: '#f7e9ff',
    fontSize: 16,
  },
  authCallback: {
    alignItems: 'center',
    backgroundColor: '#120717',
    flex: 1,
    gap: 14,
    justifyContent: 'center',
  },
  authCallbackText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 58,
    paddingHorizontal: 18,
  },
  headerTitle: {
    color: '#fff',
    flex: 1,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  headerSpacer: {
    width: 46,
  },
  iconButton: {
    alignItems: 'center',
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  homeContent: {
    flexGrow: 1,
    justifyContent: 'space-between',
    padding: 24,
    paddingBottom: 32,
  },
  logoBlock: {
    alignItems: 'center',
    marginTop: 8,
  },
  logo: {
    color: '#ff2aa3',
    fontSize: 58,
    fontWeight: '900',
    letterSpacing: 0,
    textShadowColor: '#ff2aa3',
    textShadowRadius: 18,
  },
  neonFrame: {
    alignItems: 'center',
    borderColor: '#55d8ff',
    borderRadius: 8,
    borderWidth: 2,
    marginTop: 18,
    paddingHorizontal: 30,
    paddingVertical: 14,
    shadowColor: '#55d8ff',
    shadowOpacity: 0.9,
    shadowRadius: 12,
  },
  logoSubline: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '500',
    lineHeight: 32,
  },
  speaker: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 34,
  },
  speakerRing: {
    alignItems: 'center',
    backgroundColor: '#d6d6d6',
    borderColor: '#efefef',
    borderRadius: 138,
    borderWidth: 12,
    height: 276,
    justifyContent: 'center',
    width: 276,
  },
  speakerCone: {
    alignItems: 'center',
    backgroundColor: '#12161a',
    borderColor: '#252a2f',
    borderRadius: 106,
    borderWidth: 18,
    height: 212,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 212,
  },
  speakerMetal: {
    borderRadius: 75,
    height: 150,
    position: 'absolute',
    width: 150,
  },
  speakerCore: {
    backgroundColor: '#050506',
    borderColor: '#2e2e30',
    borderRadius: 40,
    borderWidth: 8,
    height: 80,
    width: 80,
  },
  screwTopLeft: {
    ...screwStyle(42, 42),
  },
  screwTopRight: {
    ...screwStyle(206, 42),
  },
  screwBottomLeft: {
    ...screwStyle(42, 206),
  },
  screwBottomRight: {
    ...screwStyle(206, 206),
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 18,
  },
  statsRowCompact: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  stat: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 14,
  },
  statValue: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
  },
  statLabel: {
    color: '#b7a8bd',
    fontSize: 12,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  buttonStack: {
    gap: 14,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#f72597',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    minHeight: 64,
    paddingHorizontal: 18,
    shadowColor: '#ff2aa3',
    shadowOpacity: 0.55,
    shadowRadius: 18,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    minHeight: 58,
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  scrollContent: {
    gap: 16,
    padding: 24,
    paddingBottom: 42,
  },
  screenHero: {
    color: '#fff',
    fontSize: 42,
    fontWeight: '500',
    lineHeight: 54,
    marginBottom: 18,
  },
  sectionTitle: {
    color: '#a99aad',
    fontSize: 20,
    marginTop: 10,
  },
  panel: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  panelPadded: {
    padding: 18,
  },
  linkRow: {
    alignItems: 'center',
    borderBottomColor: 'rgba(255,255,255,0.07)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    minHeight: 76,
    paddingHorizontal: 18,
  },
  linkIconWrap: {
    width: 36,
  },
  linkLabel: {
    color: '#fff',
    flex: 1,
    fontSize: 24,
  },
  socialRow: {
    flexDirection: 'row',
    gap: 8,
  },
  socialButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    flex: 1,
    height: 78,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  socialText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '900',
  },
  socialAccent: {
    borderRadius: 4,
    height: 8,
    position: 'absolute',
    right: 34,
    top: 28,
    width: 8,
  },
  spotifyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 82,
    paddingHorizontal: 24,
  },
  spotifyText: {
    color: '#1ed760',
    fontSize: 25,
    fontWeight: '700',
  },
  spotifyPlan: {
    color: '#1ed760',
    fontSize: 24,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  spotifyStatus: {
    color: '#b7a8bd',
    fontSize: 14,
    lineHeight: 20,
    paddingBottom: 16,
    paddingHorizontal: 24,
  },
  warningText: {
    color: '#ffd166',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12,
  },
  choiceRow: {
    alignItems: 'center',
    borderBottomColor: 'rgba(255,255,255,0.07)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 14,
    minHeight: 112,
    padding: 18,
  },
  choiceCopy: {
    flex: 1,
  },
  rowTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
  },
  rowDescription: {
    color: '#b7a8bd',
    fontSize: 16,
    lineHeight: 23,
    marginTop: 8,
  },
  radio: {
    alignItems: 'center',
    borderColor: '#63566a',
    borderRadius: 14,
    borderWidth: 3,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  radioSelected: {
    borderColor: '#08aeea',
  },
  radioInner: {
    backgroundColor: '#08aeea',
    borderRadius: 7,
    height: 14,
    width: 14,
  },
  switchRow: {
    alignItems: 'center',
    borderBottomColor: 'rgba(255,255,255,0.07)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 14,
    minHeight: 138,
    padding: 18,
  },
  switchCopy: {
    flex: 1,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    padding: 18,
  },
  pill: {
    borderColor: '#63566a',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  pillSelected: {
    backgroundColor: '#08aeea',
    borderColor: '#08aeea',
  },
  pillText: {
    color: '#d7c7df',
    fontWeight: '800',
  },
  pillTextSelected: {
    color: '#061017',
  },
  settingValue: {
    alignItems: 'center',
    borderBottomColor: 'rgba(255,255,255,0.07)',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 82,
    padding: 18,
  },
  settingLabel: {
    color: '#a99aad',
    fontSize: 15,
  },
  settingText: {
    color: '#fff',
    fontSize: 26,
    marginTop: 4,
  },
  playlistCard: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 16,
    minHeight: 92,
    padding: 18,
  },
  playlistCardDisabled: {
    opacity: 0.58,
  },
  playlistIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(85,216,255,0.12)',
    borderRadius: 8,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  playlistImage: {
    backgroundColor: 'rgba(85,216,255,0.12)',
    borderRadius: 8,
    height: 54,
    width: 54,
  },
  playlistCopy: {
    flex: 1,
  },
  songRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 14,
    minHeight: 82,
    padding: 16,
  },
  cardYear: {
    color: '#ff2aa3',
    fontSize: 27,
    fontWeight: '900',
    minWidth: 72,
  },
  songCopy: {
    flex: 1,
  },
  stickyActions: {
    gap: 10,
  },
  trackToolbar: {
    gap: 14,
  },
  toolbarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  viewToggle: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  paginationRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  pageButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    minHeight: 46,
    justifyContent: 'center',
  },
  pageButtonDisabled: {
    opacity: 0.38,
  },
  pageButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  trackImage: {
    backgroundColor: 'rgba(85,216,255,0.12)',
    borderRadius: 8,
    height: 54,
    width: 54,
  },
  trackGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  trackTile: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    width: '48%',
  },
  trackTileImage: {
    aspectRatio: 1,
    borderRadius: 8,
    width: '100%',
  },
  trackTileImageFallback: {
    alignItems: 'center',
    aspectRatio: 1,
    backgroundColor: 'rgba(85,216,255,0.12)',
    borderRadius: 8,
    justifyContent: 'center',
    width: '100%',
  },
  trackTileYear: {
    color: '#ff2aa3',
    fontSize: 18,
    fontWeight: '900',
    marginTop: 10,
  },
  trackTileTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 20,
    marginTop: 4,
  },
  trackTileArtist: {
    color: '#b7a8bd',
    fontSize: 13,
    marginTop: 6,
  },
  cardSides: {
    flexDirection: 'row',
    gap: 14,
  },
  printCardFront: {
    alignItems: 'center',
    aspectRatio: 1,
    backgroundColor: '#09090b',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    padding: 14,
    position: 'relative',
  },
  printCardBack: {
    alignItems: 'center',
    aspectRatio: 1,
    backgroundColor: '#ef806d',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    padding: 14,
  },
  qrBox: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 6,
    height: 132,
    justifyContent: 'center',
    width: 132,
  },
  realQrBox: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 6,
    height: 138,
    justifyContent: 'center',
    padding: 8,
    width: 138,
    zIndex: 2,
  },
  realQrImage: {
    height: 122,
    width: 122,
  },
  ringStack: {
    bottom: 8,
    left: 8,
    position: 'absolute',
    right: 8,
    top: 8,
  },
  ring: {
    borderColor: 'transparent',
    borderRadius: 999,
    borderWidth: 3,
    position: 'absolute',
  },
  ringPink: {
    borderRightColor: '#ff2aa3',
    borderTopColor: '#ff2aa3',
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    transform: [{ rotate: '12deg' }],
  },
  ringBlue: {
    borderBottomColor: '#29d9ff',
    borderLeftColor: '#29d9ff',
    bottom: 12,
    left: 12,
    right: 12,
    top: 12,
    transform: [{ rotate: '-18deg' }],
  },
  ringYellow: {
    borderRightColor: '#f7d429',
    borderTopColor: '#f7d429',
    bottom: 24,
    left: 24,
    right: 24,
    top: 24,
    transform: [{ rotate: '48deg' }],
  },
  ringRed: {
    borderBottomColor: '#ee554d',
    borderLeftColor: '#ee554d',
    bottom: 36,
    left: 36,
    right: 36,
    top: 36,
    transform: [{ rotate: '80deg' }],
  },
  ringPurple: {
    borderRightColor: '#b845e8',
    borderTopColor: '#b845e8',
    bottom: 48,
    left: 48,
    right: 48,
    top: 48,
    transform: [{ rotate: '120deg' }],
  },
  printCardCode: {
    bottom: 10,
    color: '#777',
    fontSize: 12,
    position: 'absolute',
    right: 12,
    zIndex: 3,
  },
  printCardTitle: {
    color: '#1b1112',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  printCardYear: {
    color: '#1b1112',
    fontSize: 46,
    fontWeight: '900',
  },
  printCardArtist: {
    color: '#1b1112',
    fontSize: 16,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  cardPreviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  previewPair: {
    flexDirection: 'row',
    gap: 8,
    width: '100%',
  },
  miniCardFront: {
    alignItems: 'center',
    aspectRatio: 1,
    backgroundColor: '#09090b',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 10,
    position: 'relative',
  },
  miniQrBox: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 5,
    height: 86,
    justifyContent: 'center',
    padding: 5,
    width: 86,
    zIndex: 2,
  },
  miniQrImage: {
    height: 76,
    width: 76,
  },
  miniCardCode: {
    bottom: 8,
    color: '#777',
    fontSize: 10,
    position: 'absolute',
    right: 8,
    zIndex: 3,
  },
  miniCardBack: {
    aspectRatio: 1,
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    padding: 12,
  },
  miniCardYear: {
    color: '#111',
    fontSize: 30,
    fontWeight: '900',
    textAlign: 'center',
  },
  miniCardTitle: {
    color: '#111',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 6,
    textAlign: 'center',
  },
  miniCardArtist: {
    color: '#1d1515',
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 6,
    textAlign: 'center',
  },
  blackScreen: {
    alignItems: 'center',
    backgroundColor: '#000',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  cameraScrim: {
    backgroundColor: 'rgba(0,0,0,0.35)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  closeButton: {
    position: 'absolute',
    right: 26,
    top: 72,
    zIndex: 2,
  },
  onlineDot: {
    backgroundColor: '#23e789',
    borderRadius: 4,
    height: 8,
    position: 'absolute',
    right: 46,
    top: 44,
    width: 8,
  },
  scanFrame: {
    height: 292,
    marginBottom: 54,
    position: 'relative',
    width: 292,
  },
  scanCorner: {
    borderColor: '#ff58bd',
    height: 70,
    position: 'absolute',
    shadowColor: '#ff2aa3',
    shadowOpacity: 1,
    shadowRadius: 12,
    width: 70,
  },
  scanCorner_tl: {
    borderLeftWidth: 4,
    borderTopWidth: 4,
    left: 0,
    top: 0,
  },
  scanCorner_tr: {
    borderRightWidth: 4,
    borderTopWidth: 4,
    right: 0,
    top: 0,
  },
  scanCorner_bl: {
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    bottom: 0,
    left: 0,
  },
  scanCorner_br: {
    borderBottomWidth: 4,
    borderRightWidth: 4,
    bottom: 0,
    right: 0,
  },
  scannerTitle: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 38,
    textAlign: 'center',
  },
  scannerHint: {
    color: '#9f96a5',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 16,
    textAlign: 'center',
  },
  scanTapTarget: {
    alignItems: 'center',
    height: 74,
    justifyContent: 'center',
    marginTop: 20,
    width: 74,
  },
  playShell: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 24,
    paddingBottom: 42,
    paddingTop: 70,
  },
  modeBadge: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.13)',
    borderRadius: 8,
    minWidth: 240,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  modeBadgeLabel: {
    color: '#bdb0c1',
    fontSize: 16,
    textAlign: 'center',
  },
  modeBadgeValue: {
    color: '#fff',
    fontSize: 24,
    textAlign: 'center',
  },
  phoneIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneMusicIcon: {
    position: 'absolute',
    transform: [{ rotate: '-18deg' }],
  },
  rotateTitle: {
    color: '#fff',
    fontSize: 42,
    fontWeight: '300',
    textAlign: 'center',
  },
  rotateSubtitle: {
    color: '#fff',
    fontSize: 25,
    marginTop: -36,
    textAlign: 'center',
  },
  sensorPanel: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderRadius: 8,
    gap: 6,
    padding: 14,
  },
  sensorText: {
    color: '#f2e8f5',
    fontSize: 13,
    textAlign: 'center',
  },
  spotifyCard: {
    alignSelf: 'center',
    backgroundColor: '#1f6079',
    borderRadius: 8,
    minHeight: 392,
    padding: 28,
    position: 'relative',
    width: '100%',
  },
  spotifyCornerIcon: {
    position: 'absolute',
    right: 34,
    top: 34,
  },
  albumArt: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#111',
    borderRadius: 8,
    height: 148,
    justifyContent: 'flex-end',
    marginTop: 58,
    paddingBottom: 18,
    width: 148,
  },
  albumText: {
    color: '#d4b03d',
    fontSize: 25,
    fontWeight: '300',
  },
  trackTitle: {
    color: '#fff',
    fontSize: 42,
    fontWeight: '900',
    marginTop: 28,
  },
  trackMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  samplePill: {
    backgroundColor: '#073d54',
    borderRadius: 4,
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  trackArtist: {
    color: '#b8d3df',
    fontSize: 24,
  },
  saveRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    marginTop: 18,
  },
  saveText: {
    color: '#fff',
    fontSize: 23,
    fontWeight: '700',
  },
  moreButton: {
    bottom: 44,
    position: 'absolute',
    right: 136,
  },
  moreText: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '900',
  },
  pauseIcon: {
    bottom: 48,
    position: 'absolute',
    right: 48,
  },
  spotifyModal: {
    alignSelf: 'center',
    backgroundColor: '#1f6079',
    borderRadius: 8,
    minHeight: 392,
    padding: 34,
    paddingTop: 116,
    position: 'relative',
    width: '100%',
  },
  modalClose: {
    position: 'absolute',
    right: 28,
    top: 28,
  },
  menuAction: {
    alignItems: 'center',
    backgroundColor: '#033f58',
    borderRadius: 6,
    flexDirection: 'row',
    gap: 18,
    minHeight: 70,
    marginBottom: 16,
    paddingHorizontal: 24,
  },
  menuActionText: {
    color: '#fff',
    fontSize: 23,
    fontWeight: '600',
  },
  legalText: {
    bottom: 28,
    color: '#b8d3df',
    fontSize: 16,
    left: 0,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
  },
});

function screwStyle(left: number, top: number) {
  return {
    backgroundColor: '#5a5d60',
    borderColor: '#25282b',
    borderRadius: 10,
    borderWidth: 4,
    height: 20,
    left,
    position: 'absolute' as const,
    top,
    width: 20,
  };
}
