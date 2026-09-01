export type RankingMetric = 'plays' | 'duration'

export interface DateBounds {
  min: string
  max: string
}

export interface QueryFilters {
  startDate: string
  endDate: string
  minMs: number
  metric: RankingMetric
  limit: 50 | 100
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

export interface IngestResult {
  rowCount: number
  bounds: DateBounds
}
