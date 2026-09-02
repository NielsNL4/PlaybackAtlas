/// <reference lib="webworker" />

import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { AnalyticsResult, IngestResult, InsightQuery, InsightResult, PlaylistRankingRequest, PlaylistRankingResult, QueryFilters } from '../types'

type WorkerRequest =
  | { id: number; type: 'ingest'; files: File[] }
  | { id: number; type: 'query'; filters: QueryFilters }
  | { id: number; type: 'playlist'; request: PlaylistRankingRequest }
  | { id: number; type: 'insights'; request: InsightQuery }

type WorkerResponse =
  | { id: number; type: 'result'; result: IngestResult | AnalyticsResult | PlaylistRankingResult | InsightResult }
  | { id: number; type: 'progress'; progress: number; label: string }
  | { id: number; type: 'error'; error: string }

const context = self as DedicatedWorkerGlobalScope
let database: duckdb.AsyncDuckDB | null = null
let connection: AsyncDuckDBConnection | null = null
let registeredFiles: string[] = []
let requestQueue = Promise.resolve()

function post(message: WorkerResponse) {
  context.postMessage(message)
}

async function getConnection() {
  if (connection) return connection

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)
  database = new duckdb.AsyncDuckDB(logger, new Worker(duckdbWorkerUrl))
  await database.instantiate(duckdbWasmUrl)
  connection = await database.connect()
  return connection
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function firstColumn(columns: Set<string>, candidates: string[]) {
  const column = candidates.find((candidate) => columns.has(candidate))
  return column ? quoteIdentifier(column) : 'NULL'
}

function sqlDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date: ${value}`)
  return `'${value}'`
}

function sqlInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

async function ingest(id: number, files: File[]): Promise<IngestResult> {
  const conn = await getConnection()

  for (const oldFile of registeredFiles) await database!.dropFile(oldFile)
  registeredFiles = []
  await conn.query('DROP TABLE IF EXISTS listening_history; DROP TABLE IF EXISTS raw_history;')

  for (let index = 0; index < files.length; index += 1) {
    const registeredName = `spotify_history_${index}.json`
    const bytes = new Uint8Array(await files[index].arrayBuffer())
    await database!.registerFileBuffer(registeredName, bytes)
    registeredFiles.push(registeredName)
    post({
      id,
      type: 'progress',
      progress: Math.round(((index + 1) / files.length) * 55),
      label: `Loading ${index + 1} of ${files.length}`,
    })
  }

  const fileList = registeredFiles.map((name) => `'${name}'`).join(', ')
  await conn.query(`
    CREATE TABLE raw_history AS
    SELECT * FROM read_json_auto(
      [${fileList}],
      format = 'array',
      union_by_name = true,
      maximum_object_size = 16777216
    );
  `)

  post({ id, type: 'progress', progress: 72, label: 'Normalizing history' })
  const description = await conn.query('DESCRIBE raw_history')
  const columns = new Set(
    description.toArray().map((row) => String(row.column_name)),
  )
  const timestamp = firstColumn(columns, ['ts', 'endTime'])
  const track = firstColumn(columns, ['master_metadata_track_name', 'trackName'])
  const artist = firstColumn(columns, ['master_metadata_album_artist_name', 'artistName'])
  const album = firstColumn(columns, ['master_metadata_album_album_name', 'albumName'])
  const played = firstColumn(columns, ['ms_played', 'msPlayed'])
  const uri = firstColumn(columns, ['spotify_track_uri'])
  const skipped = firstColumn(columns, ['skipped'])
  const shuffle = firstColumn(columns, ['shuffle'])
  const platform = firstColumn(columns, ['platform'])
  const offline = firstColumn(columns, ['offline'])
  const reasonStart = firstColumn(columns, ['reason_start'])
  const reasonEnd = firstColumn(columns, ['reason_end'])

  if (timestamp === 'NULL' || track === 'NULL' || artist === 'NULL' || played === 'NULL') {
    throw new Error('These files do not contain recognized Spotify streaming history fields.')
  }

  await conn.query(`
    CREATE TABLE listening_history AS
    WITH normalized AS (
      SELECT
        try_cast(${timestamp} AS TIMESTAMP) AS played_at,
        cast(${track} AS VARCHAR) AS track_name,
        cast(${artist} AS VARCHAR) AS artist_name,
        try_cast(${album} AS VARCHAR) AS album_name,
        try_cast(${uri} AS VARCHAR) AS spotify_track_uri,
        coalesce(try_cast(${played} AS BIGINT), 0) AS ms_played,
        coalesce(try_cast(${skipped} AS BOOLEAN), false) AS skipped,
        coalesce(try_cast(${shuffle} AS BOOLEAN), false) AS shuffle,
        try_cast(${platform} AS VARCHAR) AS platform,
        coalesce(try_cast(${offline} AS BOOLEAN), false) AS offline,
        try_cast(${reasonStart} AS VARCHAR) AS reason_start,
        try_cast(${reasonEnd} AS VARCHAR) AS reason_end
      FROM raw_history
      WHERE try_cast(${timestamp} AS TIMESTAMP) IS NOT NULL
        AND ${track} IS NOT NULL
        AND ${artist} IS NOT NULL
    )
    SELECT
      *,
      row_number() OVER (
        PARTITION BY coalesce(spotify_track_uri, artist_name || chr(0) || track_name)
        ORDER BY played_at
      ) = 1 AS is_first_play
    FROM normalized;
  `)

  post({ id, type: 'progress', progress: 90, label: 'Building analytics index' })
  await conn.query('CREATE INDEX history_date_idx ON listening_history (played_at);')
  const summary = await conn.query(`
    SELECT
      count(*)::DOUBLE AS row_count,
      strftime(min(played_at), '%Y-%m-%d') AS min_date,
      strftime(max(played_at), '%Y-%m-%d') AS max_date
    FROM listening_history;
  `)
  const row = summary.toArray()[0]
  const rowCount = Number(row.row_count)
  if (!rowCount) throw new Error('No valid playback records were found in these files.')

  post({ id, type: 'progress', progress: 100, label: 'Ready' })
  return {
    rowCount,
    bounds: { min: String(row.min_date), max: String(row.max_date) },
  }
}

async function queryTracks(filters: QueryFilters): Promise<AnalyticsResult> {
  const conn = await getConnection()
  const orderBy = filters.metric === 'plays' ? 'play_count' : 'total_ms'
  const startDate = sqlDate(filters.startDate)
  const endDate = sqlDate(filters.endDate)
  const minMs = sqlInteger(filters.minMs, 30_000, 86_400_000, 'minimum playback duration')
  const pageNumber = sqlInteger(filters.page, 1, 1_000_000, 'page')
  await conn.query(`
    CREATE OR REPLACE TEMP TABLE ranked_tracks AS
    WITH aggregated AS (
      SELECT
        track_name,
        artist_name,
        album_name,
        spotify_track_uri,
        count(*)::DOUBLE AS play_count,
        sum(ms_played)::DOUBLE AS total_ms
      FROM listening_history
      WHERE played_at >= try_cast(${startDate} AS DATE)
        AND played_at < try_cast(${endDate} AS DATE) + INTERVAL 1 DAY
        AND ms_played >= ${minMs}
      GROUP BY track_name, artist_name, album_name, spotify_track_uri
    )
    SELECT
      row_number() OVER (ORDER BY ${orderBy} DESC, track_name ASC)::DOUBLE AS rank,
      *
    FROM aggregated;
  `)

  const offset = (pageNumber - 1) * 50
  const page = await conn.query(
    `SELECT * FROM ranked_tracks WHERE rank > ${offset} AND rank <= ${offset + 50} ORDER BY rank;`,
  )
  const summary = await conn.query('SELECT count(*)::DOUBLE AS total_tracks FROM ranked_tracks;')
  return {
    tracks: page.toArray().map((row) => ({
      rank: Number(row.rank),
      trackName: String(row.track_name),
      artistName: String(row.artist_name),
      albumName: row.album_name == null ? null : String(row.album_name),
      spotifyTrackUri: row.spotify_track_uri == null ? null : String(row.spotify_track_uri),
      playCount: Number(row.play_count),
      totalMs: Number(row.total_ms),
    })),
    artists: [],
    totalResults: Number(summary.toArray()[0].total_tracks),
  }
}

async function queryArtists(filters: QueryFilters): Promise<AnalyticsResult> {
  const conn = await getConnection()
  const orderBy = filters.metric === 'plays' ? 'play_count' : 'total_ms'
  const startDate = sqlDate(filters.startDate)
  const endDate = sqlDate(filters.endDate)
  const minMs = sqlInteger(filters.minMs, 30_000, 86_400_000, 'minimum playback duration')
  const pageNumber = sqlInteger(filters.page, 1, 1_000_000, 'page')
  await conn.query(`
    CREATE OR REPLACE TEMP TABLE ranked_artists AS
    WITH aggregated AS (
      SELECT
        artist_name,
        count(DISTINCT coalesce(spotify_track_uri, artist_name || chr(0) || track_name))::DOUBLE AS unique_tracks,
        count(*)::DOUBLE AS play_count,
        sum(ms_played)::DOUBLE AS total_ms
      FROM listening_history
      WHERE played_at >= try_cast(${startDate} AS DATE)
        AND played_at < try_cast(${endDate} AS DATE) + INTERVAL 1 DAY
        AND ms_played >= ${minMs}
      GROUP BY artist_name
    )
    SELECT
      row_number() OVER (ORDER BY ${orderBy} DESC, artist_name ASC)::DOUBLE AS rank,
      *
    FROM aggregated;
  `)

  const offset = (pageNumber - 1) * 50
  const page = await conn.query(
    `SELECT * FROM ranked_artists WHERE rank > ${offset} AND rank <= ${offset + 50} ORDER BY rank;`,
  )
  const summary = await conn.query('SELECT count(*)::DOUBLE AS total_artists FROM ranked_artists;')
  return {
    tracks: [],
    artists: page.toArray().map((row) => ({
      rank: Number(row.rank),
      artistName: String(row.artist_name),
      uniqueTracks: Number(row.unique_tracks),
      playCount: Number(row.play_count),
      totalMs: Number(row.total_ms),
    })),
    totalResults: Number(summary.toArray()[0].total_artists),
  }
}

async function queryPlaylist(request: PlaylistRankingRequest): Promise<PlaylistRankingResult> {
  const conn = await getConnection()
  const minMs = sqlInteger(request.minMs, 30_000, 86_400_000, 'minimum playback duration')
  const statement = await conn.prepare(`
    SELECT spotify_track_uri
    FROM listening_history
    WHERE played_at >= try_cast(? AS DATE)
      AND played_at < try_cast(? AS DATE) + INTERVAL 1 DAY
      AND ms_played >= ?
      AND spotify_track_uri LIKE 'spotify:track:%'
    GROUP BY spotify_track_uri
    ORDER BY count(*) DESC, sum(ms_played) DESC, spotify_track_uri ASC
    LIMIT ?;
  `)

  try {
    const result = await statement.query(
      request.startDate,
      request.endDate,
      minMs,
      request.limit,
    )
    return { spotifyTrackUris: result.toArray().map((row) => String(row.spotify_track_uri)) }
  } finally {
    await statement.close()
  }
}

async function queryInsights(request: InsightQuery): Promise<InsightResult> {
  const conn = await getConnection()
  const granularity = ['day', 'week', 'month'].includes(request.granularity)
    ? request.granularity
    : 'month'
  const metricOrder = request.metric === 'duration' ? 'total_ms' : 'plays'
  const startDate = sqlDate(request.startDate)
  const endDate = sqlDate(request.endDate)
  const minMs = sqlInteger(request.minMs, 30_000, 86_400_000, 'minimum playback duration')
  const timezoneOffset = sqlInteger(request.timezoneOffsetMinutes, -1_440, 1_440, 'timezone offset')
  await conn.query(`
    CREATE OR REPLACE TEMP TABLE insight_events AS
    WITH localized AS (
      SELECT
        *,
        played_at + (${timezoneOffset} * INTERVAL 1 MINUTE) AS local_at
      FROM listening_history
    )
    SELECT
      date_trunc('${granularity}', local_at) AS period,
      extract(dow FROM local_at)::INTEGER AS weekday,
      extract(hour FROM local_at)::INTEGER AS hour,
      *
    FROM localized
    WHERE local_at >= try_cast(${startDate} AS DATE)
      AND local_at < try_cast(${endDate} AS DATE) + INTERVAL 1 DAY
      AND ms_played >= ${minMs};
  `)

  const summaryResult = await conn.query(`
    SELECT
      count(*)::DOUBLE AS total_plays,
      coalesce(sum(ms_played), 0)::DOUBLE AS total_ms,
      count(DISTINCT coalesce(spotify_track_uri, artist_name || '::' || track_name))::DOUBLE AS unique_tracks,
      count(DISTINCT artist_name)::DOUBLE AS unique_artists
    FROM insight_events;
  `)
  const volumeResult = await conn.query(`
    SELECT
      strftime(period, '%Y-%m-%d') AS period,
      count(*)::DOUBLE AS plays,
      coalesce(sum(ms_played), 0)::DOUBLE AS total_ms,
      count(DISTINCT coalesce(spotify_track_uri, artist_name || '::' || track_name))::DOUBLE AS unique_tracks,
      count(DISTINCT artist_name)::DOUBLE AS unique_artists
    FROM insight_events
    GROUP BY period
    ORDER BY period;
  `)
  const heatmapResult = await conn.query(`
    SELECT
      weekday::DOUBLE AS weekday,
      hour::DOUBLE AS hour,
      count(*)::DOUBLE AS plays,
      coalesce(sum(ms_played), 0)::DOUBLE AS total_ms
    FROM insight_events
    GROUP BY weekday, hour
    ORDER BY weekday, hour;
  `)
  const discoveryResult = await conn.query(`
    SELECT
      strftime(period, '%Y-%m-%d') AS period,
      count(*) FILTER (WHERE is_first_play)::DOUBLE AS first_plays,
      count(*) FILTER (WHERE NOT is_first_play)::DOUBLE AS repeat_plays
    FROM insight_events
    GROUP BY period
    ORDER BY period;
  `)
  const artistTotalsResult = await conn.query(`
    SELECT
      artist_name,
      count(*)::DOUBLE AS plays,
      coalesce(sum(ms_played), 0)::DOUBLE AS total_ms
    FROM insight_events
    GROUP BY artist_name
    ORDER BY ${metricOrder} DESC, artist_name ASC
    LIMIT 10;
  `)
  const artistTrendsResult = await conn.query(`
    WITH top_artists AS (
      SELECT artist_name
      FROM insight_events
      GROUP BY artist_name
      ORDER BY ${request.metric === 'duration' ? 'sum(ms_played)' : 'count(*)'} DESC, artist_name ASC
      LIMIT 10
    ), points AS (
      SELECT
        period,
        artist_name,
        count(*)::DOUBLE AS plays,
        coalesce(sum(ms_played), 0)::DOUBLE AS total_ms
      FROM insight_events
      WHERE artist_name IN (SELECT artist_name FROM top_artists)
      GROUP BY period, artist_name
    )
    SELECT
      strftime(period, '%Y-%m-%d') AS period,
      artist_name,
      plays,
      total_ms,
      row_number() OVER (PARTITION BY period ORDER BY ${metricOrder} DESC, artist_name ASC)::DOUBLE AS rank
    FROM points
    ORDER BY period, rank;
  `)
  const topTracksResult = await conn.query(`
    SELECT spotify_track_uri
    FROM insight_events
    WHERE spotify_track_uri LIKE 'spotify:track:%'
    GROUP BY spotify_track_uri
    ORDER BY ${request.metric === 'duration' ? 'sum(ms_played)' : 'count(*)'} DESC, spotify_track_uri ASC
    LIMIT 100;
  `)

  const summary = summaryResult.toArray()[0]
  return {
    summary: {
      totalPlays: Number(summary.total_plays),
      totalMs: Number(summary.total_ms),
      uniqueTracks: Number(summary.unique_tracks),
      uniqueArtists: Number(summary.unique_artists),
    },
    volume: volumeResult.toArray().map((row) => ({
      period: String(row.period),
      plays: Number(row.plays),
      totalMs: Number(row.total_ms),
      uniqueTracks: Number(row.unique_tracks),
      uniqueArtists: Number(row.unique_artists),
    })),
    heatmap: heatmapResult.toArray().map((row) => ({
      weekday: Number(row.weekday),
      hour: Number(row.hour),
      plays: Number(row.plays),
      totalMs: Number(row.total_ms),
    })),
    discovery: discoveryResult.toArray().map((row) => ({
      period: String(row.period),
      firstPlays: Number(row.first_plays),
      repeatPlays: Number(row.repeat_plays),
    })),
    artistTotals: artistTotalsResult.toArray().map((row) => ({
      artistName: String(row.artist_name),
      plays: Number(row.plays),
      totalMs: Number(row.total_ms),
    })),
    artistTrends: artistTrendsResult.toArray().map((row) => ({
      period: String(row.period),
      artistName: String(row.artist_name),
      plays: Number(row.plays),
      totalMs: Number(row.total_ms),
      rank: Number(row.rank),
    })),
    topTrackUris: topTracksResult.toArray().map((row) => String(row.spotify_track_uri)),
  }
}

async function handleRequest(data: WorkerRequest) {
  try {
    let result: IngestResult | AnalyticsResult | PlaylistRankingResult | InsightResult
    if (data.type === 'ingest') result = await ingest(data.id, data.files)
    else if (data.type === 'query') result = data.filters.ranking === 'artists'
      ? await queryArtists(data.filters)
      : await queryTracks(data.filters)
    else if (data.type === 'playlist') result = await queryPlaylist(data.request)
    else result = await queryInsights(data.request)
    post({ id: data.id, type: 'result', result })
  } catch (error) {
    post({
      id: data.id,
      type: 'error',
      error: error instanceof Error ? error.message : 'Unexpected analytics error',
    })
  }
}

context.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  requestQueue = requestQueue.then(() => handleRequest(data))
}

export {}
