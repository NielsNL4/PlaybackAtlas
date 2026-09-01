import { Code2, Database, LockKeyhole, Moon, RotateCcw, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { FileUpload } from './components/FileUpload'
import { PlaylistButton } from './components/PlaylistButton'
import { analytics } from './services/analytics'
import { handleSpotifyCallback } from './services/spotify'
import type { DateBounds, QueryFilters, TrackResult } from './types'

const defaultFilters: QueryFilters = {
  startDate: '',
  endDate: '',
  minMs: 30_000,
  metric: 'plays',
  limit: 50,
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )
  const [bounds, setBounds] = useState<DateBounds | null>(null)
  const [filters, setFilters] = useState(defaultFilters)
  const [tracks, setTracks] = useState<TrackResult[]>([])
  const [rowCount, setRowCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [querying, setQuerying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('Preparing analytics')
  const [error, setError] = useState('')
  const [authReady, setAuthReady] = useState(false)
  const callbackStarted = useRef(false)
  const querySequence = useRef(0)

  useEffect(() => {
    if (callbackStarted.current) return
    callbackStarted.current = true
    void handleSpotifyCallback()
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Spotify connection failed.'))
      .finally(() => setAuthReady(true))
  }, [])

  async function updateFilters(nextFilters: QueryFilters) {
    const sequence = ++querySequence.current
    setFilters(nextFilters)
    setQuerying(true)
    try {
      const result = await analytics.query(nextFilters)
      if (sequence === querySequence.current) setTracks(result)
    } catch (reason) {
      if (sequence === querySequence.current) {
        setError(reason instanceof Error ? reason.message : 'Query failed.')
      }
    } finally {
      if (sequence === querySequence.current) setQuerying(false)
    }
  }

  async function ingest(files: File[]) {
    setBusy(true)
    setError('')
    setProgress(0)
    try {
      const result = await analytics.ingest(files, (nextProgress, label) => {
        setProgress(nextProgress)
        setProgressLabel(label)
      })
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

  const rangeLabel = filters.startDate && filters.endDate
    ? `${filters.startDate} to ${filters.endDate}`
    : 'Selected Period'

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
        {!bounds ? (
          <FileUpload busy={busy} progress={progress} progressLabel={progressLabel} onFiles={(files) => void ingest(files)} />
        ) : (
          <>
            <div className="dataset-banner">
              <span><strong>{rowCount.toLocaleString()}</strong> plays indexed</span>
              <span>{bounds.min} → {bounds.max}</span>
              <button onClick={() => { setBounds(null); setTracks([]); setRowCount(0) }}><RotateCcw size={14} /> Replace files</button>
              <PlaylistButton tracks={tracks} rangeLabel={rangeLabel} authReady={authReady} />
            </div>
            <Dashboard bounds={bounds} filters={filters} tracks={tracks} loading={querying} onChange={(nextFilters) => void updateFilters(nextFilters)} />
          </>
        )}
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      </div>

      <footer>Playback Atlas <span>Private by architecture, not policy.</span></footer>
    </main>
  )
}

export default App
