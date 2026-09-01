import { CheckCircle2, ExternalLink, LogOut, Music2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { analytics } from '../services/analytics'
import {
  connectSpotify,
  createPlaylist,
  disconnectSpotify,
  getSpotifySession,
  type CreatedPlaylist,
  type SpotifySession,
} from '../services/spotify'
import type { DateBounds, PlaylistRankingRequest } from '../types'

interface PlaylistButtonProps {
  bounds: DateBounds
  authReady: boolean
}

type PlaylistMode = 'year' | 'months'
type PlaylistSize = 50 | 100 | 250 | 500

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function monthRange(year: number, month: number) {
  const paddedMonth = String(month).padStart(2, '0')
  const endDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  return { startDate: `${year}-${paddedMonth}-01`, endDate }
}

export function PlaylistButton({ bounds, authReady }: PlaylistButtonProps) {
  const availableYears = Array.from(
    { length: Number(bounds.max.slice(0, 4)) - Number(bounds.min.slice(0, 4)) + 1 },
    (_, index) => Number(bounds.max.slice(0, 4)) - index,
  )
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<SpotifySession | null>(null)
  const [mode, setMode] = useState<PlaylistMode>('year')
  const [year, setYear] = useState(availableYears[0])
  const [size, setSize] = useState<PlaylistSize>(100)
  const [selectedYears, setSelectedYears] = useState<number[]>([availableYears[0]])
  const [selectedMonths, setSelectedMonths] = useState<number[]>(MONTHS.map((_, index) => index + 1))
  const [minMs, setMinMs] = useState(30_000)
  const [isPublic, setIsPublic] = useState(false)
  const [creating, setCreating] = useState(false)
  const [finished, setFinished] = useState(false)
  const [created, setCreated] = useState<CreatedPlaylist[]>([])
  const [skipped, setSkipped] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [connectError, setConnectError] = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 1, label: '' })

  useEffect(() => {
    if (authReady) void getSpotifySession().then(setSession)
  }, [authReady])

  function toggleSelection(value: number, current: number[], update: (values: number[]) => void) {
    update(current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value].sort((a, b) => a - b))
  }

  function resetResults() {
    setFinished(false)
    setCreated([])
    setSkipped(0)
    setErrors([])
  }

  async function beginConnection() {
    setConnectError('')
    try {
      await connectSpotify()
    } catch (reason) {
      setConnectError(reason instanceof Error ? reason.message : 'Spotify connection could not be started.')
    }
  }

  async function ranking(request: PlaylistRankingRequest) {
    const result = await analytics.queryPlaylist(request)
    return result.spotifyTrackUris
  }

  async function createYearPlaylist() {
    setProgress({ current: 0, total: 1, label: `Ranking ${year}` })
    const uris = await ranking({
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      minMs,
      limit: size,
    })
    if (!uris.length) throw new Error(`No Spotify tracks were found for ${year}.`)

    const name = `${year} — Top ${size}`
    setProgress({ current: 0, total: 1, label: `Creating ${name}` })
    const playlist = await createPlaylist(name, uris, isPublic)
    setCreated([playlist])
    setProgress({ current: 1, total: 1, label: 'Complete' })
  }

  async function createMonthlyPlaylists() {
    const jobs = [...selectedYears]
      .sort((a, b) => a - b)
      .flatMap((selectedYear) => selectedMonths.map((month) => ({ year: selectedYear, month })))
    const completed: CreatedPlaylist[] = []
    const failures: string[] = []
    let emptyMonths = 0

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]
      const name = `${job.year} — ${MONTHS[job.month - 1]}`
      setProgress({ current: index, total: jobs.length, label: `Ranking ${name}` })
      try {
        const dates = monthRange(job.year, job.month)
        const uris = await ranking({ ...dates, minMs, limit: 50 })
        if (!uris.length) {
          emptyMonths += 1
          setSkipped(emptyMonths)
          continue
        }
        setProgress({ current: index, total: jobs.length, label: `Creating ${name}` })
        const playlist = await createPlaylist(name, uris, isPublic)
        completed.push(playlist)
        setCreated([...completed])
      } catch (reason) {
        failures.push(`${name}: ${reason instanceof Error ? reason.message : 'Creation failed.'}`)
        setErrors([...failures])
      } finally {
        setProgress({ current: index + 1, total: jobs.length, label: `Processed ${name}` })
      }
    }
  }

  async function submit() {
    setCreating(true)
    resetResults()
    try {
      if (mode === 'year') await createYearPlaylist()
      else await createMonthlyPlaylists()
    } catch (reason) {
      setErrors([reason instanceof Error ? reason.message : 'Playlist creation failed.'])
    } finally {
      setCreating(false)
      setFinished(true)
    }
  }

  const monthlySelectionValid = selectedYears.length > 0 && selectedMonths.length > 0
  const progressPercent = Math.round((progress.current / Math.max(progress.total, 1)) * 100)

  return (
    <>
      <button className="spotify-button" onClick={() => setOpen(true)}>
        <Music2 size={17} /> Create playlist
      </button>
      {open && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!creating) setOpen(false) }}>
          <section className="modal playlist-modal" role="dialog" aria-modal="true" aria-labelledby="playlist-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-button close" aria-label="Close" disabled={creating} onClick={() => setOpen(false)}><X /></button>
            {!session ? (
              <>
                <span className="kicker">EXPORT TO SPOTIFY</span>
                <h2 id="playlist-title">Connect to build your playlists.</h2>
                <p>Your history stays local. Spotify receives only the selected track URIs when playlists are created.</p>
                <div className="connect-area">
                  <button className="connect-button" onClick={() => void beginConnection()}>Connect Spotify</button>
                </div>
                {connectError && <p className="inline-error">{connectError}</p>}
              </>
            ) : finished ? (
              <div className="playlist-results">
                <CheckCircle2 size={42} />
                <span className="kicker">EXPORT COMPLETE</span>
                <h2 id="playlist-title">Your playlists are ready.</h2>
                <p>{created.length} created{skipped ? `, ${skipped} empty months skipped` : ''}{errors.length ? `, ${errors.length} failed` : ''}.</p>
                {created.length > 0 && (
                  <div className="created-playlists">
                    {created.map((playlist) => (
                      <a key={playlist.url} href={playlist.url} target="_blank" rel="noreferrer">
                        <span>{playlist.name}<small>{playlist.trackCount} tracks</small></span>
                        <ExternalLink size={15} />
                      </a>
                    ))}
                  </div>
                )}
                {errors.length > 0 && <div className="playlist-errors">{errors.map((error) => <p key={error}>{error}</p>)}</div>}
                <button className="primary-action" onClick={resetResults}>Configure another export</button>
              </div>
            ) : (
              <>
                <div className="playlist-modal-heading">
                  <div>
                    <span className="kicker">PLAYLIST WORKSHOP</span>
                    <h2 id="playlist-title">Choose what to export.</h2>
                  </div>
                  <button className="disconnect-button" onClick={() => { disconnectSpotify(); setSession(null) }}><LogOut size={14} /> {session.displayName}</button>
                </div>

                <div className="segmented playlist-mode">
                  <button className={mode === 'year' ? 'active' : ''} onClick={() => setMode('year')}>One year</button>
                  <button className={mode === 'months' ? 'active' : ''} onClick={() => setMode('months')}>Monthly set</button>
                </div>

                {mode === 'year' ? (
                  <div className="playlist-form-grid">
                    <label className="playlist-field">Year
                      <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
                        {availableYears.map((availableYear) => <option key={availableYear}>{availableYear}</option>)}
                      </select>
                    </label>
                    <fieldset className="playlist-field">
                      <legend>Number of tracks</legend>
                      <div className="choice-grid size-choices">
                        {([50, 100, 250, 500] as PlaylistSize[]).map((option) => (
                          <button type="button" key={option} className={size === option ? 'selected' : ''} onClick={() => setSize(option)}>{option}</button>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                ) : (
                  <div className="monthly-options">
                    <fieldset className="playlist-field">
                      <legend>Years</legend>
                      <div className="choice-grid year-choices">
                        {availableYears.map((availableYear) => (
                          <button type="button" key={availableYear} aria-pressed={selectedYears.includes(availableYear)} className={selectedYears.includes(availableYear) ? 'selected' : ''} onClick={() => toggleSelection(availableYear, selectedYears, setSelectedYears)}>{availableYear}</button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset className="playlist-field">
                      <legend>Months · Top 50 each</legend>
                      <div className="choice-grid month-choices">
                        {MONTHS.map((month, index) => (
                          <button type="button" key={month} aria-pressed={selectedMonths.includes(index + 1)} className={selectedMonths.includes(index + 1) ? 'selected' : ''} onClick={() => toggleSelection(index + 1, selectedMonths, setSelectedMonths)}>{month.slice(0, 3)}</button>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                )}

                <div className="playlist-footer-options">
                  <label className="playlist-field">Minimum play
                    <select value={minMs} onChange={(event) => setMinMs(Number(event.target.value))}>
                      <option value={0}>No minimum</option>
                      <option value={10000}>10 seconds</option>
                      <option value={30000}>30 seconds</option>
                      <option value={60000}>1 minute</option>
                    </select>
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
                    Make playlists public
                  </label>
                </div>

                {creating && (
                  <div className="creation-progress" aria-live="polite">
                    <span>{progress.label}</span><strong>{progress.current}/{progress.total}</strong>
                    <span className="progress-track"><span style={{ width: `${progressPercent}%` }} /></span>
                  </div>
                )}
                <button className="primary-action" disabled={creating || (mode === 'months' && !monthlySelectionValid)} onClick={() => void submit()}>
                  {creating ? 'Creating playlists…' : mode === 'year' ? `Create ${year} — Top ${size}` : `Create ${selectedYears.length * selectedMonths.length} monthly playlists`}
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </>
  )
}
