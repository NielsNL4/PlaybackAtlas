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

function columnValue(columns: Set<string>, candidates: string[]) {
  const available = candidates.filter((candidate) => columns.has(candidate)).map(quoteIdentifier)
  if (available.length === 0) return 'NULL'
  if (available.length === 1) return available[0]
  return `coalesce(${available.join(', ')})`
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

function localTimestampSql(request: InsightQuery) {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(request.timezone)) {
    throw new Error(`Invalid timezone: ${request.timezone}`)
  }
  if (!request.timezoneTransitions.length || request.timezoneTransitions.length > 1_000) {
    throw new Error('Invalid timezone transition schedule.')
  }
  const transitions = request.timezoneTransitions.map((transition) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(transition.startsAt)) {
      throw new Error(`Invalid timezone transition: ${transition.startsAt}`)
    }
    return {
      startsAt: `'${transition.startsAt}'`,
      offsetMinutes: sqlInteger(transition.offsetMinutes, -1_440, 1_440, 'timezone offset'),
    }
  })
  const fallback = transitions[0].offsetMinutes
  const cases = transitions.slice(1).reverse().map((transition) => (
    `WHEN played_at >= try_cast(${transition.startsAt} AS TIMESTAMP) THEN ${transition.offsetMinutes}`
  )).join(' ')
  return `played_at + ((CASE ${cases} ELSE ${fallback} END) * INTERVAL 1 MINUTE)`
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
  const timestamp = columnValue(columns, ['ts', 'endTime'])
  const track = columnValue(columns, ['master_metadata_track_name', 'trackName'])
  const artist = columnValue(columns, ['master_metadata_album_artist_name', 'artistName'])
  const album = columnValue(columns, ['master_metadata_album_album_name', 'albumName'])
  const played = columnValue(columns, ['ms_played', 'msPlayed'])
  const uri = columnValue(columns, ['spotify_track_uri'])
  const skipped = columnValue(columns, ['skipped'])
  const shuffle = columnValue(columns, ['shuffle'])
  const platform = columnValue(columns, ['platform'])
  const offline = columnValue(columns, ['offline'])
  const reasonStart = columnValue(columns, ['reason_start'])
  const reasonEnd = columnValue(columns, ['reason_end'])

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
  await conn.query('DROP TABLE raw_history;')

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
  const aggregateOrder = request.metric === 'duration' ? 'sum(ms_played)' : 'count(*)'
  const startDate = sqlDate(request.startDate)
  const endDate = sqlDate(request.endDate)
  const minMs = sqlInteger(request.minMs, 30_000, 86_400_000, 'minimum playback duration')
  const localTimestamp = localTimestampSql(request)
  await conn.query(`
    CREATE OR REPLACE TEMP TABLE insight_streams AS
    WITH localized AS (
      SELECT
        *,
        ${localTimestamp} AS local_at
      FROM listening_history
    )
    SELECT
      date_trunc('${granularity}', local_at) AS period,
      extract(dow FROM local_at)::INTEGER AS weekday,
      extract(hour FROM local_at)::INTEGER AS hour,
      ms_played >= ${minMs} AS is_qualified,
      *
    FROM localized
    WHERE local_at >= try_cast(${startDate} AS DATE)
      AND local_at < try_cast(${endDate} AS DATE) + INTERVAL 1 DAY;

    CREATE OR REPLACE TEMP TABLE insight_events AS
    SELECT * FROM insight_streams WHERE is_qualified;
  `)

  const summaryResult = await conn.query(`
    SELECT
      count(*)::DOUBLE AS total_plays,
      coalesce(sum(ms_played), 0)::DOUBLE AS total_ms,
      count(DISTINCT coalesce(spotify_track_uri, artist_name || '::' || track_name))::DOUBLE AS unique_tracks,
      count(DISTINCT artist_name)::DOUBLE AS unique_artists
    FROM insight_events;
  `)
  const comparisonResult = await conn.query(`
    WITH localized AS (
      SELECT
        ${localTimestamp} AS local_at,
        ms_played
      FROM listening_history
    )
    SELECT
      count(*) FILTER (WHERE ms_played >= ${minMs})::DOUBLE AS previous_plays,
      coalesce(sum(ms_played) FILTER (WHERE ms_played >= ${minMs}), 0)::DOUBLE AS previous_ms
    FROM localized
    WHERE local_at >= try_cast(${startDate} AS DATE)
        - ((date_diff('day', try_cast(${startDate} AS DATE), try_cast(${endDate} AS DATE)) + 1) * INTERVAL 1 DAY)
      AND local_at < try_cast(${startDate} AS DATE);
  `)
  const totalStreamsResult = await conn.query(
    'SELECT count(*)::DOUBLE AS total_streams FROM insight_streams;',
  )
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
  const behaviorResult = await conn.query(`
    SELECT
      strftime(period, '%Y-%m-%d') AS period,
      count(*)::DOUBLE AS streams,
      count(*) FILTER (WHERE is_qualified)::DOUBLE AS qualified_plays,
      count(*) FILTER (WHERE reason_end = 'trackdone')::DOUBLE AS natural_ends,
      count(*) FILTER (
        WHERE coalesce(reason_end, '') != 'trackdone'
          AND (skipped OR ms_played < 30000 OR reason_end IN ('fwdbtn', 'backbtn'))
      )::DOUBLE AS early_exits,
      count(*) FILTER (
        WHERE coalesce(reason_end, '') != 'trackdone'
          AND NOT (skipped OR ms_played < 30000 OR coalesce(reason_end, '') IN ('fwdbtn', 'backbtn'))
      )::DOUBLE AS other_ends,
      count(*) FILTER (WHERE shuffle)::DOUBLE AS shuffled,
      count(*) FILTER (WHERE offline)::DOUBLE AS offline
    FROM insight_streams
    GROUP BY period
    ORDER BY period;
  `)
  const platformsResult = await conn.query(`
    SELECT
      coalesce(nullif(trim(platform), ''), 'Unknown') AS platform,
      count(*)::DOUBLE AS streams,
      coalesce(sum(ms_played), 0)::DOUBLE AS total_ms
    FROM insight_streams
    GROUP BY 1
    ORDER BY streams DESC, platform ASC
    LIMIT 12;
  `)
  await conn.query(`
    CREATE OR REPLACE TEMP TABLE insight_sessions AS
    WITH ordered AS (
      SELECT
        *,
        lag(local_at) OVER (ORDER BY local_at) AS previous_at
      FROM insight_streams
    ), marked AS (
      SELECT
        *,
        CASE
          WHEN previous_at IS NULL OR local_at - previous_at > INTERVAL 30 MINUTE THEN 1
          ELSE 0
        END AS starts_session
      FROM ordered
    ), grouped AS (
      SELECT
        *,
        sum(starts_session) OVER (ORDER BY local_at ROWS UNBOUNDED PRECEDING) AS session_id
      FROM marked
    )
    SELECT
      session_id,
      min(local_at) AS started_at,
      count(*)::DOUBLE AS streams,
      coalesce(sum(ms_played), 0)::DOUBLE AS total_ms,
      greatest(
        date_diff('millisecond', min(local_at), max(local_at)),
        max(ms_played)
      )::DOUBLE AS duration_ms
    FROM grouped
    GROUP BY session_id;
  `)
  const sessionSummaryResult = await conn.query(`
    SELECT
      count(*)::DOUBLE AS sessions,
      coalesce(avg(total_ms), 0)::DOUBLE AS average_session_ms,
      coalesce(max(duration_ms), 0)::DOUBLE AS longest_session_ms,
      coalesce(avg(streams), 0)::DOUBLE AS average_streams
    FROM insight_sessions;
  `)
  const longestSessionsResult = await conn.query(`
    SELECT
      strftime(started_at, '%Y-%m-%dT%H:%M:%S') AS started_at,
      streams,
      total_ms,
      duration_ms
    FROM insight_sessions
    ORDER BY duration_ms DESC, started_at ASC
    LIMIT 8;
  `)
  const retentionResult = await conn.query(`
    WITH history AS (
      SELECT
        coalesce(spotify_track_uri, artist_name || chr(0) || track_name) AS track_key,
        ${localTimestamp} AS local_at
      FROM listening_history
    ), discoveries AS (
      SELECT
        coalesce(spotify_track_uri, artist_name || chr(0) || track_name) AS track_key,
        local_at
      FROM insight_streams
      WHERE is_first_play
    ), latest AS (
      SELECT max(local_at) AS latest_at FROM history
    ), evaluated AS (
      SELECT
        discoveries.track_key,
        discoveries.local_at,
        latest.latest_at,
        count(history.local_at) FILTER (WHERE history.local_at > discoveries.local_at) AS later_plays,
        bool_or(
          history.local_at > discoveries.local_at
          AND history.local_at <= discoveries.local_at + INTERVAL 7 DAY
        ) AS retained_7_day,
        bool_or(
          history.local_at > discoveries.local_at
          AND history.local_at <= discoveries.local_at + INTERVAL 30 DAY
        ) AS retained_30_day
      FROM discoveries
      CROSS JOIN latest
      LEFT JOIN history ON history.track_key = discoveries.track_key
      GROUP BY discoveries.track_key, discoveries.local_at, latest.latest_at
    )
    SELECT
      count(*)::DOUBLE AS discoveries,
      count(*) FILTER (WHERE latest_at >= local_at + INTERVAL 7 DAY)::DOUBLE AS eligible_7_day,
      count(*) FILTER (
        WHERE latest_at >= local_at + INTERVAL 7 DAY AND coalesce(retained_7_day, false)
      )::DOUBLE AS retained_7_day,
      count(*) FILTER (WHERE latest_at >= local_at + INTERVAL 30 DAY)::DOUBLE AS eligible_30_day,
      count(*) FILTER (
        WHERE latest_at >= local_at + INTERVAL 30 DAY AND coalesce(retained_30_day, false)
      )::DOUBLE AS retained_30_day,
      count(*) FILTER (WHERE later_plays = 0)::DOUBLE AS one_and_done
    FROM evaluated;
  `)
  const rediscoveriesResult = await conn.query(`
    WITH ordered AS (
      SELECT
        track_name,
        artist_name,
        ${localTimestamp} AS local_at,
        lag(${localTimestamp}) OVER (
          PARTITION BY coalesce(spotify_track_uri, artist_name || chr(0) || track_name)
          ORDER BY played_at
        ) AS previous_at
      FROM listening_history
      WHERE ms_played >= ${minMs}
    )
    SELECT
      track_name,
      artist_name,
      date_diff('day', previous_at, local_at)::DOUBLE AS gap_days,
      strftime(local_at, '%Y-%m-%d') AS returned_at
    FROM ordered
    WHERE local_at >= try_cast(${startDate} AS DATE)
      AND local_at < try_cast(${endDate} AS DATE) + INTERVAL 1 DAY
      AND date_diff('day', previous_at, local_at) >= 90
    ORDER BY gap_days DESC, returned_at DESC, artist_name ASC, track_name ASC
    LIMIT 10;
  `)
  const albumTotalsResult = await conn.query(`
    WITH ordered AS (
      SELECT
        *,
        lag(album_name) OVER (ORDER BY local_at) AS previous_album,
        lag(artist_name) OVER (ORDER BY local_at) AS previous_artist,
        lag(local_at) OVER (ORDER BY local_at) AS previous_at
      FROM insight_events
      WHERE album_name IS NOT NULL AND trim(album_name) != ''
    ), marked AS (
      SELECT
        *,
        CASE
          WHEN previous_album IS NULL
            OR album_name != previous_album
            OR artist_name != previous_artist
            OR local_at - previous_at > INTERVAL 30 MINUTE
          THEN 1 ELSE 0
        END AS starts_run
      FROM ordered
    ), grouped AS (
      SELECT
        *,
        sum(starts_run) OVER (ORDER BY local_at ROWS UNBOUNDED PRECEDING) AS run_id
      FROM marked
    ), runs AS (
      SELECT album_name, artist_name, run_id, count(*) AS run_length
      FROM grouped
      GROUP BY album_name, artist_name, run_id
    ), longest_runs AS (
      SELECT album_name, artist_name, max(run_length)::DOUBLE AS longest_run
      FROM runs
      GROUP BY album_name, artist_name
    ), totals AS (
      SELECT
        album_name,
        artist_name,
        count(*)::DOUBLE AS plays,
        coalesce(sum(ms_played), 0)::DOUBLE AS total_ms,
        count(DISTINCT coalesce(spotify_track_uri, track_name))::DOUBLE AS unique_tracks
      FROM insight_events
      WHERE album_name IS NOT NULL AND trim(album_name) != ''
      GROUP BY album_name, artist_name
    )
    SELECT totals.*, longest_runs.longest_run
    FROM totals
    JOIN longest_runs USING (album_name, artist_name)
    ORDER BY ${metricOrder} DESC, album_name ASC, artist_name ASC
    LIMIT 12;
  `)
  const highlightsResult = await conn.query(`
    WITH daily AS (
      SELECT cast(local_at AS DATE) AS active_date, sum(ms_played) AS total_ms
      FROM insight_events
      GROUP BY active_date
    ), marked_days AS (
      SELECT
        active_date,
        CASE
          WHEN active_date - lag(active_date) OVER (ORDER BY active_date) = 1 THEN 0
          ELSE 1
        END AS starts_streak
      FROM daily
    ), grouped_days AS (
      SELECT
        active_date,
        sum(starts_streak) OVER (ORDER BY active_date ROWS UNBOUNDED PRECEDING) AS streak_id
      FROM marked_days
    ), streaks AS (
      SELECT count(*) AS streak_days FROM grouped_days GROUP BY streak_id
    ), top_track AS (
      SELECT track_name, artist_name
      FROM insight_events
      GROUP BY track_name, artist_name
      ORDER BY ${aggregateOrder} DESC, artist_name ASC, track_name ASC
      LIMIT 1
    ), top_album AS (
      SELECT album_name, artist_name
      FROM insight_events
      WHERE album_name IS NOT NULL AND trim(album_name) != ''
      GROUP BY album_name, artist_name
      ORDER BY ${aggregateOrder} DESC, artist_name ASC, album_name ASC
      LIMIT 1
    )
    SELECT
      (SELECT strftime(active_date, '%Y-%m-%d') FROM daily ORDER BY total_ms DESC, active_date ASC LIMIT 1) AS busiest_date,
      coalesce((SELECT total_ms FROM daily ORDER BY total_ms DESC, active_date ASC LIMIT 1), 0)::DOUBLE AS busiest_date_ms,
      coalesce((SELECT max(streak_days) FROM streaks), 0)::DOUBLE AS longest_streak_days,
      (SELECT track_name FROM top_track) AS top_track_name,
      (SELECT artist_name FROM top_track) AS top_track_artist,
      (SELECT album_name FROM top_album) AS top_album_name,
      (SELECT artist_name FROM top_album) AS top_album_artist;
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
      ORDER BY ${aggregateOrder} DESC, artist_name ASC
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
    ORDER BY ${aggregateOrder} DESC, spotify_track_uri ASC;
  `)

  const summary = summaryResult.toArray()[0]
  const comparison = comparisonResult.toArray()[0]
  const previousPlays = Number(comparison.previous_plays)
  const previousMs = Number(comparison.previous_ms)
  const percentChange = (current: number, previous: number) => (
    previous > 0 ? ((current - previous) / previous) * 100 : null
  )
  const highlights = highlightsResult.toArray()[0]
  const sessionSummary = sessionSummaryResult.toArray()[0]
  const retention = retentionResult.toArray()[0]
  return {
    summary: {
      totalPlays: Number(summary.total_plays),
      totalMs: Number(summary.total_ms),
      uniqueTracks: Number(summary.unique_tracks),
      uniqueArtists: Number(summary.unique_artists),
    },
    totalStreams: Number(totalStreamsResult.toArray()[0].total_streams),
    comparison: {
      previousPlays,
      previousMs,
      playsChangePercent: percentChange(Number(summary.total_plays), previousPlays),
      listeningChangePercent: percentChange(Number(summary.total_ms), previousMs),
    },
    highlights: {
      busiestDate: highlights.busiest_date == null ? null : String(highlights.busiest_date),
      busiestDateMs: Number(highlights.busiest_date_ms),
      longestStreakDays: Number(highlights.longest_streak_days),
      topTrackName: highlights.top_track_name == null ? null : String(highlights.top_track_name),
      topTrackArtist: highlights.top_track_artist == null ? null : String(highlights.top_track_artist),
      topAlbumName: highlights.top_album_name == null ? null : String(highlights.top_album_name),
      topAlbumArtist: highlights.top_album_artist == null ? null : String(highlights.top_album_artist),
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
    behavior: behaviorResult.toArray().map((row) => ({
      period: String(row.period),
      streams: Number(row.streams),
      qualifiedPlays: Number(row.qualified_plays),
      naturalEnds: Number(row.natural_ends),
      earlyExits: Number(row.early_exits),
      otherEnds: Number(row.other_ends),
      shuffled: Number(row.shuffled),
      offline: Number(row.offline),
    })),
    platforms: platformsResult.toArray().map((row) => ({
      platform: String(row.platform),
      streams: Number(row.streams),
      totalMs: Number(row.total_ms),
    })),
    sessionSummary: {
      sessions: Number(sessionSummary.sessions),
      averageSessionMs: Number(sessionSummary.average_session_ms),
      longestSessionMs: Number(sessionSummary.longest_session_ms),
      averageStreams: Number(sessionSummary.average_streams),
    },
    longestSessions: longestSessionsResult.toArray().map((row) => ({
      startedAt: String(row.started_at),
      streams: Number(row.streams),
      totalMs: Number(row.total_ms),
      durationMs: Number(row.duration_ms),
    })),
    retention: {
      discoveries: Number(retention.discoveries),
      eligible7Day: Number(retention.eligible_7_day),
      retained7Day: Number(retention.retained_7_day),
      eligible30Day: Number(retention.eligible_30_day),
      retained30Day: Number(retention.retained_30_day),
      oneAndDone: Number(retention.one_and_done),
    },
    rediscoveries: rediscoveriesResult.toArray().map((row) => ({
      trackName: String(row.track_name),
      artistName: String(row.artist_name),
      gapDays: Number(row.gap_days),
      returnedAt: String(row.returned_at),
    })),
    albumTotals: albumTotalsResult.toArray().map((row) => ({
      albumName: String(row.album_name),
      artistName: String(row.artist_name),
      plays: Number(row.plays),
      totalMs: Number(row.total_ms),
      uniqueTracks: Number(row.unique_tracks),
      longestRun: Number(row.longest_run),
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
