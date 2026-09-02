import { CalendarRange, ChevronLeft, ChevronRight, Clock3, Disc3, ListFilter, Music, Play, Users } from 'lucide-react'
import { useState } from 'react'
import type { SpotifyArtistProfile } from '../services/spotify'
import type { ArtistResult, DateBounds, QueryFilters, RankingMetric, RankingView, TrackResult } from '../types'

interface DashboardProps {
  bounds: DateBounds
  filters: QueryFilters
  tracks: TrackResult[]
  artists: ArtistResult[]
  totalResults: number
  artwork: Record<string, string>
  artistProfiles: Record<string, SpotifyArtistProfile>
  loading: boolean
  onChange: (filters: QueryFilters) => void
}

type RangeMode = 'year' | 'month' | 'custom'

function duration(ms: number) {
  const hours = ms / 3_600_000
  return hours >= 1 ? `${hours.toFixed(1)} hr` : `${Math.round(ms / 60_000)} min`
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
}

function paginationItems(currentPage: number, totalPages: number) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)

  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])
  const visible = [...pages].filter((page) => page > 0 && page <= totalPages).sort((a, b) => a - b)
  const items: Array<number | 'ellipsis'> = []
  visible.forEach((page, index) => {
    if (index > 0 && page - visible[index - 1] > 1) items.push('ellipsis')
    items.push(page)
  })
  return items
}

function AlbumArtwork({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <span className="album-art album-fallback"><Disc3 size={19} /></span>
  }
  return <img className="album-art" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
}

