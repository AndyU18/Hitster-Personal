# Hitster Personal

App movil Expo/React Native para crear y jugar una version local de Hitster con cartas propias.

## Decision tecnica actual

- Datos 100% locales con `expo-sqlite`.
- Sin Supabase, Firebase ni MongoDB en el MVP.
- QR propios con payload interno: `hitsterpersonal://card/{deckId}/{cardId}`.
- QR originales de Hitster solo se resolveran si existe un mapeo local en SQLite.
- Spotify se activara despues del login OAuth.

## Scripts

```bash
npm start
npm run android
npm run web
```

## Spotify OAuth

1. Crea una app en Spotify Developer Dashboard.
2. Copia el Client ID en `.env`:

```bash
EXPO_PUBLIC_SPOTIFY_CLIENT_ID=tu_spotify_client_id
```

3. Agrega los redirect URI de desarrollo que uses con Expo. Para web local usa IP loopback, no `localhost`:

```txt
http://127.0.0.1:8081/redirect
http://[::1]:8081/redirect
hitsterpersonal://redirect
```

En este equipo Expo Web responde correctamente por `http://[::1]:8081`. Si `127.0.0.1` corta la conexion, abre la app desde `http://[::1]:8081` y usa el redirect IPv6 en Spotify.

## Estado

Primera base creada:

- Pantalla 1: inicio.
- Pantalla 2: normas y configuracion persistida en SQLite.
- Pantalla 3: importar canciones.
- Pantalla 4: playlists.
- Pantalla 5: detalle y revision de canciones.
- Pantalla 6: cartas y PDF.
- Pantalla 7: escaner QR.
- Pantalla 8: giro del telefono con acelerometro o cuenta atras.
- Pantalla 9: reproductor activo.
- Pantalla 10: menu de acciones de Spotify.
- Esquema local para mazos, cartas, ajustes y vinculos de cartas oficiales.

Integraciones iniciadas:

- QR real con `CameraView`, `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}` y `onBarcodeScanned`.
- Deteccion de telefono boca abajo con `Accelerometer`; empieza cuando `z < -0.85`.
- Spotify OAuth con PKCE usando `expo-auth-session`; lee `/v1/me` para detectar `free` o `premium`.
