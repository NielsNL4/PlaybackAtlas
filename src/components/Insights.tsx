import { BarChart3, Clock3, Download, ExternalLink, Headphones, Music, Sparkles, Users } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { analytics } from '../services/analytics'
import { connectSpotify, getInsightEnrichment, getSpotifySession, type InsightEnrichment } from '../services/spotify'
import type {
  DateBounds,
  InsightDiscoveryPoint,
  InsightGranularity,
  InsightResult,
  InsightVolumePoint,
  RankingMetric,
} from '../types'

interface InsightsProps {
  bounds: DateBounds
  authReady: boolean
  onExploreRange: (startDate: string, endDate: string) => void
}

type ArtistView = 'stacked' | 'ranked' | 'bars'

const ARTIST_COLORS = [
  '#c9f64a', '#ff6b3d', '#78a6c8', '#d2a7d8', '#e0c468',
  '#68b59b', '#d98282', '#8e9ee5', '#b1c57b', '#c6926b',
]

function formatDuration(ms: number) {
  const hours = ms / 3_600_000
  return hours >= 100 ? `${Math.round(hours).toLocaleString()} hr` : `${hours.toFixed(1)} hr`
}

function metricValue(item: { plays: number; totalMs: number }, metric: RankingMetric) {
  return metric === 'plays' ? item.plays : item.totalMs / 3_600_000
}

function formatMetric(value: number, metric: RankingMetric) {
  return metric === 'plays' ? `${Math.round(value).toLocaleString()} plays` : `${value.toFixed(1)} hours`
}

function periodEnd(period: string, granularity: InsightGranularity, maximum: string) {
  const date = new Date(`${period}T00:00:00Z`)
  if (granularity === 'day') date.setUTCDate(date.getUTCDate() + 1)
  if (granularity === 'week') date.setUTCDate(date.getUTCDate() + 7)
  if (granularity === 'month') date.setUTCMonth(date.getUTCMonth() + 1)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10) > maximum ? maximum : date.toISOString().slice(0, 10)
}

