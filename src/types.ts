export type RankingMetric = 'plays' | 'duration'
export type RankingView = 'tracks' | 'artists'
export type InsightGranularity = 'day' | 'week' | 'month'

export interface DateBounds {
  min: string
  max: string
}

export interface QueryFilters {
  startDate: string
  endDate: string
  minMs: number
  metric: RankingMetric
  page: number
  ranking: RankingView
}

export interface TrackResult {
  rank: number
  trackName: string
  artistName: string
  albumName: string | null
  spotifyTrackUri: string | null
  playCount: number
  totalMs: number
}

export interface ArtistResult {
  rank: number
  artistName: string
  uniqueTracks: number
  playCount: number
  totalMs: number
}

export interface AnalyticsResult {
  tracks: TrackResult[]
  artists: ArtistResult[]
  totalResults: number
}

export interface PlaylistRankingRequest {
  startDate: string
  endDate: string
  minMs: number
  limit: 50 | 100 | 250 | 500
}

export interface PlaylistRankingResult {
  spotifyTrackUris: string[]
}

export interface InsightQuery {
  startDate: string
  endDate: string
  minMs: number
  granularity: InsightGranularity
  metric: RankingMetric
  timezoneOffsetMinutes: number
}

export interface InsightSummary {
  totalPlays: number
  totalMs: number
  uniqueTracks: number
  uniqueArtists: number
}

export interface InsightVolumePoint {
  period: string
  plays: number
  totalMs: number
  uniqueTracks: number
  uniqueArtists: number
}

export interface InsightHeatmapPoint {
  weekday: number
  hour: number
  plays: number
  totalMs: number
}

export interface InsightDiscoveryPoint {
  period: string
  firstPlays: number
  repeatPlays: number
}

export interface InsightArtistPoint {
  period: string
  artistName: string
  plays: number
  totalMs: number
  rank: number
}

export interface InsightArtistTotal {
  artistName: string
  plays: number
  totalMs: number
}

export interface InsightResult {
  summary: InsightSummary
  volume: InsightVolumePoint[]
  heatmap: InsightHeatmapPoint[]
  discovery: InsightDiscoveryPoint[]
  artistTrends: InsightArtistPoint[]
  artistTotals: InsightArtistTotal[]
  topTrackUris: string[]
}

export interface IngestResult {
  rowCount: number
  bounds: DateBounds
}
