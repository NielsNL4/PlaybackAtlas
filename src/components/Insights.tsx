import { BarChart3, CalendarDays, Clock3, Disc3, Download, ExternalLink, Headphones, Music, Sparkles, Users } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { analytics } from '../services/analytics'
import { interactiveReportHtml } from '../services/report'
import { connectSpotify, getInsightEnrichment, getSpotifySession, type InsightEnrichment, type SpotifySession } from '../services/spotify'
import { browserTimezone } from '../services/timezone'
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
  if (hours < 1) return `${Math.round(ms / 60_000).toLocaleString()} min`
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
    ...result.behavior.map((item) => ['behavior', item.period, '', item.qualifiedPlays, '', item.streams, item.earlyExits]),
    ...result.longestSessions.map((item) => ['session', item.startedAt, '', item.streams, item.totalMs, item.durationMs, '']),
    ...result.albumTotals.map((item) => ['album', '', `${item.artistName} — ${item.albumName}`, item.plays, item.totalMs, item.uniqueTracks, item.longestRun]),
    ...result.rediscoveries.map((item) => ['rediscovery', item.returnedAt, `${item.artistName} — ${item.trackName}`, '', '', item.gapDays, '']),
    ...result.artistTrends.map((item) => ['artist', item.period, item.artistName, item.plays, item.totalMs, item.rank, '']),
    ...result.heatmap.map((item) => ['heatmap', '', `${item.weekday}:${item.hour}`, item.plays, item.totalMs, item.weekday, item.hour]),
  ]
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

