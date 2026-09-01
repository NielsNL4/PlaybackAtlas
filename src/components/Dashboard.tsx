import { CalendarRange, Clock3, Disc3, ListFilter, Play } from 'lucide-react'
import { useState } from 'react'
import type { DateBounds, QueryFilters, RankingMetric, TrackResult } from '../types'

interface DashboardProps {
  bounds: DateBounds
  filters: QueryFilters
  tracks: TrackResult[]
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

export function Dashboard({ bounds, filters, tracks, loading, onChange }: DashboardProps) {
  const [mode, setMode] = useState<RangeMode>('year')
  const years = Array.from(
    { length: Number(bounds.max.slice(0, 4)) - Number(bounds.min.slice(0, 4)) + 1 },
    (_, index) => Number(bounds.max.slice(0, 4)) - index,
  )

  function updateRange(nextMode: RangeMode, value?: string) {
    setMode(nextMode)
    if (nextMode === 'year' && value) {
      onChange({ ...filters, startDate: `${value}-01-01`, endDate: `${value}-12-31` })
    }
    if (nextMode === 'month' && value) {
      onChange({ ...filters, startDate: `${value}-01`, endDate: monthEnd(value) })
    }
  }

  function setMetric(metric: RankingMetric) {
    onChange({ ...filters, metric })
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
            <label>From<input type="date" value={filters.startDate} min={bounds.min} max={filters.endDate} onChange={(event) => onChange({ ...filters, startDate: event.target.value })} /></label>
            <label>To<input type="date" value={filters.endDate} min={filters.startDate} max={bounds.max} onChange={(event) => onChange({ ...filters, endDate: event.target.value })} /></label>
          </div>
        )}

        <div className="rule" />
        <label className="field-label">
          <ListFilter size={16} /> Minimum play
          <select value={filters.minMs} onChange={(event) => onChange({ ...filters, minMs: Number(event.target.value) })}>
            <option value={0}>No minimum</option>
            <option value={10000}>10 seconds</option>
            <option value={30000}>30 seconds</option>
            <option value={60000}>1 minute</option>
          </select>
        </label>

        <label className="field-label">
          Show
          <select value={filters.limit} onChange={(event) => onChange({ ...filters, limit: Number(event.target.value) as 50 | 100 })}>
            <option value={50}>Top 50</option>
            <option value={100}>Top 100</option>
          </select>
        </label>
      </div>

      <div className="ranking-panel">
        <header className="ranking-header">
          <div>
            <span className="kicker">THE CHART</span>
            <h2 id="ranking-title">Most played</h2>
            <p>{filters.startDate} to {filters.endDate}</p>
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
      </div>
    </section>
  )
}
