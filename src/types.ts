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
  timezone: string
  timezoneTransitions: TimezoneTransition[]
}

export interface TimezoneTransition {
  startsAt: string
  offsetMinutes: number
}

export interface InsightSummary {
  totalPlays: number
  totalMs: number
  uniqueTracks: number
  uniqueArtists: number
}

export interface InsightComparison {
  previousPlays: number
  previousMs: number
  playsChangePercent: number | null
  listeningChangePercent: number | null
}

export interface InsightHighlight {
  busiestDate: string | null
  busiestDateMs: number
  longestStreakDays: number
  topTrackName: string | null
  topTrackArtist: string | null
  topAlbumName: string | null
  topAlbumArtist: string | null
}

export interface InsightBehaviorPoint {
  period: string
  streams: number
  qualifiedPlays: number
  naturalEnds: number
  earlyExits: number
  otherEnds: number
  shuffled: number
  offline: number
}

export interface InsightPlatformPoint {
  platform: string
  streams: number
  totalMs: number
}

export interface InsightSessionSummary {
  sessions: number
  averageSessionMs: number
  longestSessionMs: number
  averageStreams: number
}

export interface InsightSessionPoint {
  startedAt: string
  streams: number
  totalMs: number
  durationMs: number
}

export interface InsightRetention {
  discoveries: number
  eligible7Day: number
  retained7Day: number
  eligible30Day: number
  retained30Day: number
  oneAndDone: number
}

export interface InsightRediscovery {
  trackName: string
  artistName: string
  gapDays: number
  returnedAt: string
}

export interface InsightAlbumTotal {
  albumName: string
  artistName: string
  plays: number
  totalMs: number
  uniqueTracks: number
  longestRun: number
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
  totalStreams: number
  comparison: InsightComparison
  highlights: InsightHighlight
  volume: InsightVolumePoint[]
  heatmap: InsightHeatmapPoint[]
  discovery: InsightDiscoveryPoint[]
  behavior: InsightBehaviorPoint[]
  platforms: InsightPlatformPoint[]
  sessionSummary: InsightSessionSummary
  longestSessions: InsightSessionPoint[]
  retention: InsightRetention
  rediscoveries: InsightRediscovery[]
  albumTotals: InsightAlbumTotal[]
  artistTrends: InsightArtistPoint[]
  artistTotals: InsightArtistTotal[]
  topTrackUris: string[]
}

export interface IngestResult {
  rowCount: number
  bounds: DateBounds
}
