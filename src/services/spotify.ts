const ACCOUNTS_URL = 'https://accounts.spotify.com'
const API_URL = 'https://api.spotify.com/v1'
const TOKEN_KEY = 'playback-atlas.spotify-token'
const VERIFIER_KEY = 'playback-atlas.pkce-verifier'
const STATE_KEY = 'playback-atlas.oauth-state'
const ARTIST_PROFILE_KEY = 'playback-atlas.artist-profiles'
const ARTIST_PROFILE_TTL = 30 * 24 * 60 * 60 * 1000

interface StoredToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
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

interface SpotifyOEmbedResponse {
  thumbnail_url?: string
}

interface SpotifyInsightTrack {
  uri: string
  name: string
  duration_ms: number
  explicit: boolean
  external_urls: { spotify: string }
  album: {
    id: string
    name: string
    release_date: string
    images: Array<{ url: string; width: number | null; height: number | null }>
  }
  artists: Array<{ id: string; name: string }>
}

interface SpotifyArtistMetadata {
  id: string
  name: string
  external_urls: { spotify: string }
  images: Array<{ url: string; width: number | null; height: number | null }>
}

interface SpotifyPlaylist {
  id: string
  name: string
}

interface SpotifyPlaylistItem {
  track?: { uri?: string } | null
  item?: { uri?: string } | null
}

interface SpotifyPage<T> {
  items: T[]
}

interface SpotifyRecentPlay {
  played_at: string
  context: { type?: string; external_urls?: { spotify?: string } } | null
  track: SpotifyInsightTrack
}

export interface SpotifySession {
  displayName: string
  tasteProfileReady: boolean
}

export interface CreatedPlaylist {
  name: string
  url: string
  trackCount: number
}

export interface SpotifyArtistProfile {
  imageUrl: string | null
  url: string
}

export interface InsightEnrichment {
  ranges: Array<{
    key: 'short_term' | 'medium_term' | 'long_term'
    label: string
    artists: Array<{ name: string; imageUrl: string | null; url: string }>
    tracks: Array<{ name: string; artist: string; imageUrl: string | null; url: string; uri: string }>
  }>
  recent: Array<{ name: string; artist: string; playedAt: string; imageUrl: string | null; url: string }>
  recentContexts: Array<{ name: string; count: number }>
  discoveryPercent: number
  archiveOverlapPercent: number
  affinityContinuityPercent: number
  savedFavoritesPercent: number | null
  savedAlbumsPercent: number | null
  followedArtistsPercent: number | null
  playlistCoveragePercent: number | null
  explicitPercent: number
  releaseEras: Array<{ label: string; count: number }>
  notices: string[]
}

const artworkCache = new Map<string, string>()
const PROFILE_SCOPES = [
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
  'user-follow-read',
  'playlist-read-private',
  'playlist-read-collaborative',
]
const profileRequestCache = new Map<string, Promise<unknown>>()
const artistProfileCache = new Map<string, { profile: SpotifyArtistProfile; fetchedAt: number }>()
let topArtistSeed: Promise<void> | null = null
let apiPausedUntil = 0

try {
  const stored = localStorage.getItem(ARTIST_PROFILE_KEY)
  if (stored) {
    const entries = JSON.parse(stored) as Array<[string, { profile: SpotifyArtistProfile; fetchedAt: number }]>
    entries.forEach(([name, entry]) => {
      if (Date.now() - entry.fetchedAt < ARTIST_PROFILE_TTL) artistProfileCache.set(name, entry)
    })
  }
} catch {
  // Persistent profile caching is optional.
}

function normalizedArtistName(name: string) {
  return name.trim().toLocaleLowerCase()
}

function persistArtistProfiles() {
  try {
    localStorage.setItem(ARTIST_PROFILE_KEY, JSON.stringify([...artistProfileCache.entries()].slice(-500)))
  } catch {
    // Storage can be unavailable in restrictive browser modes.
  }
}

function cacheArtistProfile(name: string, profile: SpotifyArtistProfile, persist = true) {
  artistProfileCache.set(normalizedArtistName(name), { profile, fetchedAt: Date.now() })
  if (persist) persistArtistProfiles()
}

