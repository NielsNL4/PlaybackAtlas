/// <reference lib="webworker" />

import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { IngestResult, QueryFilters, TrackResult } from '../types'

type WorkerRequest =
  | { id: number; type: 'ingest'; files: File[] }
  | { id: number; type: 'query'; filters: QueryFilters }

type WorkerResponse =
  | { id: number; type: 'result'; result: IngestResult | TrackResult[] }
  | { id: number; type: 'progress'; progress: number; label: string }
  | { id: number; type: 'error'; error: string }

const context = self as DedicatedWorkerGlobalScope
let database: duckdb.AsyncDuckDB | null = null
let connection: AsyncDuckDBConnection | null = null
let registeredFiles: string[] = []

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

  if (timestamp === 'NULL' || track === 'NULL' || artist === 'NULL' || played === 'NULL') {
    throw new Error('These files do not contain recognized Spotify streaming history fields.')
  }

  await conn.query(`
    CREATE TABLE listening_history AS
    SELECT
      try_cast(${timestamp} AS TIMESTAMP) AS played_at,
      cast(${track} AS VARCHAR) AS track_name,
      cast(${artist} AS VARCHAR) AS artist_name,
      try_cast(${album} AS VARCHAR) AS album_name,
      try_cast(${uri} AS VARCHAR) AS spotify_track_uri,
      coalesce(try_cast(${played} AS BIGINT), 0) AS ms_played
    FROM raw_history
    WHERE try_cast(${timestamp} AS TIMESTAMP) IS NOT NULL
      AND ${track} IS NOT NULL
      AND ${artist} IS NOT NULL;
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

async function queryTracks(filters: QueryFilters): Promise<TrackResult[]> {
  const conn = await getConnection()
  const orderBy = filters.metric === 'plays' ? 'play_count' : 'total_ms'
  const statement = await conn.prepare(`
    SELECT
      track_name,
      artist_name,
      album_name,
      spotify_track_uri,
      count(*)::DOUBLE AS play_count,
      sum(ms_played)::DOUBLE AS total_ms
    FROM listening_history
    WHERE played_at >= try_cast(? AS DATE)
      AND played_at < try_cast(? AS DATE) + INTERVAL 1 DAY
      AND ms_played >= ?
    GROUP BY track_name, artist_name, album_name, spotify_track_uri
    ORDER BY ${orderBy} DESC, track_name ASC
    LIMIT ?;
  `)

  try {
    const result = await statement.query(
      filters.startDate,
      filters.endDate,
      filters.minMs,
      filters.limit,
    )
    return result.toArray().map((row, index) => ({
      rank: index + 1,
      trackName: String(row.track_name),
      artistName: String(row.artist_name),
      albumName: row.album_name == null ? null : String(row.album_name),
      spotifyTrackUri: row.spotify_track_uri == null ? null : String(row.spotify_track_uri),
      playCount: Number(row.play_count),
      totalMs: Number(row.total_ms),
    }))
  } finally {
    await statement.close()
  }
}

context.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const result = data.type === 'ingest'
      ? await ingest(data.id, data.files)
      : await queryTracks(data.filters)
    post({ id: data.id, type: 'result', result })
  } catch (error) {
    post({
      id: data.id,
      type: 'error',
      error: error instanceof Error ? error.message : 'Unexpected analytics error',
    })
  }
}

export {}
