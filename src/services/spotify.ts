const ACCOUNTS_URL = 'https://accounts.spotify.com'
const API_URL = 'https://api.spotify.com/v1'
const TOKEN_KEY = 'playback-atlas.spotify-token'
const VERIFIER_KEY = 'playback-atlas.pkce-verifier'
const STATE_KEY = 'playback-atlas.oauth-state'
const METADATA_KEY = 'playback-atlas.spotify-metadata'

interface StoredToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

interface TokenResponse {
  access_token: string
  token_type: string
  scope: string
  expires_in: number
  refresh_token?: string
}

interface SpotifyUser {
  id: string
  display_name: string | null
}

interface SpotifyTrackMetadata {
  uri: string
  album: {
    images: Array<{ url: string; width: number | null; height: number | null }>
  }
}

interface SpotifyOEmbedResponse {
  thumbnail_url?: string
}

interface SpotifyInsightTrack {
  uri: string
  duration_ms: number
  popularity: number
  album: { release_date: string }
  artists: Array<{ id: string }>
}

interface SpotifyArtistMetadata {
  id: string
  genres: string[]
}

interface CachedTrackMetadata {
  uri: string
  durationMs: number
  popularity: number
  releaseYear: number | null
  genres: string[]
}

export interface SpotifySession {
  displayName: string
}

export interface CreatedPlaylist {
  name: string
  url: string
  trackCount: number
}

export interface InsightEnrichment {
  trackCount: number
  averageDurationMs: number
  averagePopularity: number
  genres: Array<{ name: string; count: number }>
  releaseEras: Array<{ name: string; count: number }>
}

const artworkCache = new Map<string, string>()
const metadataCache = new Map<string, CachedTrackMetadata>()
let currentUserCache: SpotifyUser | null = null

try {
  const storedMetadata = localStorage.getItem(METADATA_KEY)
  if (storedMetadata) {
    const entries = JSON.parse(storedMetadata) as CachedTrackMetadata[]
    entries.forEach((entry) => metadataCache.set(entry.uri, entry))
  }
} catch {
  try {
    localStorage.removeItem(METADATA_KEY)
  } catch {
    // Storage can be unavailable in restrictive browser modes.
  }
}

function configuration() {
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID
  const redirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI
    || new URL(import.meta.env.BASE_URL, window.location.origin).toString()

  if (!clientId) {
    throw new Error('Set VITE_SPOTIFY_CLIENT_ID before connecting Spotify.')
  }
  return { clientId, redirectUri }
}

function randomString(length = 64) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const values = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('')
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function codeChallenge(verifier: string) {
  if (!window.crypto?.subtle) {
    throw new Error('Spotify login requires HTTPS or a 127.0.0.1 address. Open the app through its secure URL and try again.')
  }
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function readToken(): StoredToken | null {
  try {
    const value = localStorage.getItem(TOKEN_KEY)
    return value ? JSON.parse(value) as StoredToken : null
  } catch {
    return null
  }
}

function storeToken(response: TokenResponse, previousRefreshToken?: string) {
  const token: StoredToken = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token || previousRefreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  return token
}

async function exchangeToken(body: URLSearchParams) {
  const response = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error('Spotify authorization could not be completed.')
  return response.json() as Promise<TokenResponse>
}

async function validAccessToken() {
  const token = readToken()
  if (!token) throw new Error('Connect Spotify before creating a playlist.')
  if (token.expiresAt > Date.now() + 60_000) return token.accessToken
  if (!token.refreshToken) {
    localStorage.removeItem(TOKEN_KEY)
    throw new Error('Your Spotify session expired. Connect again.')
  }

  const { clientId } = configuration()
  const response = await exchangeToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: clientId,
  }))
  return storeToken(response, token.refreshToken).accessToken
}

async function api<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
  const accessToken = await validAccessToken()
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (response.status === 429 && attempt < 3) {
    const retryAfter = Number(response.headers.get('retry-after') || 1)
    await new Promise((resolve) => window.setTimeout(resolve, retryAfter * 1000))
    return api<T>(path, init, attempt + 1)
  }
  if (response.status === 401) localStorage.removeItem(TOKEN_KEY)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message || `Spotify request failed (${response.status}).`)
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export async function connectSpotify() {
  const { clientId, redirectUri } = configuration()
  const verifier = randomString(96)
  const state = randomString(32)
  localStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(STATE_KEY, state)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'playlist-modify-public playlist-modify-private',
    code_challenge_method: 'S256',
    code_challenge: await codeChallenge(verifier),
    state,
  })
  window.location.assign(`${ACCOUNTS_URL}/authorize?${params}`)
}

export async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const error = params.get('error')
  if (error) throw new Error(`Spotify authorization was declined: ${error}`)
  if (!code) return false

  const verifier = localStorage.getItem(VERIFIER_KEY)
  const expectedState = sessionStorage.getItem(STATE_KEY)
  if (!verifier || !expectedState || params.get('state') !== expectedState) {
    throw new Error('Spotify authorization state was invalid. Please connect again.')
  }

  const { clientId, redirectUri } = configuration()
  const response = await exchangeToken(new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }))
  storeToken(response)
  localStorage.removeItem(VERIFIER_KEY)
  sessionStorage.removeItem(STATE_KEY)
  window.history.replaceState({}, '', window.location.pathname)
  return true
}

export async function getSpotifySession(): Promise<SpotifySession | null> {
  if (!readToken()) return null
  try {
    const user = await api<SpotifyUser>('/me')
    currentUserCache = user
    return { displayName: user.display_name || user.id }
  } catch {
    return null
  }
}

export function disconnectSpotify() {
  localStorage.removeItem(TOKEN_KEY)
  currentUserCache = null
}