function downloadFile(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string | number) {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function insightCsv(result: InsightResult) {
  const rows: Array<Array<string | number>> = [
    ['section', 'period', 'name', 'plays', 'total_ms', 'value_1', 'value_2'],
    ['summary', '', 'all', result.summary.totalPlays, result.summary.totalMs, result.summary.uniqueTracks, result.summary.uniqueArtists],
    ...result.volume.map((item) => ['volume', item.period, '', item.plays, item.totalMs, item.uniqueTracks, item.uniqueArtists]),
    ...result.discovery.map((item) => ['discovery', item.period, '', item.firstPlays + item.repeatPlays, '', item.firstPlays, item.repeatPlays]),
    ...result.artistTrends.map((item) => ['artist', item.period, item.artistName, item.plays, item.totalMs, item.rank, '']),
    ...result.heatmap.map((item) => ['heatmap', '', `${item.weekday}:${item.hour}`, item.plays, item.totalMs, item.weekday, item.hour]),
  ]
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

function VolumeChart({
  data,
  metric,
  granularity,
  endDate,
  onExploreRange,
}: {
  data: InsightVolumePoint[]
  metric: RankingMetric
  granularity: InsightGranularity
  endDate: string
  onExploreRange: (start: string, end: string) => void
}) {
  const [hovered, setHovered] = useState<InsightVolumePoint | null>(null)
  const [selected, setSelected] = useState<InsightVolumePoint | null>(null)
  const width = 1000
  const height = 280
  const padding = { left: 45, right: 18, top: 20, bottom: 34 }
  const values = data.map((item) => metricValue(item, metric))
  const maximum = Math.max(...values, 1)
  const points = data.map((item, index) => ({
    item,
    x: padding.left + (index / Math.max(data.length - 1, 1)) * (width - padding.left - padding.right),
    y: padding.top + (1 - metricValue(item, metric) / maximum) * (height - padding.top - padding.bottom),
  }))
  const line = points.map((point) => `${point.x},${point.y}`).join(' ')
  const area = `${padding.left},${height - padding.bottom} ${line} ${points.at(-1)?.x || padding.left},${height - padding.bottom}`
  const detail = selected || hovered

  return (
    <div className="chart-stage">
      {detail && (
        <div className={`chart-tooltip ${selected ? 'is-selected' : ''}`}>
          <strong>{detail.period}</strong>
          <span>{formatMetric(metricValue(detail, metric), metric)}</span>
          {selected && <small>{detail.uniqueTracks.toLocaleString()} tracks · {detail.uniqueArtists.toLocaleString()} artists</small>}
          {selected && <button onClick={() => onExploreRange(detail.period, periodEnd(detail.period, granularity, endDate))}>View ranked tracks <ExternalLink size={12} /></button>}
        </div>
      )}
      <svg className="insight-svg volume-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Listening volume over time">
        {[0, .25, .5, .75, 1].map((ratio) => {
          const y = padding.top + ratio * (height - padding.top - padding.bottom)
          return <line key={ratio} x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chart-grid-line" />
        })}
        <polygon points={area} className="volume-area" />
        <polyline points={line} className="volume-line" />
        {points.map(({ item, x, y }) => (
          <circle
            key={item.period}
            cx={x}
            cy={y}
            r={selected?.period === item.period ? 7 : 4}
            className="volume-point"
            tabIndex={0}
            onFocus={() => setHovered(item)}
            onBlur={() => setHovered(null)}
            onMouseEnter={() => setHovered(item)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => setSelected(selected?.period === item.period ? null : item)}
          />
        ))}
        {points.filter((_, index) => index % Math.max(1, Math.ceil(points.length / 6)) === 0 || index === points.length - 1).map(({ item, x }) => (
          <text key={item.period} x={x} y={height - 10} textAnchor="middle" className="chart-axis-label">{item.period.slice(0, 7)}</text>
        ))}
      </svg>
    </div>
  )
}

function Heatmap({ data, metric }: { data: InsightResult['heatmap']; metric: RankingMetric }) {
  const [hovered, setHovered] = useState<InsightResult['heatmap'][number] | null>(null)
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const values = data.map((item) => metricValue(item, metric))
  const maximum = Math.max(...values, 1)
  const lookup = new Map(data.map((item) => [`${item.weekday}-${item.hour}`, item]))

  return (
    <div className="heatmap-wrap">
      {hovered && <div className="heatmap-detail"><strong>{weekdays[hovered.weekday]} {String(hovered.hour).padStart(2, '0')}:00</strong><span>{formatMetric(metricValue(hovered, metric), metric)}</span></div>}
      <div className="heatmap-grid">
        <span />
        {Array.from({ length: 24 }, (_, hour) => <span className="heatmap-hour" key={hour}>{hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}</span>)}
        {weekdays.map((weekday, weekdayIndex) => (
          <div className="heatmap-row" key={weekday}>
            <span className="heatmap-day">{weekday}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const item = lookup.get(`${weekdayIndex}-${hour}`) || { weekday: weekdayIndex, hour, plays: 0, totalMs: 0 }
              const intensity = Math.round((metricValue(item, metric) / maximum) * 100)
              return (
                <button
                  key={hour}
                  aria-label={`${weekday} ${hour}:00, ${formatMetric(metricValue(item, metric), metric)}`}
                  style={{ background: `color-mix(in srgb, var(--acid) ${intensity}%, var(--surface-control))` }}
                  onMouseEnter={() => setHovered(item)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(item)}
                  onBlur={() => setHovered(null)}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function DiscoveryChart({
  data,
  granularity,
  endDate,
  onExploreRange,
}: {
  data: InsightDiscoveryPoint[]
  granularity: InsightGranularity
  endDate: string
  onExploreRange: (start: string, end: string) => void
}) {
  const [selected, setSelected] = useState<InsightDiscoveryPoint | null>(null)
  const maximum = Math.max(...data.map((item) => item.firstPlays + item.repeatPlays), 1)
  return (
    <div className="discovery-chart">
      {data.map((item, index) => {
        const total = item.firstPlays + item.repeatPlays
        return (
          <button key={item.period} className={selected?.period === item.period ? 'selected' : ''} onClick={() => setSelected(selected?.period === item.period ? null : item)}>
            <span className="discovery-bars" style={{ height: `${Math.max(4, (total / maximum) * 180)}px` }}>
              <span className="repeat-segment" style={{ height: `${total ? (item.repeatPlays / total) * 100 : 0}%` }} />
              <span className="first-segment" style={{ height: `${total ? (item.firstPlays / total) * 100 : 0}%` }} />
            </span>
            {(index % Math.max(1, Math.ceil(data.length / 6)) === 0 || index === data.length - 1) && <small>{item.period.slice(0, 7)}</small>}
          </button>
        )
      })}
      {selected && (
        <div className="discovery-detail">
          <strong>{selected.period}</strong>
          <span>{selected.firstPlays.toLocaleString()} first-ever plays · {selected.repeatPlays.toLocaleString()} repeats</span>
          <button onClick={() => onExploreRange(selected.period, periodEnd(selected.period, granularity, endDate))}>View ranked tracks <ExternalLink size={12} /></button>
        </div>
      )}
    </div>
  )
}

function ArtistChart({ result, metric, view }: { result: InsightResult; metric: RankingMetric; view: ArtistView }) {
  const artists = result.artistTotals.map((item) => item.artistName)
  const periods = result.volume.map((item) => item.period)
  const lookup = new Map(result.artistTrends.map((item) => [`${item.period}::${item.artistName}`, item]))

  if (view === 'bars') {
    const maximum = Math.max(...result.artistTotals.map((item) => metricValue(item, metric)), 1)
    return (
      <div className="artist-bars">
        {result.artistTotals.map((artist, index) => (
          <div className="artist-bar-row" key={artist.artistName}>
            <span className="artist-rank">{String(index + 1).padStart(2, '0')}</span>
            <strong>{artist.artistName}</strong>
            <span className="artist-bar-track"><span style={{ width: `${(metricValue(artist, metric) / maximum) * 100}%`, background: ARTIST_COLORS[index] }} /></span>
            <small>{formatMetric(metricValue(artist, metric), metric)}</small>
          </div>
        ))}
      </div>
    )
  }

  const width = 1000
  const height = 300
  const left = 45
  const right = 18
  const top = 20
  const bottom = 35
  const x = (index: number) => left + (index / Math.max(periods.length - 1, 1)) * (width - left - right)

  if (view === 'ranked') {
    return (
      <div className="artist-chart-wrap">
        <svg className="insight-svg artist-lines" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Artist rank over time">
          {Array.from({ length: 10 }, (_, index) => {
            const y = top + (index / 9) * (height - top - bottom)
            return <g key={index}><line x1={left} x2={width - right} y1={y} y2={y} className="chart-grid-line" /><text x={25} y={y + 3} className="chart-axis-label">{index + 1}</text></g>
          })}
          {artists.map((artist, artistIndex) => {
            const points = periods.flatMap((period, periodIndex) => {
              const item = lookup.get(`${period}::${artist}`)
              return item ? [`${x(periodIndex)},${top + ((item.rank - 1) / 9) * (height - top - bottom)}`] : []
            })
            return <polyline key={artist} points={points.join(' ')} fill="none" stroke={ARTIST_COLORS[artistIndex]} strokeWidth="3"><title>{artist}</title></polyline>
          })}
        </svg>
        <ArtistLegend artists={artists} />
      </div>
    )
  }

  const totals = periods.map((period) => artists.reduce((sum, artist) => {
    const item = lookup.get(`${period}::${artist}`)
    return sum + (item ? metricValue(item, metric) : 0)
  }, 0))
  const cumulative = periods.map(() => 0)
  const chartHeight = height - top - bottom

  return (
    <div className="artist-chart-wrap">
      <svg className="insight-svg artist-areas" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Top artist listening share over time">
        {artists.map((artist, artistIndex) => {
          const lower = cumulative.map((value, index) => totals[index] ? value / totals[index] : 0)
          const upper = cumulative.map((value, index) => {
            const item = lookup.get(`${periods[index]}::${artist}`)
            const next = value + (item ? metricValue(item, metric) : 0)
            cumulative[index] = next
            return totals[index] ? next / totals[index] : 0
          })
          const points = [
            ...upper.map((value, index) => `${x(index)},${top + (1 - value) * chartHeight}`),
            ...lower.map((value, index) => `${x(index)},${top + (1 - value) * chartHeight}`).reverse(),
          ].join(' ')
          return <polygon key={artist} points={points} fill={ARTIST_COLORS[artistIndex]} opacity=".82"><title>{artist}</title></polygon>
        })}
      </svg>
      <ArtistLegend artists={artists} />
    </div>
  )
}

function ArtistLegend({ artists }: { artists: string[] }) {
  return <div className="artist-legend">{artists.map((artist, index) => <span key={artist}><i style={{ background: ARTIST_COLORS[index] }} />{artist}</span>)}</div>
}

export function Insights({ bounds, authReady, onExploreRange }: InsightsProps) {
  const [startDate, setStartDate] = useState(bounds.min)
  const [endDate, setEndDate] = useState(bounds.max)
  const [granularity, setGranularity] = useState<InsightGranularity>('month')
  const [metric, setMetric] = useState<RankingMetric>('plays')
  const [minMs, setMinMs] = useState(0)
  const [artistView, setArtistView] = useState<ArtistView>('stacked')
  const [result, setResult] = useState<InsightResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [spotifyConnected, setSpotifyConnected] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [enrichment, setEnrichment] = useState<InsightEnrichment | null>(null)
  const [enrichmentLoading, setEnrichmentLoading] = useState(false)
  const [enrichmentError, setEnrichmentError] = useState('')
  const sequence = useRef(0)

  useEffect(() => {
    if (authReady) void getSpotifySession().then((session) => setSpotifyConnected(Boolean(session)))
  }, [authReady])

  const loadInsights = useEffectEvent(async () => {
    const current = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const next = await analytics.queryInsights({
        startDate,
        endDate,
        minMs,
        granularity,
        metric,
        timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
      })
      if (current === sequence.current) setResult(next)
    } catch (reason) {
      if (current === sequence.current) setError(reason instanceof Error ? reason.message : 'Insights could not be loaded.')
    } finally {
      if (current === sequence.current) setLoading(false)
    }
  })

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadInsights(), 0)
    return () => window.clearTimeout(timeout)
  }, [startDate, endDate, minMs, granularity, metric])

  useEffect(() => {
    if (!spotifyConnected || !result?.topTrackUris.length) return
    let current = true
    const timeout = window.setTimeout(() => {
      setEnrichmentLoading(true)
      setEnrichmentError('')
      void getInsightEnrichment(result.topTrackUris)
        .then((metadata) => { if (current) setEnrichment(metadata) })
        .catch((reason) => { if (current) setEnrichmentError(reason instanceof Error ? reason.message : 'Spotify metadata could not be loaded.') })
        .finally(() => { if (current) setEnrichmentLoading(false) })
    }, 0)
    return () => {
      current = false
      window.clearTimeout(timeout)
    }
  }, [spotifyConnected, result])

  function exportJson() {
    if (result) downloadFile(`playback-atlas-${startDate}-${endDate}.json`, JSON.stringify({ startDate, endDate, granularity, metric, data: result }, null, 2), 'application/json')
  }

  function exportCsv() {
    if (result) downloadFile(`playback-atlas-${startDate}-${endDate}.csv`, insightCsv(result), 'text/csv;charset=utf-8')
  }

  async function beginConnection() {
    setConnectError('')
    try {
      await connectSpotify()
    } catch (reason) {
      setConnectError(reason instanceof Error ? reason.message : 'Spotify connection could not be started.')
    }
  }

  return (
    <section className="insights" aria-labelledby="insights-title">
      <header className="insights-header">
        <div><span className="kicker">LISTENING INTELLIGENCE</span><h2 id="insights-title">Patterns in the archive.</h2><p>Independent from the overview · browser-local time</p></div>
        <div className="insight-exports"><button disabled={!result} onClick={exportCsv}><Download size={14} /> CSV</button><button disabled={!result} onClick={exportJson}><Download size={14} /> JSON</button></div>
      </header>

      <div className="insight-controls">
        <label>From<input type="date" min={bounds.min} max={endDate} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>To<input type="date" min={startDate} max={bounds.max} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label>Minimum play<select value={minMs} onChange={(event) => setMinMs(Number(event.target.value))}><option value={0}>No minimum</option><option value={10000}>10 seconds</option><option value={30000}>30 seconds</option><option value={60000}>1 minute</option></select></label>
        <div className="segmented insight-granularity">{(['day', 'week', 'month'] as InsightGranularity[]).map((option) => <button key={option} className={granularity === option ? 'active' : ''} onClick={() => setGranularity(option)}>{option}</button>)}</div>
        <div className="segmented insight-metric"><button className={metric === 'plays' ? 'active' : ''} onClick={() => setMetric('plays')}>Plays</button><button className={metric === 'duration' ? 'active' : ''} onClick={() => setMetric('duration')}>Time</button></div>
      </div>

      {!spotifyConnected && (
        <div className="enrichment-note"><Sparkles size={18} /><span><strong>Core insights are ready offline.</strong> Connect Spotify later for the best results with genres, release dates, popularity, and richer track metadata.{connectError && <small>{connectError}</small>}</span><button onClick={() => void beginConnection()}>Connect Spotify</button></div>
      )}

      {error && <div className="insight-error">{error}</div>}
      {loading && !result ? <div className="insights-loading"><BarChart3 size={30} /><span>Aggregating your archive…</span></div> : result && (
        <div className={loading ? 'insight-content is-loading' : 'insight-content'}>
          <div className="insight-summary">
            <article><Headphones /><span>Total plays</span><strong>{result.summary.totalPlays.toLocaleString()}</strong></article>
            <article><Clock3 /><span>Listening time</span><strong>{formatDuration(result.summary.totalMs)}</strong></article>
            <article><Music /><span>Unique tracks</span><strong>{result.summary.uniqueTracks.toLocaleString()}</strong></article>
            <article><Users /><span>Unique artists</span><strong>{result.summary.uniqueArtists.toLocaleString()}</strong></article>
          </div>

          <article className="insight-panel insight-panel-wide">
            <header><div><span className="kicker">01 / VOLUME</span><h3>Listening over time</h3></div><p>Choose a point for details and linked tracks.</p></header>
            <VolumeChart data={result.volume} metric={metric} granularity={granularity} endDate={endDate} onExploreRange={onExploreRange} />
          </article>

          <div className="insight-panel-grid">
            <article className="insight-panel heatmap-panel">
              <header><div><span className="kicker">02 / RHYTHM</span><h3>When you listen</h3></div><p>Browser-local weekday and hour.</p></header>
              <Heatmap data={result.heatmap} metric={metric} />
            </article>
            <article className="insight-panel discovery-panel">
              <header><div><span className="kicker">03 / DISCOVERY</span><h3>First plays vs repeats</h3></div><p>First-ever appearances in your archive.</p></header>
              <DiscoveryChart data={result.discovery} granularity={granularity} endDate={endDate} onExploreRange={onExploreRange} />
            </article>
          </div>

          <article className="insight-panel insight-panel-wide">
            <header className="artist-panel-header"><div><span className="kicker">04 / ARTISTS</span><h3>Top 10 over time</h3></div><div className="segmented artist-view"><button className={artistView === 'stacked' ? 'active' : ''} onClick={() => setArtistView('stacked')}>Share</button><button className={artistView === 'ranked' ? 'active' : ''} onClick={() => setArtistView('ranked')}>Rank</button><button className={artistView === 'bars' ? 'active' : ''} onClick={() => setArtistView('bars')}>Total</button></div></header>
            <ArtistChart result={result} metric={metric} view={artistView} />
          </article>

          {spotifyConnected && (
            <article className="insight-panel insight-panel-wide enrichment-panel">
              <header><div><span className="kicker">05 / SPOTIFY METADATA</span><h3>Context beyond the archive</h3></div><p>Top 100 tracks in this Insights range.</p></header>
              {enrichmentLoading && !enrichment ? <div className="enrichment-loading">Loading genres and track details…</div> : enrichmentError ? <div className="enrichment-failure">{enrichmentError}</div> : enrichment && (
                <div className="enrichment-content">
                  <div className="metadata-stats">
                    <span><small>Tracks enriched</small><strong>{enrichment.trackCount}</strong></span>
                    <span><small>Average duration</small><strong>{Math.round(enrichment.averageDurationMs / 60_000)} min</strong></span>
                    <span><small>Average popularity</small><strong>{Math.round(enrichment.averagePopularity)} / 100</strong></span>
                  </div>
                  <div className="metadata-columns">
                    <div><h4>Genre signals</h4><div className="genre-bars">{enrichment.genres.map((genre) => <span key={genre.name}><strong>{genre.name}</strong><i><i style={{ width: `${(genre.count / Math.max(enrichment.genres[0]?.count || 1, 1)) * 100}%` }} /></i><small>{genre.count}</small></span>)}</div></div>
                    <div><h4>Release eras</h4><div className="era-bars">{enrichment.releaseEras.map((era) => <span key={era.name}><strong>{era.name}</strong><i style={{ height: `${Math.max(5, (era.count / Math.max(...enrichment.releaseEras.map((item) => item.count), 1)) * 110)}px` }} /><small>{era.count}</small></span>)}</div></div>
                  </div>
                </div>
              )}
            </article>
          )}
        </div>
      )}
    </section>
  )
}
