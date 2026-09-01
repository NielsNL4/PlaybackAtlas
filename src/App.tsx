import { BarChart3, Code2, Database, HardDrive, ListMusic, LoaderCircle, LockKeyhole, Moon, RotateCcw, Sun, Trash2 } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { FileUpload } from './components/FileUpload'
import { Insights } from './components/Insights'
import { PlaylistButton } from './components/PlaylistButton'
import { analytics } from './services/analytics'
import { cacheHistoryFiles, clearCachedHistory, getCachedHistoryFiles } from './services/historyCache'
import { getTrackArtwork, handleSpotifyCallback } from './services/spotify'
import type { DateBounds, QueryFilters, TrackResult } from './types'

const defaultFilters: QueryFilters = {
  startDate: '',
  endDate: '',
  minMs: 30_000,
  metric: 'plays',
  page: 1,
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )
  const [bounds, setBounds] = useState<DateBounds | null>(null)
  const [filters, setFilters] = useState(defaultFilters)
  const [tracks, setTracks] = useState<TrackResult[]>([])
  const [totalTracks, setTotalTracks] = useState(0)
  const [artwork, setArtwork] = useState<Record<string, string>>({})
  const [rowCount, setRowCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('Preparing analytics')
  const [error, setError] = useState('')
  const [authReady, setAuthReady] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [cacheState, setCacheState] = useState<'checking' | 'cached' | 'session'>('checking')
  const [activeView, setActiveView] = useState<'overview' | 'insights'>('overview')
  const callbackStarted = useRef(false)
  const restoreStarted = useRef(false)
  const querySequence = useRef(0)

  useEffect(() => {
    if (callbackStarted.current) return
    callbackStarted.current = true
    void handleSpotifyCallback()
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Spotify connection failed.'))
      .finally(() => setAuthReady(true))
  }, [])

  const restoreHistory = useEffectEvent(async () => {
    try {
      const files = await getCachedHistoryFiles()
      if (files.length) {
        setProgressLabel('Restoring your history')
        await ingest(files, false)
      } else {
        setCacheState('session')
      }
    } catch (reason) {
      setCacheState('session')
      setError(reason instanceof Error ? reason.message : 'Cached history could not be restored.')
    } finally {
      setRestoring(false)
    }
  })

  useEffect(() => {
    if (restoreStarted.current) return
    restoreStarted.current = true
    void restoreHistory()
  }, [])

  async function updateFilters(nextFilters: QueryFilters) {
    const sequence = ++querySequence.current
    setFilters(nextFilters)
    setQuerying(true)
    try {
      const result = await analytics.query(nextFilters)
      if (sequence === querySequence.current) {
        setTracks(result.tracks)
        setTotalTracks(result.totalTracks)
        const pageUris = result.tracks.flatMap((track) => track.spotifyTrackUri ? [track.spotifyTrackUri] : [])
        void getTrackArtwork(pageUris)
          .then((images) => {
            if (sequence === querySequence.current) {
              setArtwork((current) => ({ ...current, ...images }))
            }
          })
          .catch(() => undefined)
      }
    } catch (reason) {
      if (sequence === querySequence.current) {
        setError(reason instanceof Error ? reason.message : 'Query failed.')
      }
    } finally {
      if (sequence === querySequence.current) setQuerying(false)
    }
  }

  async function ingest(files: File[], shouldCache = true) {
    setBusy(true)
    setError('')
    setProgress(0)
    try {
      const result = await analytics.ingest(files, (nextProgress, label) => {
        setProgress(nextProgress)
        setProgressLabel(label)
      })
      if (shouldCache) {
        setProgressLabel('Saving history locally')
        try {
          await cacheHistoryFiles(files)
          setCacheState('cached')
        } catch (reason) {
          setCacheState('session')
          setError(reason instanceof Error ? reason.message : 'History loaded, but could not be cached locally.')
        }
      } else {
        setCacheState('cached')
      }
      setRowCount(result.rowCount)
      setBounds(result.bounds)
      const nextFilters: QueryFilters = {
        ...defaultFilters,
        startDate: `${result.bounds.max.slice(0, 4)}-01-01`,
        endDate: `${result.bounds.max.slice(0, 4)}-12-31`,
      }
      void updateFilters(nextFilters)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not process these files.')
    } finally {
      setBusy(false)
    }
  }

  async function clearCache() {
    try {
      await clearCachedHistory()
      setCacheState('session')
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The local history cache could not be cleared.')
      return false
    }
  }

  async function replaceFiles() {
    if (!await clearCache()) return
    setBounds(null)
    setTracks([])
    setTotalTracks(0)
    setArtwork({})
    setRowCount(0)
    setActiveView('overview')
  }

  function exploreRange(startDate: string, endDate: string) {
    setActiveView('overview')
    void updateFilters({ ...filters, startDate, endDate, page: 1 })
  }

  function toggleTheme() {
    const nextTheme = theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = nextTheme
    localStorage.setItem('playback-atlas.theme', nextTheme)
    setTheme(nextTheme)
  }

  return (
    <main>
      <nav className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL}><span>PA</span> Playback Atlas</a>
        <div className="nav-notes">
          <span><LockKeyhole size={13} /> No uploads</span>
          <a href="https://github.com" target="_blank" rel="noreferrer"><Code2 size={15} /> Source</a>
          <button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </nav>

      <header className="hero">
        <div className="hero-index">01 / ARCHIVE</div>
        <h1>Your listening history,<br /><em>mapped.</em></h1>
        <p>Explore years of Spotify playback without sending a single record beyond your browser.</p>
        <div className="privacy-stamp"><Database size={18} /><span>DUCKDB + WEBASSEMBLY<br />RUNNING LOCALLY</span></div>
      </header>

      <div className="workspace">
        {restoring ? (
          <section className="restore-panel" aria-live="polite">
            <LoaderCircle className="restore-spinner" size={30} />
            <span className="kicker">LOCAL CACHE</span>
            <h2>Restoring your history…</h2>
            <p>Rebuilding the private analytics database in this browser.</p>
          </section>
        ) : !bounds ? (
          <FileUpload busy={busy} progress={progress} progressLabel={progressLabel} onFiles={(files) => void ingest(files)} />
        ) : (
          <>
            <div className="dataset-banner">
              <span><strong>{rowCount.toLocaleString()}</strong> plays indexed</span>
              <span>{bounds.min} → {bounds.max}</span>
              <span className={`cache-status ${cacheState === 'cached' ? 'is-cached' : ''}`}><HardDrive size={14} /> {cacheState === 'cached' ? 'Cached locally' : 'Session only'}</span>
              <div className="dataset-actions">
                {cacheState === 'cached' && <button onClick={() => void clearCache()}><Trash2 size={14} /> Clear cache</button>}
                <button onClick={() => void replaceFiles()}><RotateCcw size={14} /> Replace files</button>
                <PlaylistButton bounds={bounds} authReady={authReady} />
              </div>
            </div>
            <div className="view-switch segmented" aria-label="Dashboard section">
              <button className={activeView === 'overview' ? 'active' : ''} onClick={() => setActiveView('overview')}><ListMusic size={15} /> Overview</button>
              <button className={activeView === 'insights' ? 'active' : ''} onClick={() => setActiveView('insights')}><BarChart3 size={15} /> Insights</button>
            </div>
            {activeView === 'overview' ? (
              <Dashboard bounds={bounds} filters={filters} tracks={tracks} totalTracks={totalTracks} artwork={artwork} loading={querying} onChange={(nextFilters) => void updateFilters(nextFilters)} />
            ) : (
              <Insights bounds={bounds} authReady={authReady} onExploreRange={exploreRange} />
            )}
          </>
        )}
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      </div>

      <footer>Playback Atlas <span>Private by architecture, not policy.</span></footer>
    </main>
  )
}

export default App