function configuration() {
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID?.trim()
  const configuredRedirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI?.trim()
  const runtimeRedirectUri = new URL(import.meta.env.BASE_URL, window.location.origin)
  let redirectUri = runtimeRedirectUri.toString()

  if (configuredRedirectUri) {
    const configuredUrl = new URL(configuredRedirectUri)
    const isSameRuntimeLocation = configuredUrl.protocol === runtimeRedirectUri.protocol
      && configuredUrl.hostname.toLowerCase() === runtimeRedirectUri.hostname.toLowerCase()
      && configuredUrl.port === runtimeRedirectUri.port
      && configuredUrl.pathname === runtimeRedirectUri.pathname
      && configuredUrl.search === runtimeRedirectUri.search
      && configuredUrl.hash === runtimeRedirectUri.hash
    redirectUri = isSameRuntimeLocation ? runtimeRedirectUri.toString() : configuredUrl.toString()
  }

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

function storeToken(response: TokenResponse, previousRefreshToken?: string, previousScope?: string) {
  const token: StoredToken = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token || previousRefreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
    scope: response.scope || previousScope,
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
  if (!response.ok) {
    const details = await response.json().catch(() => null) as { error?: string; error_description?: string } | null
    throw new Error(details?.error_description || details?.error || `Spotify authorization failed (${response.status}).`)
  }
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
  return storeToken(response, token.refreshToken, token.scope).accessToken
}

async function api<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
  const pause = apiPausedUntil - Date.now()
  if (pause > 0) await new Promise((resolve) => window.setTimeout(resolve, pause))
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
    apiPausedUntil = Math.max(apiPausedUntil, Date.now() + retryAfter * 1000)
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

function cachedProfileApi<T>(path: string) {
  const cached = profileRequestCache.get(path)
  if (cached) return cached as Promise<T>
  const request = api<T>(path).catch((reason) => {
    profileRequestCache.delete(path)
    throw reason
  })
  profileRequestCache.set(path, request)
  return request
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
    scope: `playlist-modify-public playlist-modify-private ${PROFILE_SCOPES.join(' ')}`,
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
  if (error) {
    localStorage.removeItem(VERIFIER_KEY)
    sessionStorage.removeItem(STATE_KEY)
    window.history.replaceState({}, '', window.location.pathname)
    throw new Error(`Spotify authorization was declined: ${error}`)
  }
  if (!code) return false

  const verifier = localStorage.getItem(VERIFIER_KEY)
  const expectedState = sessionStorage.getItem(STATE_KEY)
  if (!verifier || !expectedState || params.get('state') !== expectedState) {
    localStorage.removeItem(VERIFIER_KEY)
    sessionStorage.removeItem(STATE_KEY)
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
  const token = readToken()
  if (!token) return null
  try {
    const user = await api<SpotifyUser>('/me')
    const scopes = new Set(token.scope?.split(' ') || [])
    return {
      displayName: user.display_name || user.id,
      tasteProfileReady: PROFILE_SCOPES.every((scope) => scopes.has(scope)),
    }
  } catch {
    return null
  }
}

export function disconnectSpotify() {
  localStorage.removeItem(TOKEN_KEY)
  profileRequestCache.clear()
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
  const missingUris = validUris.filter((uri) => !artworkCache.has(uri))
  await fetchPublicArtwork(missingUris)

  return Object.fromEntries(
    validUris.flatMap((uri) => {
      const artwork = artworkCache.get(uri)
      return artwork ? [[uri, artwork]] : []
    }),
  ) as Record<string, string>
}

async function seedTopArtistProfiles() {
  if (topArtistSeed) return topArtistSeed
  const scopes = new Set(readToken()?.scope?.split(' ') || [])
  if (!scopes.has('user-top-read')) return

  topArtistSeed = cachedProfileApi<SpotifyPage<SpotifyArtistMetadata>>('/me/top/artists?time_range=long_term&limit=50')
    .then((response) => {
      response.items.forEach((artist) => cacheArtistProfile(artist.name, {
        imageUrl: artist.images[0]?.url || null,
        url: artist.external_urls.spotify,
      }, false))
      persistArtistProfiles()
    })
    .catch(() => undefined)
  return topArtistSeed
}

export async function getArtistProfiles(
  artists: Array<{ artistName: string }>,
  onProfile?: (artistName: string, profile: SpotifyArtistProfile) => void,
  signal?: AbortSignal,
) {
  if (!readToken()) return {} as Record<string, SpotifyArtistProfile>
  if (!artists.length) return {} as Record<string, SpotifyArtistProfile>

  const entries: Array<readonly [string, SpotifyArtistProfile] | null> = Array(artists.length).fill(null)
  const unresolved = new Set<number>()
  artists.forEach(({ artistName }, index) => {
    const cached = artistProfileCache.get(normalizedArtistName(artistName))
    if (cached && Date.now() - cached.fetchedAt < ARTIST_PROFILE_TTL) {
      entries[index] = [artistName, cached.profile]
      onProfile?.(artistName, cached.profile)
    } else {
      unresolved.add(index)
    }
  })

  await seedTopArtistProfiles()
  unresolved.forEach((index) => {
    const artistName = artists[index].artistName
    const cached = artistProfileCache.get(normalizedArtistName(artistName))
    if (cached) {
      entries[index] = [artistName, cached.profile]
      unresolved.delete(index)
      onProfile?.(artistName, cached.profile)
    }
  })

  const pending = [...unresolved]
  let nextIndex = 0

  async function worker() {
    while (nextIndex < pending.length && !signal?.aborted) {
      const index = pending[nextIndex]
      nextIndex += 1
      const { artistName } = artists[index]
      try {
        const params = new URLSearchParams({ q: `artist:${artistName}`, type: 'artist', limit: '3' })
        const response = await api<{ artists: SpotifyPage<SpotifyArtistMetadata> }>(`/search?${params}`, { signal })
        const metadata = response.artists.items.find((item) => item.name.localeCompare(artistName, undefined, { sensitivity: 'base' }) === 0)
          || response.artists.items[0]
        if (!metadata) continue
        const profile = {
          imageUrl: metadata.images[0]?.url || null,
          url: metadata.external_urls.spotify,
        }
        entries[index] = [artistName, profile]
        cacheArtistProfile(artistName, profile)
        onProfile?.(artistName, profile)
      } catch {
        // Artist artwork is optional; the ranking keeps its local placeholder.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()))

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, SpotifyArtistProfile] => Boolean(entry)))
}

export async function getInsightEnrichment(uris: string[]): Promise<InsightEnrichment> {
  const archiveUris = new Set(uris.filter((uri) => /^spotify:track:[A-Za-z0-9]+$/.test(uri)))
  const rangeDefinitions = [
    { key: 'short_term' as const, label: 'Last 4 weeks' },
    { key: 'medium_term' as const, label: 'Last 6 months' },
    { key: 'long_term' as const, label: 'Long term' },
  ]
  const notices: string[] = []

  const rangeResults = await Promise.all(rangeDefinitions.map(async (range) => {
    try {
      const [artists, tracks] = await Promise.all([
        cachedProfileApi<SpotifyPage<SpotifyArtistMetadata>>(`/me/top/artists?time_range=${range.key}&limit=20`),
        cachedProfileApi<SpotifyPage<SpotifyInsightTrack>>(`/me/top/tracks?time_range=${range.key}&limit=20`),
      ])
      return {
        ...range,
        artistItems: Array.isArray(artists?.items) ? artists.items : [],
        trackItems: Array.isArray(tracks?.items) ? tracks.items : [],
      }
    } catch {
      notices.push(`${range.label} affinity is unavailable.`)
      return { ...range, artistItems: [], trackItems: [] }
    }
  }))

  let recentItems: SpotifyRecentPlay[] = []
  try {
    const response = await cachedProfileApi<SpotifyPage<SpotifyRecentPlay>>('/me/player/recently-played?limit=50')
    recentItems = Array.isArray(response?.items) ? response.items : []
    if (!Array.isArray(response?.items)) notices.push('Recent listening returned no playable items.')
  } catch {
    notices.push('Recent listening is unavailable.')
  }

  const profileTracks = [...new Map(rangeResults.flatMap((range) => range.trackItems).map((track) => [track.uri, track])).values()]
  const profileArtists = [...new Map(rangeResults.flatMap((range) => range.artistItems).map((artist) => [artist.id, artist])).values()]
  const profileAlbums = [...new Map(profileTracks.map((track) => [track.album.id, track.album])).values()]
  const shortUris = new Set(rangeResults.find((range) => range.key === 'short_term')?.trackItems.map((track) => track.uri) || [])
  const longUris = new Set(rangeResults.find((range) => range.key === 'long_term')?.trackItems.map((track) => track.uri) || [])
  const continuity = [...shortUris].filter((uri) => longUris.has(uri)).length

  async function contains(path: string, ids: string[]) {
    if (!ids.length) return []
    return cachedProfileApi<boolean[]>(`${path}?ids=${encodeURIComponent(ids.slice(0, 50).join(','))}`)
  }

  const [savedTracksResult, savedAlbumsResult, playlistsResult] = await Promise.allSettled([
    contains('/me/tracks/contains', profileTracks.map((track) => track.uri.slice('spotify:track:'.length))),
    contains('/me/albums/contains', profileAlbums.map((album) => album.id)),
    cachedProfileApi<SpotifyPage<SpotifyPlaylist>>('/me/playlists?limit=8'),
  ])

  // The following endpoint also requires its resource type alongside the IDs.
  let followedArtists: boolean[] | null = null
  if (profileArtists.length) {
    try {
      followedArtists = await cachedProfileApi<boolean[]>(`/me/following/contains?type=artist&ids=${encodeURIComponent(profileArtists.slice(0, 50).map((artist) => artist.id).join(','))}`)
    } catch {
      notices.push('Followed-artist coverage is unavailable.')
    }
  }
  const savedTracks = savedTracksResult.status === 'fulfilled' ? savedTracksResult.value : null
  const savedAlbums = savedAlbumsResult.status === 'fulfilled' ? savedAlbumsResult.value : null
  if (!savedTracks) notices.push('Saved-track coverage is unavailable.')
  if (!savedAlbums) notices.push('Saved-album coverage is unavailable.')

  let playlistCoverage: number | null = null
  if (playlistsResult.status === 'fulfilled' && playlistsResult.value.items.length && profileTracks.length) {
    const sampledPlaylists = playlistsResult.value.items.slice(0, 8)
    const playlistItems = await Promise.allSettled(sampledPlaylists.map((playlist) =>
      cachedProfileApi<SpotifyPage<SpotifyPlaylistItem>>(`/playlists/${encodeURIComponent(playlist.id)}/items?limit=100`),
    ))
    const playlistUris = new Set(playlistItems.flatMap((item) => item.status === 'fulfilled'
      ? item.value.items.flatMap((entry) => entry.item?.uri || entry.track?.uri ? [entry.item?.uri || entry.track?.uri] : [])
      : []))
    playlistCoverage = Math.round((profileTracks.filter((track) => playlistUris.has(track.uri)).length / profileTracks.length) * 100)
    notices.push(`Playlist coverage samples ${sampledPlaylists.length} playlists with up to 100 items each.`)
  } else if (playlistsResult.status === 'rejected') {
    notices.push('Playlist coverage is unavailable.')
  }

  const releaseEraCounts = new Map<string, number>()
  profileTracks.forEach((track) => {
    const year = Number(track.album.release_date.slice(0, 4))
    const label = Number.isFinite(year) ? `${Math.floor(year / 10) * 10}s` : 'Unknown'
    releaseEraCounts.set(label, (releaseEraCounts.get(label) || 0) + 1)
  })

  const contextCounts = new Map<string, number>()
  recentItems.forEach((item) => {
    const context = item.context?.type || 'direct play'
    contextCounts.set(context, (contextCounts.get(context) || 0) + 1)
  })
  const discovered = recentItems.filter((item) => !archiveUris.has(item.track.uri)).length
  const overlap = profileTracks.filter((track) => archiveUris.has(track.uri)).length

  return {
    ranges: rangeResults.map((range) => ({
      key: range.key,
      label: range.label,
      artists: range.artistItems.slice(0, 10).map((artist) => ({
        name: artist.name,
        imageUrl: artist.images[0]?.url || null,
        url: artist.external_urls.spotify,
      })),
      tracks: range.trackItems.slice(0, 10).map((track) => ({
        name: track.name,
        artist: track.artists.map((artist) => artist.name).join(', '),
        imageUrl: track.album.images[0]?.url || null,
        url: track.external_urls.spotify,
        uri: track.uri,
      })),
    })),
    recent: recentItems.slice(0, 10).map((item) => ({
      name: item.track.name,
      artist: item.track.artists.map((artist) => artist.name).join(', '),
      playedAt: item.played_at,
      imageUrl: item.track.album.images[0]?.url || null,
      url: item.track.external_urls.spotify,
    })),
    recentContexts: [...contextCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    discoveryPercent: recentItems.length ? Math.round((discovered / recentItems.length) * 100) : 0,
    archiveOverlapPercent: profileTracks.length ? Math.round((overlap / profileTracks.length) * 100) : 0,
    affinityContinuityPercent: shortUris.size ? Math.round((continuity / shortUris.size) * 100) : 0,
    savedFavoritesPercent: savedTracks?.length ? Math.round((savedTracks.filter(Boolean).length / savedTracks.length) * 100) : null,
    savedAlbumsPercent: savedAlbums?.length ? Math.round((savedAlbums.filter(Boolean).length / savedAlbums.length) * 100) : null,
    followedArtistsPercent: followedArtists?.length ? Math.round((followedArtists.filter(Boolean).length / followedArtists.length) * 100) : null,
    playlistCoveragePercent: playlistCoverage,
    explicitPercent: profileTracks.length ? Math.round((profileTracks.filter((track) => track.explicit).length / profileTracks.length) * 100) : 0,
    releaseEras: [...releaseEraCounts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    notices,
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

  const playlist = await api<{ id: string; name: string; external_urls: { spotify: string } }>(
    '/me/playlists',
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
