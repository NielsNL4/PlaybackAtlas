#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const API_URL = 'https://api.spotify.com/v1'
const ACCOUNTS_URL = 'https://accounts.spotify.com/api/token'
const DEFAULT_COUNT = 100
const SEARCHES = [
  'genre:pop',
  'genre:rock',
  'genre:hip-hop',
  'genre:indie',
  'genre:electronic',
  'genre:jazz',
  'genre:soul',
  'genre:classical',
  'genre:country',
  'genre:metal',
]

function parseArguments(arguments_) {
  const options = {
    year: new Date().getUTCFullYear() - 1,
    count: DEFAULT_COUNT,
    output: 'test-data/Streaming_History_Audio_Test.json',
  }

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    const value = arguments_[index + 1]
    if (argument === '--year' && value) options.year = Number(value)
    else if (argument === '--count' && value) options.count = Number(value)
    else if (argument === '--output' && value) options.output = value
    else if (argument === '--help') {
      console.log(`Usage: npm run generate:test-history -- [options]

Options:
  --year 2025       Calendar year across which plays are distributed
  --count 100       Number of unique real Spotify tracks/play records
  --output FILE     JSON destination

Authentication:
  Set SPOTIFY_ACCESS_TOKEN, or set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.`)
      process.exit(0)
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown or incomplete option: ${argument}`)
    } else {
      continue
    }
    index += 1
  }

  const currentYear = new Date().getUTCFullYear()
  if (!Number.isInteger(options.year) || options.year < 2008 || options.year > currentYear) {
    throw new Error(`--year must be an integer from 2008 through ${currentYear}.`)
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 500) {
    throw new Error('--count must be an integer from 1 through 500.')
  }
  return options
}

async function getAccessToken() {
  if (process.env.SPOTIFY_ACCESS_TOKEN) return process.env.SPOTIFY_ACCESS_TOKEN

  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(
      'Set SPOTIFY_ACCESS_TOKEN, or both SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.',
    )
  }

  const response = await fetch(ACCOUNTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })
  if (!response.ok) {
    throw new Error(`Spotify token request failed (${response.status}): ${await response.text()}`)
  }
  const body = await response.json()
  return body.access_token
}

async function spotifyRequest(path, token, attempt = 0) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (response.status === 429 && attempt < 4) {
    const delaySeconds = Number(response.headers.get('retry-after') || 1)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delaySeconds * 1000))
    return spotifyRequest(path, token, attempt + 1)
  }
  if (!response.ok) {
    throw new Error(`Spotify API request failed (${response.status}): ${await response.text()}`)
  }
  return response.json()
}

async function fetchTracks(token, count) {
  const tracks = new Map()
  let searchIndex = 0
  let offset = 0

  while (tracks.size < count && searchIndex < SEARCHES.length * 3) {
    const query = SEARCHES[searchIndex % SEARCHES.length]
    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: '50',
      offset: String(offset),
      market: 'US',
    })
    const body = await spotifyRequest(`/search?${params}`, token)
    for (const track of body.tracks?.items || []) {
      if (track?.id && track.uri?.startsWith('spotify:track:') && track.album && track.artists?.length) {
        tracks.set(track.id, track)
        if (tracks.size === count) break
      }
    }

    searchIndex += 1
    if (searchIndex % SEARCHES.length === 0) offset += 50
  }

  if (tracks.size < count) {
    throw new Error(`Spotify returned only ${tracks.size} unique tracks; requested ${count}.`)
  }
  return [...tracks.values()]
}

function createHistory(tracks, year) {
  const start = Date.UTC(year, 0, 1, 8, 0, 0)
  const end = Date.UTC(year, 11, 31, 22, 0, 0)
  const platforms = [
    'android',
    'iOS 17.4 (iPhone)',
    'Windows 11 (Chrome)',
    'OS X 14.5 arm64',
  ]

  return tracks.map((track, index) => {
    const ratio = tracks.length === 1 ? 0 : index / (tracks.length - 1)
    const timestamp = new Date(start + Math.round((end - start) * ratio))
    const skipped = index % 11 === 0
    const duration = Number(track.duration_ms) || 180_000
    const msPlayed = skipped
      ? 7_000 + (index * 997) % 16_000
      : Math.max(30_000, duration - (index * 379) % 9_000)

    return {
      ts: timestamp.toISOString(),
      platform: platforms[index % platforms.length],
      ms_played: Math.min(msPlayed, duration),
      conn_country: 'US',
      ip_addr: '0.0.0.0',
      master_metadata_track_name: track.name,
      master_metadata_album_artist_name: track.artists.map((artist) => artist.name).join(', '),
      master_metadata_album_album_name: track.album.name,
      spotify_track_uri: track.uri,
      episode_name: null,
      episode_show_name: null,
      spotify_episode_uri: null,
      audiobook_title: null,
      audiobook_uri: null,
      audiobook_chapter_uri: null,
      audiobook_chapter_title: null,
      reason_start: index === 0 ? 'clickrow' : index % 9 === 0 ? 'fwdbtn' : 'trackdone',
      reason_end: skipped ? 'fwdbtn' : index % 13 === 0 ? 'endplay' : 'trackdone',
      shuffle: index % 3 === 0,
      skipped,
      offline: index % 8 === 0,
      offline_timestamp: index % 8 === 0 ? timestamp.getTime() - 60_000 : 0,
      incognito_mode: false,
    }
  })
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const token = await getAccessToken()
  console.log(`Fetching ${options.count} real tracks from Spotify...`)
  const tracks = await fetchTracks(token, options.count)
  const history = createHistory(tracks, options.year)
  const output = resolve(options.output)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(history, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${history.length} records across ${options.year} to ${output}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