async function fetchPublicArtwork(uris: string[]) {
  for (let index = 0; index < uris.length; index += 8) {
    const batch = uris.slice(index, index + 8)
    await Promise.all(batch.map(async (uri) => {
      const trackId = uri.slice('spotify:track:'.length)
      const params = new URLSearchParams({ url: `https://open.spotify.com/track/${trackId}` })
      try {
        const response = await fetch(`https://open.spotify.com/oembed?${params}`)
        if (!response.ok) return
        const metadata = await response.json() as SpotifyOEmbedResponse
        if (metadata.thumbnail_url) artworkCache.set(uri, metadata.thumbnail_url)
      } catch {
        // Individual artwork failures retain the local placeholder.
      }
    }))
  }
}

export async function getTrackArtwork(uris: string[]) {
  const validUris = [...new Set(uris.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)))]
  let missingUris = validUris.filter((uri) => !artworkCache.has(uri))

  if (readToken()) {
    try {
      for (let index = 0; index < missingUris.length; index += 50) {
        const batch = missingUris.slice(index, index + 50)
        const ids = batch.map((uri) => uri.slice('spotify:track:'.length)).join(',')
        const response = await api<{ tracks: Array<SpotifyTrackMetadata | null> }>(
          `/tracks?ids=${encodeURIComponent(ids)}`,
        )
        response.tracks.forEach((track) => {
          const image = track?.album.images.find((candidate) => (candidate.width || 0) >= 64)
            || track?.album.images[0]
          if (track && image) artworkCache.set(track.uri, image.url)
        })
      }
    } catch {
      // Public oEmbed below also works when an access token is stale or unavailable.
    }
  }

  missingUris = validUris.filter((uri) => !artworkCache.has(uri))
  await fetchPublicArtwork(missingUris)

  return Object.fromEntries(
    validUris.flatMap((uri) => {
      const artwork = artworkCache.get(uri)
      return artwork ? [[uri, artwork]] : []
    }),
  ) as Record<string, string>
}

export async function getInsightEnrichment(uris: string[]): Promise<InsightEnrichment> {
  const validUris = [...new Set(uris.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)))]
  const missingUris = validUris.filter((uri) => !metadataCache.has(uri))

  for (let index = 0; index < missingUris.length; index += 50) {
    const batch = missingUris.slice(index, index + 50)
    const ids = batch.map((uri) => uri.slice('spotify:track:'.length)).join(',')
    const trackResponse = await api<{ tracks: Array<SpotifyInsightTrack | null> }>(
      `/tracks?ids=${encodeURIComponent(ids)}`,
    )
    const tracks = trackResponse.tracks.filter((track): track is SpotifyInsightTrack => Boolean(track))
    const artistIds = [...new Set(tracks.flatMap((track) => track.artists.map((artist) => artist.id)))]
    const genresByArtist = new Map<string, string[]>()

    for (let artistIndex = 0; artistIndex < artistIds.length; artistIndex += 50) {
      const artistBatch = artistIds.slice(artistIndex, artistIndex + 50)
      const artistResponse = await api<{ artists: Array<SpotifyArtistMetadata | null> }>(
        `/artists?ids=${encodeURIComponent(artistBatch.join(','))}`,
      )
      artistResponse.artists.forEach((artist) => {
        if (artist) genresByArtist.set(artist.id, artist.genres || [])
      })
    }

    tracks.forEach((track) => {
      const releaseYear = Number(track.album.release_date?.slice(0, 4))
      metadataCache.set(track.uri, {
        uri: track.uri,
        durationMs: Number(track.duration_ms) || 0,
        popularity: Number(track.popularity) || 0,
        releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
        genres: [...new Set(track.artists.flatMap((artist) => genresByArtist.get(artist.id) || []))],
      })
    })
  }

  try {
    localStorage.setItem(METADATA_KEY, JSON.stringify([...metadataCache.values()].slice(-500)))
  } catch {
    // Metadata caching is optional and must not block Insights.
  }

  const tracks = validUris.flatMap((uri) => {
    const metadata = metadataCache.get(uri)
    return metadata ? [metadata] : []
  })
  const genreCounts = new Map<string, number>()
  const eraCounts = new Map<string, number>()
  tracks.forEach((track) => {
    track.genres.forEach((genre) => genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1))
    if (track.releaseYear) {
      const era = `${Math.floor(track.releaseYear / 10) * 10}s`
      eraCounts.set(era, (eraCounts.get(era) || 0) + 1)
    }
  })

  return {
    trackCount: tracks.length,
    averageDurationMs: tracks.length ? tracks.reduce((sum, track) => sum + track.durationMs, 0) / tracks.length : 0,
    averagePopularity: tracks.length ? tracks.reduce((sum, track) => sum + track.popularity, 0) / tracks.length : 0,
    genres: [...genreCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    releaseEras: [...eraCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export async function createPlaylist(
  name: string,
  uris: string[],
  isPublic: boolean,
): Promise<CreatedPlaylist> {
  const validUris = [...new Set(uris.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)))]
  if (!validUris.length) {
    throw new Error('No Spotify track URIs are available in the selected history.')
  }

  const user = currentUserCache || await api<SpotifyUser>('/me')
  currentUserCache = user
  const playlist = await api<{ id: string; name: string; external_urls: { spotify: string } }>(
    `/users/${encodeURIComponent(user.id)}/playlists`,
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        public: isPublic,
        description: 'Created privately in your browser with Playback Atlas.',
      }),
    },
  )

  for (let index = 0; index < validUris.length; index += 100) {
    await api(`/playlists/${playlist.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ uris: validUris.slice(index, index + 100) }),
    })
  }

  return { name: playlist.name, url: playlist.external_urls.spotify, trackCount: validUris.length }
}
