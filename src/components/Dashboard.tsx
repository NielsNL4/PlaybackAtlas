import { CalendarRange, ChevronLeft, ChevronRight, Clock3, Disc3, ListFilter, Play } from 'lucide-react'
import { useState } from 'react'
import type { DateBounds, QueryFilters, RankingMetric, TrackResult } from '../types'

interface DashboardProps {
  bounds: DateBounds
  filters: QueryFilters
  tracks: TrackResult[]
  totalTracks: number
  artwork: Record<string, string>
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

export function Dashboard({ bounds, filters, tracks, totalTracks, artwork, loading, onChange }: DashboardProps) {
  const [mode, setMode] = useState<RangeMode>('year')
  const totalPages = Math.ceil(totalTracks / 50)
  const firstResult = totalTracks ? (filters.page - 1) * 50 + 1 : 0
  const lastResult = Math.min(filters.page * 50, totalTracks)
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
            <option value={0}>No minimum</option>
            <option value={10000}>10 seconds</option>
            <option value={30000}>30 seconds</option>
            <option value={60000}>1 minute</option>
          </select>
        </label>

        <div className="result-note">50 tracks per page<br />{totalTracks.toLocaleString()} ranked tracks</div>
      </div>

      <div className="ranking-panel">
        <header className="ranking-header">
          <div>
            <span className="kicker">THE CHART</span>
            <h2 id="ranking-title">Most played</h2>
            <p>{filters.startDate} to {filters.endDate} · {firstResult}–{lastResult} of {totalTracks.toLocaleString()}</p>
          </div>
          <div className="segmented metric-toggle">
            <button className={filters.metric === 'plays' ? 'active' : ''} onClick={() => setMetric('plays')}><Play size={14} /> Plays</button>
            <button className={filters.metric === 'duration' ? 'active' : ''} onClick={() => setMetric('duration')}><Clock3 size={14} /> Time</button>
          </div>
        </header>

        <div className={`track-list ${loading ? 'is-loading' : ''}`} aria-live="polite">
          {!loading && tracks.length === 0 && <div className="empty-chart"><Disc3 size={36} /><span>No tracks match this window.</span></div>}
          {tracks.map((track) => (
            <article className="track-row" key={`${track.rank}-${track.spotifyTrackUri || `${track.artistName}-${track.trackName}`}`}>
              <span className="rank">{String(track.rank).padStart(2, '0')}</span>
              <AlbumArtwork src={track.spotifyTrackUri ? artwork[track.spotifyTrackUri] : undefined} />
              <span className="track-copy">
                <strong>{track.trackName}</strong>
                <small>{track.artistName}{track.albumName ? ` · ${track.albumName}` : ''}</small>
              </span>
              <span className="stat">
                <strong>{filters.metric === 'plays' ? track.playCount.toLocaleString() : duration(track.totalMs)}</strong>
                <small>{filters.metric === 'plays' ? duration(track.totalMs) : `${track.playCount.toLocaleString()} plays`}</small>
              </span>
            </article>
          ))}
        </div>
        {totalPages > 1 && (
          <nav className="pagination" aria-label="Track pages">
            <span className="page-summary">{firstResult}–{lastResult} of {totalTracks.toLocaleString()}</span>
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