function formatPercentChange(value: number | null) {
  if (value == null) return 'No prior activity'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}% vs prior range`
}

function shortPercentChange(value: number | null) {
  if (value == null) return 'N/A'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

function RangeHighlights({ result, startDate, endDate }: { result: InsightResult; startDate: string; endDate: string }) {
  return (
    <article className="story-opening">
      <div className="story-dates"><CalendarDays size={17} /><span>{startDate}</span><i /> <span>{endDate}</span></div>
      <div className="story-lead">
        <span className="kicker">00 / RANGE HIGHLIGHTS</span>
        <h3>{result.highlights.topTrackName ? <><em>{result.highlights.topTrackName}</em> led this chapter.</> : 'A quiet chapter in the archive.'}</h3>
        {result.highlights.topTrackArtist && <p>{result.highlights.topTrackArtist} was behind the range's leading track. Your busiest listening day was {result.highlights.busiestDate || 'not available'}.</p>}
      </div>
      <div className="highlight-ledger">
        <span><small>All stream events</small><strong>{result.totalStreams.toLocaleString()}</strong><em>{result.summary.totalPlays.toLocaleString()} qualified plays</em></span>
        <span><small>Listening shift</small><strong>{shortPercentChange(result.comparison.listeningChangePercent)}</strong><em>{formatPercentChange(result.comparison.listeningChangePercent)}</em></span>
        <span><small>Longest active streak</small><strong>{result.highlights.longestStreakDays}</strong><em>consecutive days</em></span>
        <span><small>Leading album</small><strong className="highlight-name">{result.highlights.topAlbumName || 'No album data'}</strong><em>{result.highlights.topAlbumArtist || 'Metadata unavailable'}</em></span>
      </div>
    </article>
  )
}

function SessionStory({ result }: { result: InsightResult }) {
  return (
    <div className="session-story">
      <div className="story-stat-grid">
        <span><small>Sessions</small><strong>{result.sessionSummary.sessions.toLocaleString()}</strong></span>
        <span><small>Average session</small><strong>{formatDuration(result.sessionSummary.averageSessionMs)}</strong></span>
        <span><small>Streams / session</small><strong>{result.sessionSummary.averageStreams.toFixed(1)}</strong></span>
        <span><small>Longest span</small><strong>{formatDuration(result.sessionSummary.longestSessionMs)}</strong></span>
      </div>
      <div className="story-ranked-list">
        {result.longestSessions.slice(0, 5).map((session, index) => (
          <span key={session.startedAt}><b>{String(index + 1).padStart(2, '0')}</b><strong>{new Date(session.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</strong><small>{session.streams} streams · {formatDuration(session.totalMs)}</small></span>
        ))}
      </div>
    </div>
  )
}

function BehaviorStory({ result }: { result: InsightResult }) {
  const totals = result.behavior.reduce((sum, item) => ({
    streams: sum.streams + item.streams,
    natural: sum.natural + item.naturalEnds,
    early: sum.early + item.earlyExits,
    other: sum.other + item.otherEnds,
    shuffled: sum.shuffled + item.shuffled,
    offline: sum.offline + item.offline,
  }), { streams: 0, natural: 0, early: 0, other: 0, shuffled: 0, offline: 0 })
  const share = (value: number) => totals.streams ? (value / totals.streams) * 100 : 0
  return (
    <div className="behavior-story">
      <div className="outcome-bar" aria-label="How streams ended">
        <span className="outcome-natural" style={{ width: `${share(totals.natural)}%` }} />
        <span className="outcome-early" style={{ width: `${share(totals.early)}%` }} />
        <span className="outcome-other" style={{ width: `${share(totals.other)}%` }} />
      </div>
      <div className="outcome-legend">
        <span><i className="outcome-natural" /><strong>{Math.round(share(totals.natural))}%</strong><small>played through</small></span>
        <span><i className="outcome-early" /><strong>{Math.round(share(totals.early))}%</strong><small>quick exits</small></span>
        <span><i className="outcome-other" /><strong>{Math.round(share(totals.other))}%</strong><small>other endings</small></span>
      </div>
      <div className="behavior-notes"><span><strong>{Math.round(share(totals.shuffled))}%</strong> shuffled</span><span><strong>{Math.round(share(totals.offline))}%</strong> offline</span><span><strong>{result.platforms.length}</strong> platform signatures</span></div>
    </div>
  )
}

function RetentionStory({ result }: { result: InsightResult }) {
  const rate = (retained: number, eligible: number) => eligible ? Math.round((retained / eligible) * 100) : 0
  return (
    <div className="retention-story">
      <div className="retention-stats">
        <span><small>Discoveries</small><strong>{result.retention.discoveries.toLocaleString()}</strong></span>
        <span><small>Returned in 7 days</small><strong>{rate(result.retention.retained7Day, result.retention.eligible7Day)}%</strong><em>{result.retention.eligible7Day.toLocaleString()} eligible</em></span>
        <span><small>Returned in 30 days</small><strong>{rate(result.retention.retained30Day, result.retention.eligible30Day)}%</strong><em>{result.retention.eligible30Day.toLocaleString()} eligible</em></span>
        <span><small>One and done</small><strong>{result.retention.oneAndDone.toLocaleString()}</strong></span>
      </div>
      {result.rediscoveries.length > 0 && <div className="rediscovery-list"><h4>Longest returns</h4>{result.rediscoveries.slice(0, 5).map((item) => <span key={`${item.returnedAt}-${item.artistName}-${item.trackName}`}><Disc3 size={14} /><strong>{item.trackName}</strong><small>{item.artistName}</small><b>{item.gapDays} days</b></span>)}</div>}
    </div>
  )
}

function AlbumStory({ result, metric }: { result: InsightResult; metric: RankingMetric }) {
  const maximum = Math.max(...result.albumTotals.map((album) => metricValue(album, metric)), 1)
  return <div className="album-story">{result.albumTotals.map((album, index) => <div className="album-row" key={`${album.artistName}-${album.albumName}`}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{album.albumName}</strong><small>{album.artistName}</small></span><i><span style={{ width: `${(metricValue(album, metric) / maximum) * 100}%` }} /></i><em>{formatMetric(metricValue(album, metric), metric)} · {album.uniqueTracks} tracks · run of {album.longestRun}</em></div>)}</div>
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
  const detail = hovered || selected
  const showingSelected = Boolean(selected && detail?.period === selected.period)

  return (
    <div className="chart-stage">
      {detail && (
        <div className={`chart-tooltip ${showingSelected ? 'is-selected' : ''}`}>
          <strong>{detail.period}</strong>
          <span>{formatMetric(metricValue(detail, metric), metric)}</span>
          {showingSelected && <small>{detail.uniqueTracks.toLocaleString()} tracks · {detail.uniqueArtists.toLocaleString()} artists</small>}
          {showingSelected && <button onClick={() => onExploreRange(detail.period, periodEnd(detail.period, granularity, endDate))}>View ranked tracks <ExternalLink size={12} /></button>}
        </div>
      )}
      <svg className="insight-svg volume-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Listening volume over time">
        {[0, .25, .5, .75, 1].map((ratio) => {
          const y = padding.top + ratio * (height - padding.top - padding.bottom)
          return <line key={ratio} x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chart-grid-line" />
        })}
        <polygon points={area} className="volume-area" />
        <polyline points={line} className="volume-line" />
        {hovered && (
          <line
            x1={points.find((point) => point.item.period === hovered.period)?.x}
            x2={points.find((point) => point.item.period === hovered.period)?.x}
            y1={padding.top}
            y2={height - padding.bottom}
            className="volume-hover-line"
          />
        )}
        {points.map(({ item, x }, index) => {
          const start = index === 0 ? padding.left : (points[index - 1].x + x) / 2
          const end = index === points.length - 1 ? width - padding.right : (x + points[index + 1].x) / 2
          return (
            <rect
              key={`hover-${item.period}`}
              x={start}
              y={padding.top}
              width={end - start}
              height={height - padding.top - padding.bottom}
              className="volume-hover-band"
              onMouseEnter={() => setHovered(item)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => setSelected(selected?.period === item.period ? null : item)}
            />
          )
        })}
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
  const [hovered, setHovered] = useState<InsightDiscoveryPoint | null>(null)
  const maximum = Math.max(...data.map((item) => item.firstPlays + item.repeatPlays), 1)
  return (
    <div
      className="discovery-chart"
      onMouseLeave={() => setHovered(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null)
      }}
    >
      {data.map((item, index) => {
        const total = item.firstPlays + item.repeatPlays
        return (
          <button
            key={item.period}
            className={hovered?.period === item.period ? 'is-hovered' : ''}
            aria-label={`${item.period}, ${item.firstPlays} first-ever plays and ${item.repeatPlays} repeats`}
            onMouseEnter={() => setHovered(item)}
            onFocus={() => setHovered(item)}
          >
            <span className="discovery-bars" style={{ height: `${Math.max(5, (total / maximum) * 225)}px` }}>
              <span className="repeat-segment" style={{ height: `${total ? (item.repeatPlays / total) * 100 : 0}%` }} />
              <span className="first-segment" style={{ height: `${total ? (item.firstPlays / total) * 100 : 0}%` }} />
            </span>
            {(index % Math.max(1, Math.ceil(data.length / 6)) === 0 || index === data.length - 1) && <small>{item.period.slice(0, 7)}</small>}
          </button>
        )
      })}
      {hovered && (
        <div className="discovery-detail">
          <strong>{hovered.period}</strong>
          <span>{hovered.firstPlays.toLocaleString()} first-ever plays · {hovered.repeatPlays.toLocaleString()} repeats</span>
          <button onClick={() => onExploreRange(hovered.period, periodEnd(hovered.period, granularity, endDate))}>View ranked tracks <ExternalLink size={12} /></button>
        </div>
      )}
    </div>
  )
}

function ArtistChart({ result, metric, view, granularity }: { result: InsightResult; metric: RankingMetric; view: ArtistView; granularity: InsightGranularity }) {
  const [hoveredArtist, setHoveredArtist] = useState<string | null>(null)
  const [pinnedArtist, setPinnedArtist] = useState<string | null>(null)
  const artists = result.artistTotals.map((item) => item.artistName)
  const periods = result.volume.map((item) => item.period)
  const lookup = new Map(result.artistTrends.map((item) => [`${item.period}::${item.artistName}`, item]))
  const activeArtist = [hoveredArtist, pinnedArtist].find((artist) => artist && artists.includes(artist)) || null
  const activeTotal = result.artistTotals.find((item) => item.artistName === activeArtist)

  function clearHover(artist: string) {
    setHoveredArtist((current) => current === artist ? null : current)
  }

  function togglePin(artist: string) {
    setPinnedArtist((current) => current === artist ? null : artist)
  }

  const activeDetail = activeArtist && activeTotal && (
    <div className="artist-active-detail">
      <i style={{ background: ARTIST_COLORS[artists.indexOf(activeArtist)] }} />
      <span><strong>{activeArtist}</strong><small>{formatMetric(metricValue(activeTotal, metric), metric)}{pinnedArtist === activeArtist ? ' · pinned' : ''}</small></span>
    </div>
  )

  if (view === 'bars') {
    const maximum = Math.max(...result.artistTotals.map((item) => metricValue(item, metric)), 1)
    return (
      <div className="artist-bars-wrap">
        {activeDetail}
        <div className="artist-bars">
        {result.artistTotals.map((artist, index) => (
          <button
            className={`artist-bar-row ${activeArtist && activeArtist !== artist.artistName ? 'is-dimmed' : ''} ${pinnedArtist === artist.artistName ? 'is-pinned' : ''}`}
            key={artist.artistName}
            onMouseEnter={() => setHoveredArtist(artist.artistName)}
            onMouseLeave={() => clearHover(artist.artistName)}
            onFocus={() => setHoveredArtist(artist.artistName)}
            onBlur={() => clearHover(artist.artistName)}
            onClick={() => togglePin(artist.artistName)}
            aria-pressed={pinnedArtist === artist.artistName}
          >
            <span className="artist-rank">{String(index + 1).padStart(2, '0')}</span>
            <strong>{artist.artistName}</strong>
            <span className="artist-bar-track"><span style={{ width: `${(metricValue(artist, metric) / maximum) * 100}%`, background: ARTIST_COLORS[index] }} /></span>
            <small>{formatMetric(metricValue(artist, metric), metric)}</small>
          </button>
        ))}
        </div>
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
  const periodLabels = periods
    .map((period, index) => ({ period, index }))
    .filter(({ index }) => index % Math.max(1, Math.ceil(periods.length / 6)) === 0 || index === periods.length - 1)

  if (view === 'ranked') {
    return (
      <div className="artist-chart-wrap">
        {activeDetail}
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
            return (
              <g
                key={artist}
                className={`artist-series ${activeArtist && activeArtist !== artist ? 'is-dimmed' : ''} ${pinnedArtist === artist ? 'is-pinned' : ''}`}
                tabIndex={0}
                role="button"
                aria-label={`${artist}, click to pin`}
                aria-pressed={pinnedArtist === artist}
                onMouseEnter={() => setHoveredArtist(artist)}
                onMouseLeave={() => clearHover(artist)}
                onFocus={() => setHoveredArtist(artist)}
                onBlur={() => clearHover(artist)}
                onClick={() => togglePin(artist)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    togglePin(artist)
                  }
                }}
              >
                <polyline points={points.join(' ')} fill="none" stroke="transparent" strokeWidth="18" className="artist-series-hit" />
                <polyline points={points.join(' ')} fill="none" stroke={ARTIST_COLORS[artistIndex]} strokeWidth={activeArtist === artist ? 5 : 3} className="artist-series-line"><title>{artist}</title></polyline>
              </g>
            )
          })}
          {periodLabels.map(({ period, index }) => (
            <text key={period} x={x(index)} y={height - 10} textAnchor="middle" className="chart-axis-label">
              {granularity === 'month' ? period.slice(0, 7) : period}
            </text>
          ))}
        </svg>
        <ArtistLegend artists={artists} activeArtist={activeArtist} pinnedArtist={pinnedArtist} onHover={setHoveredArtist} onLeave={clearHover} onPin={togglePin} />
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
      {activeDetail}
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
          return (
            <polygon
              key={artist}
              points={points}
              fill={ARTIST_COLORS[artistIndex]}
              className={`artist-series artist-area ${activeArtist && activeArtist !== artist ? 'is-dimmed' : ''} ${pinnedArtist === artist ? 'is-pinned' : ''}`}
              tabIndex={0}
              role="button"
              aria-label={`${artist}, click to pin`}
              aria-pressed={pinnedArtist === artist}
              onMouseEnter={() => setHoveredArtist(artist)}
              onMouseLeave={() => clearHover(artist)}
              onFocus={() => setHoveredArtist(artist)}
              onBlur={() => clearHover(artist)}
              onClick={() => togglePin(artist)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  togglePin(artist)
                }
              }}
            ><title>{artist}</title></polygon>
          )
        })}
        {periodLabels.map(({ period, index }) => (
          <text key={period} x={x(index)} y={height - 10} textAnchor="middle" className="chart-axis-label">
            {granularity === 'month' ? period.slice(0, 7) : period}
          </text>
        ))}
      </svg>
      <ArtistLegend artists={artists} activeArtist={activeArtist} pinnedArtist={pinnedArtist} onHover={setHoveredArtist} onLeave={clearHover} onPin={togglePin} />
    </div>
  )
}

function ArtistLegend({
  artists,
  activeArtist,
  pinnedArtist,
  onHover,
  onLeave,
  onPin,
}: {
  artists: string[]
  activeArtist: string | null
  pinnedArtist: string | null
  onHover: (artist: string) => void
  onLeave: (artist: string) => void
  onPin: (artist: string) => void
}) {
  return (
    <div className="artist-legend">
      {artists.map((artist, index) => (
        <button
          key={artist}
          className={`${activeArtist && activeArtist !== artist ? 'is-dimmed' : ''} ${pinnedArtist === artist ? 'is-pinned' : ''}`}
          onMouseEnter={() => onHover(artist)}
          onMouseLeave={() => onLeave(artist)}
          onFocus={() => onHover(artist)}
          onBlur={() => onLeave(artist)}
          onClick={() => onPin(artist)}
          aria-pressed={pinnedArtist === artist}
        ><i style={{ background: ARTIST_COLORS[index] }} />{artist}</button>
      ))}
    </div>
  )
}

function TasteProfile({ enrichment }: { enrichment: InsightEnrichment }) {
  const [rangeKey, setRangeKey] = useState<InsightEnrichment['ranges'][number]['key']>('short_term')
  const range = enrichment.ranges.find((item) => item.key === rangeKey) || enrichment.ranges[0]
  const percent = (value: number | null) => value == null ? 'N/A' : `${value}%`

  return (
    <div className="taste-profile">
      <div className="taste-stats">
        <span><small>Recent novelty</small><strong>{enrichment.discoveryPercent}%</strong><em>outside this range's top tracks</em></span>
        <span><small>Range overlap</small><strong>{enrichment.archiveOverlapPercent}%</strong><em>Spotify favorites in archive leaders</em></span>
        <span><small>Short-to-long continuity</small><strong>{enrichment.affinityContinuityPercent}%</strong><em>recent favorites also in long term</em></span>
        <span><small>Saved favorites</small><strong>{percent(enrichment.savedFavoritesPercent)}</strong><em>affinity tracks in your library</em></span>
        <span><small>Saved albums</small><strong>{percent(enrichment.savedAlbumsPercent)}</strong><em>favorite-track albums saved</em></span>
        <span><small>Followed artists</small><strong>{percent(enrichment.followedArtistsPercent)}</strong><em>affinity artists followed</em></span>
        <span><small>Playlist coverage</small><strong>{percent(enrichment.playlistCoveragePercent)}</strong><em>affinity tracks in sampled playlists</em></span>
        <span><small>Explicit tracks</small><strong>{enrichment.explicitPercent}%</strong><em>across current affinity tracks</em></span>
      </div>

      {enrichment.releaseEras.length > 0 && <div className="release-eras"><span className="kicker">RELEASE ERAS</span><div>{enrichment.releaseEras.map((era) => <span key={era.label}><strong>{era.label}</strong><i style={{ width: `${(era.count / enrichment.releaseEras[0].count) * 100}%` }} /><small>{era.count}</small></span>)}</div></div>}

      <div className="taste-range segmented">
        {enrichment.ranges.map((item) => <button key={item.key} className={rangeKey === item.key ? 'active' : ''} onClick={() => setRangeKey(item.key)}>{item.label}</button>)}
      </div>
      <p className="taste-range-note">Spotify's "Long term" range is calculated from approximately one year of data. It is not an all-time view.</p>

      {range && (range.artists.length || range.tracks.length) ? (
        <div className="taste-rankings">
          <div><h4>Top artists</h4><div className="taste-list">{range.artists.map((artist, index) => (
            <a href={artist.url} target="_blank" rel="noreferrer" key={artist.url}>
              <b>{String(index + 1).padStart(2, '0')}</b>{artist.imageUrl ? <img src={artist.imageUrl} alt="" /> : <span className="taste-image-fallback"><Users size={14} /></span>}<strong>{artist.name}</strong><ExternalLink size={12} />
            </a>
          ))}</div></div>
          <div><h4>Top tracks</h4><div className="taste-list">{range.tracks.map((track, index) => (
            <a href={track.url} target="_blank" rel="noreferrer" key={track.uri}>
              <b>{String(index + 1).padStart(2, '0')}</b>{track.imageUrl ? <img src={track.imageUrl} alt="" /> : <span className="taste-image-fallback"><Music size={14} /></span>}<span><strong>{track.name}</strong><small>{track.artist}</small></span><ExternalLink size={12} />
            </a>
          ))}</div></div>
        </div>
      ) : <div className="taste-empty">Spotify did not return affinity data for this period.</div>}

      {enrichment.recent.length > 0 && (
        <div className="recent-pulse">
          <div className="taste-section-heading"><div><span className="kicker">RECENT PULSE</span><h4>Your latest Spotify plays</h4></div><div className="context-tags">{enrichment.recentContexts.slice(0, 4).map((context) => <span key={context.name}>{context.name} · {context.count}</span>)}</div></div>
          <div className="recent-strip">{enrichment.recent.map((track) => <a href={track.url} target="_blank" rel="noreferrer" key={`${track.playedAt}-${track.url}`}>{track.imageUrl ? <img src={track.imageUrl} alt="" /> : <span className="taste-image-fallback"><Music size={16} /></span>}<strong>{track.name}</strong><small>{track.artist}</small><time>{new Date(track.playedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></a>)}</div>
        </div>
      )}

      {enrichment.notices.length > 0 && <div className="taste-notices">{enrichment.notices.map((notice) => <span key={notice}>{notice}</span>)}</div>}
    </div>
  )
}

export function Insights({ bounds, authReady, onExploreRange }: InsightsProps) {
  const [{ timezone, timezoneTransitions }] = useState(() => browserTimezone(bounds.min, bounds.max))
  const [startDate, setStartDate] = useState(bounds.min)
  const [endDate, setEndDate] = useState(bounds.max)
  const [granularity, setGranularity] = useState<InsightGranularity>('month')
  const [metric, setMetric] = useState<RankingMetric>('plays')
  const [minMs, setMinMs] = useState(30_000)
  const [artistView, setArtistView] = useState<ArtistView>('stacked')
  const [result, setResult] = useState<InsightResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [spotifySession, setSpotifySession] = useState<SpotifySession | null>(null)
  const [connectError, setConnectError] = useState('')
  const [enrichment, setEnrichment] = useState<InsightEnrichment | null>(null)
  const [enrichmentLoading, setEnrichmentLoading] = useState(false)
  const [enrichmentError, setEnrichmentError] = useState('')
  const sequence = useRef(0)

  useEffect(() => {
    if (authReady) void getSpotifySession().then(setSpotifySession)
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
        timezone,
        timezoneTransitions,
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
    if (!spotifySession?.tasteProfileReady || !result?.topTrackUris.length) return
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
  }, [spotifySession, result])

  function exportJson() {
    if (result) downloadFile(`playback-atlas-${startDate}-${endDate}.json`, JSON.stringify({ startDate, endDate, granularity, metric, data: result }, null, 2), 'application/json')
  }

  function exportCsv() {
    if (result) downloadFile(`playback-atlas-${startDate}-${endDate}.csv`, insightCsv(result), 'text/csv;charset=utf-8')
  }

  function exportInteractiveReport() {
    if (result) downloadFile(
      `playback-atlas-${startDate}-${endDate}.html`,
      interactiveReportHtml({
        startDate,
        endDate,
        granularity,
        metric,
        theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
        result,
        enrichment,
      }),
      'text/html;charset=utf-8',
    )
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
        <div><span className="kicker">LISTENING INTELLIGENCE</span><h2 id="insights-title">Patterns in the archive.</h2><p>Independent from the overview · {timezone}</p></div>
        <div className="insight-exports"><button disabled={!result} onClick={exportCsv}><Download size={14} /> CSV</button><button disabled={!result} onClick={exportJson}><Download size={14} /> JSON</button><button disabled={!result} onClick={exportInteractiveReport}><Download size={14} /> HTML</button><button disabled={!result} onClick={() => window.print()}><Download size={14} /> PDF</button></div>
      </header>

      <div className="insight-controls">
        <label>From<input type="date" min={bounds.min} max={endDate} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>To<input type="date" min={startDate} max={bounds.max} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label>Minimum play<select value={minMs} onChange={(event) => setMinMs(Number(event.target.value))}><option value={30000}>30 seconds</option><option value={60000}>1 minute</option></select></label>
        <div className="segmented insight-granularity">{(['day', 'week', 'month'] as InsightGranularity[]).map((option) => <button key={option} className={granularity === option ? 'active' : ''} onClick={() => setGranularity(option)}>{option}</button>)}</div>
        <div className="segmented insight-metric"><button className={metric === 'plays' ? 'active' : ''} onClick={() => setMetric('plays')}>Plays</button><button className={metric === 'duration' ? 'active' : ''} onClick={() => setMetric('duration')}>Time</button></div>
      </div>

      {!spotifySession?.tasteProfileReady && (
        <div className="enrichment-note"><Sparkles size={18} /><span><strong>{spotifySession ? 'Unlock your Spotify taste profile.' : 'Core insights are ready offline.'}</strong> {spotifySession ? 'Reconnect once to allow top-items and recent-listening access.' : 'Connect Spotify for affinity shifts, recent plays, and archive overlap.'}{connectError && <small>{connectError}</small>}</span><button onClick={() => void beginConnection()}>{spotifySession ? 'Reconnect Spotify' : 'Connect Spotify'}</button></div>
      )}

      {error && <div className="insight-error">{error}</div>}
      {loading && !result ? <div className="insights-loading"><BarChart3 size={30} /><span>Aggregating your archive…</span></div> : result && (
        <div className={loading ? 'insight-content is-loading' : 'insight-content'}>
          <RangeHighlights result={result} startDate={startDate} endDate={endDate} />

          <div className="insight-summary">
            <article><Headphones /><span>Total plays</span><strong>{result.summary.totalPlays.toLocaleString()}</strong></article>
            <article><Clock3 /><span>Listening time</span><strong>{formatDuration(result.summary.totalMs)}</strong></article>
            <article><Music /><span>Unique tracks</span><strong>{result.summary.uniqueTracks.toLocaleString()}</strong></article>
            <article><Users /><span>Unique artists</span><strong>{result.summary.uniqueArtists.toLocaleString()}</strong></article>
          </div>

          <article className="insight-panel insight-panel-wide">
            <header><div><span className="kicker">01 / THE ARC</span><h3>Listening over time</h3></div><p>Choose a point for details and linked tracks.</p></header>
            <VolumeChart data={result.volume} metric={metric} granularity={granularity} endDate={endDate} onExploreRange={onExploreRange} />
          </article>

          <article className="insight-panel insight-panel-wide">
            <header><div><span className="kicker">02 / SESSIONS</span><h3>How listening took shape</h3></div><p>A new session begins after 30 minutes of inactivity.</p></header>
            <SessionStory result={result} />
          </article>

          <div className="insight-panel-grid">
            <article className="insight-panel heatmap-panel">
              <header><div><span className="kicker">03 / RHYTHM</span><h3>When you listen</h3></div><p>Weekday and hour in {timezone}.</p></header>
              <Heatmap data={result.heatmap} metric={metric} />
            </article>
            <article className="insight-panel behavior-panel">
              <header><div><span className="kicker">04 / ATTENTION</span><h3>How streams ended</h3></div><p>Every stream event, including short plays.</p></header>
              <BehaviorStory result={result} />
            </article>
          </div>

          <div className="insight-panel-grid">
            <article className="insight-panel discovery-panel">
              <header><div><span className="kicker">05 / DISCOVERY</span><h3>First plays vs repeats</h3></div><p>First-ever appearances in your archive.</p></header>
              <DiscoveryChart data={result.discovery} granularity={granularity} endDate={endDate} onExploreRange={onExploreRange} />
            </article>
            <article className="insight-panel retention-panel">
              <header><div><span className="kicker">06 / RETENTION</span><h3>What stayed with you</h3></div><p>Returns after a track first entered the archive.</p></header>
              <RetentionStory result={result} />
            </article>
          </div>

          <article className="insight-panel insight-panel-wide">
            <header className="artist-panel-header"><div><span className="kicker">07 / TASTE EVOLUTION</span><h3>Top 10 artists over time</h3></div><div className="segmented artist-view"><button className={artistView === 'stacked' ? 'active' : ''} onClick={() => setArtistView('stacked')}>Share</button><button className={artistView === 'ranked' ? 'active' : ''} onClick={() => setArtistView('ranked')}>Rank</button><button className={artistView === 'bars' ? 'active' : ''} onClick={() => setArtistView('bars')}>Total</button></div></header>
            <ArtistChart result={result} metric={metric} view={artistView} granularity={granularity} />
          </article>

          {result.albumTotals.length > 0 && <article className="insight-panel insight-panel-wide">
            <header><div><span className="kicker">08 / ALBUMS</span><h3>Records, not just tracks</h3></div><p>Depth counts distinct tracks; runs stay within a session.</p></header>
            <AlbumStory result={result} metric={metric} />
          </article>}

          {spotifySession?.tasteProfileReady && (
            <article className="insight-panel insight-panel-wide enrichment-panel">
              <header><div><span className="kicker">EPILOGUE / SPOTIFY</span><h3>Context beyond the archive</h3></div><p>Live affinity and recent listening from Spotify.</p></header>
              {enrichmentLoading && !enrichment ? <div className="enrichment-loading">Mapping your current Spotify taste…</div> : enrichmentError ? <div className="enrichment-failure">{enrichmentError}</div> : enrichment && <TasteProfile enrichment={enrichment} />}
            </article>
          )}
        </div>
      )}
    </section>
  )
}
