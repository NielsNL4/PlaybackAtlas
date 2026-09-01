const ACCOUNTS_URL = 'https://accounts.spotify.com'
const API_URL = 'https://api.spotify.com/v1'
const TOKEN_KEY = 'playback-atlas.spotify-token'
const VERIFIER_KEY = 'playback-atlas.pkce-verifier'
const STATE_KEY = 'playback-atlas.oauth-state'

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

export interface SpotifySession {
  displayName: string
}

export interface CreatedPlaylist {
  name: string
  url: string
  trackCount: number
}

const artworkCache = new Map<string, string>()

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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await validAccessToken()
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
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
    return { displayName: user.display_name || user.id }
  } catch {
    return null
  }
}

export function disconnectSpotify() {
  localStorage.removeItem(TOKEN_KEY)
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

export async function createPlaylist(
  name: string,
  uris: string[],
  isPublic: boolean,
): Promise<CreatedPlaylist> {
  const validUris = [...new Set(uris.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)))]
  if (!validUris.length) {
    throw new Error('No Spotify track URIs are available in the selected history.')
  }

  const user = await api<SpotifyUser>('/me')
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