function ArtistArtwork({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <span className="artist-art artist-fallback"><Users size={19} /></span>
  return <img className="artist-art" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
}

export function Dashboard({ bounds, filters, tracks, artists, totalResults, artwork, artistProfiles, loading, onChange }: DashboardProps) {
  const [mode, setMode] = useState<RangeMode>('year')
  const totalPages = Math.ceil(totalResults / 50)
  const firstResult = totalResults ? (filters.page - 1) * 50 + 1 : 0
  const lastResult = Math.min(filters.page * 50, totalResults)
  const years = Array.from(
    { length: Number(bounds.max.slice(0, 4)) - Number(bounds.min.slice(0, 4)) + 1 },
    (_, index) => Number(bounds.max.slice(0, 4)) - index,
  )

  function updateRange(nextMode: RangeMode, value?: string) {
    setMode(nextMode)
    if (nextMode === 'year' && value) {
      onChange({ ...filters, startDate: `${value}-01-01`, endDate: `${value}-12-31`, page: 1 })
    }
    if (nextMode === 'month' && value) {
      onChange({ ...filters, startDate: `${value}-01`, endDate: monthEnd(value), page: 1 })
    }
  }

  function setMetric(metric: RankingMetric) {
    onChange({ ...filters, metric, page: 1 })
  }

  function setRanking(ranking: RankingView) {
    onChange({ ...filters, ranking, page: 1 })
  }

  function setPage(page: number) {
    if (page < 1 || page > totalPages || page === filters.page) return
    onChange({ ...filters, page })
    document.getElementById('ranking-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <section className="dashboard" aria-labelledby="ranking-title">
      <div className="control-rail">
        <div className="control-heading">
          <CalendarRange size={18} />
          <span>Listening window</span>
        </div>
        <div className="segmented range-tabs">
          {(['year', 'month', 'custom'] as RangeMode[]).map((option) => (
            <button key={option} className={mode === option ? 'active' : ''} onClick={() => updateRange(option)}>
              {option}
            </button>
          ))}
        </div>

        {mode === 'year' && (
          <select
            aria-label="Year"
            value={filters.startDate.slice(0, 4)}
            onChange={(event) => updateRange('year', event.target.value)}
          >
            {years.map((year) => <option key={year}>{year}</option>)}
          </select>
        )}
        {mode === 'month' && (
          <input
            aria-label="Month"
            type="month"
            min={bounds.min.slice(0, 7)}
            max={bounds.max.slice(0, 7)}
            value={filters.startDate.slice(0, 7)}
            onChange={(event) => updateRange('month', event.target.value)}
          />
        )}
        {mode === 'custom' && (
          <div className="date-pair">
            <label>From<input type="date" value={filters.startDate} min={bounds.min} max={filters.endDate} onChange={(event) => onChange({ ...filters, startDate: event.target.value, page: 1 })} /></label>
            <label>To<input type="date" value={filters.endDate} min={filters.startDate} max={bounds.max} onChange={(event) => onChange({ ...filters, endDate: event.target.value, page: 1 })} /></label>
          </div>
        )}

        <div className="rule" />
        <label className="field-label">
          <ListFilter size={16} /> Minimum play
          <select value={filters.minMs} onChange={(event) => onChange({ ...filters, minMs: Number(event.target.value), page: 1 })}>
            <option value={30000}>30 seconds</option>
            <option value={60000}>1 minute</option>
          </select>
        </label>

        <div className="result-note">50 {filters.ranking} per page<br />{totalResults.toLocaleString()} ranked {filters.ranking}</div>
      </div>

      <div className="ranking-panel">
        <header className="ranking-header">
          <div>
            <span className="kicker">THE CHART</span>
            <h2 id="ranking-title">Top {filters.ranking}</h2>
            <p>{filters.startDate} to {filters.endDate} · {firstResult}–{lastResult} of {totalResults.toLocaleString()}</p>
          </div>
          <div className="ranking-toggles">
            <div className="segmented ranking-type-toggle">
              <button className={filters.ranking === 'tracks' ? 'active' : ''} onClick={() => setRanking('tracks')}><Music size={14} /> Tracks</button>
              <button className={filters.ranking === 'artists' ? 'active' : ''} onClick={() => setRanking('artists')}><Users size={14} /> Artists</button>
            </div>
            <div className="segmented metric-toggle">
              <button className={filters.metric === 'plays' ? 'active' : ''} onClick={() => setMetric('plays')}><Play size={14} /> Plays</button>
              <button className={filters.metric === 'duration' ? 'active' : ''} onClick={() => setMetric('duration')}><Clock3 size={14} /> Time</button>
            </div>
          </div>
        </header>

        <div className={`track-list ${loading ? 'is-loading' : ''}`} aria-live="polite">
          {!loading && tracks.length === 0 && artists.length === 0 && <div className="empty-chart">{filters.ranking === 'tracks' ? <Disc3 size={36} /> : <Users size={36} />}<span>No {filters.ranking} match this window.</span></div>}
          {filters.ranking === 'tracks' && tracks.map((track) => (
            <article className="track-row" key={`${track.rank}-${track.spotifyTrackUri || `${track.artistName}-${track.trackName}`}`}>
              <span className="rank">{String(track.rank).padStart(2, '0')}</span>
              <AlbumArtwork src={track.spotifyTrackUri ? artwork[track.spotifyTrackUri] : undefined} />
              <span className="track-copy">
                <strong>{track.trackName}</strong>
                <small>{track.artistName}{track.albumName ? ` · ${track.albumName}` : ''}</small>
              </span>
              <span className="stat">
                <strong>{filters.metric === 'plays' ? `${track.playCount.toLocaleString()} plays` : duration(track.totalMs)}</strong>
                <small>{filters.metric === 'plays' ? duration(track.totalMs) : `${track.playCount.toLocaleString()} plays`}</small>
              </span>
            </article>
          ))}
          {filters.ranking === 'artists' && artists.map((artist) => {
            const profile = artistProfiles[artist.artistName]
            const content = <><ArtistArtwork src={profile?.imageUrl} /><span className="track-copy"><strong>{artist.artistName}</strong><small>{artist.uniqueTracks.toLocaleString()} unique tracks</small></span></>
            return (
              <article className="track-row artist-rank-row" key={`${artist.rank}-${artist.artistName}`}>
                <span className="rank">{String(artist.rank).padStart(2, '0')}</span>
                {profile ? <a className="artist-profile-link" href={profile.url} target="_blank" rel="noreferrer" aria-label={`Open ${artist.artistName} on Spotify`}>{content}</a> : content}
                <span className="stat">
                  <strong>{filters.metric === 'plays' ? `${artist.playCount.toLocaleString()} plays` : duration(artist.totalMs)}</strong>
                  <small>{filters.metric === 'plays' ? duration(artist.totalMs) : `${artist.playCount.toLocaleString()} plays`}</small>
                </span>
              </article>
            )
          })}
        </div>
        {totalPages > 1 && (
          <nav className="pagination" aria-label="Track pages">
            <span className="page-summary">{firstResult}–{lastResult} of {totalResults.toLocaleString()} {filters.ranking}</span>
            <div className="page-buttons">
              <button aria-label="Previous page" disabled={filters.page === 1 || loading} onClick={() => setPage(filters.page - 1)}><ChevronLeft size={16} /></button>
              {paginationItems(filters.page, totalPages).map((item, index) => item === 'ellipsis' ? (
                <span className="page-ellipsis" key={`ellipsis-${index}`}>…</span>
              ) : (
                <button key={item} className={item === filters.page ? 'active' : ''} aria-current={item === filters.page ? 'page' : undefined} disabled={loading} onClick={() => setPage(item)}>{item}</button>
              ))}
              <button aria-label="Next page" disabled={filters.page === totalPages || loading} onClick={() => setPage(filters.page + 1)}><ChevronRight size={16} /></button>
            </div>
          </nav>
        )}
      </div>
    </section>
  )
}
