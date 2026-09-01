import { CheckCircle2, ExternalLink, LogOut, Music2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  connectSpotify,
  createPlaylist,
  disconnectSpotify,
  getSpotifySession,
  type CreatedPlaylist,
  type SpotifySession,
} from '../services/spotify'
import type { TrackResult } from '../types'

interface PlaylistButtonProps {
  tracks: TrackResult[]
  rangeLabel: string
  authReady: boolean
}

export function PlaylistButton({ tracks, rangeLabel, authReady }: PlaylistButtonProps) {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<SpotifySession | null>(null)
  const [isPublic, setIsPublic] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<CreatedPlaylist | null>(null)
  const eligible = tracks.filter((track) => track.spotifyTrackUri?.startsWith('spotify:track:'))

  useEffect(() => {
    if (authReady) void getSpotifySession().then(setSession)
  }, [authReady])

  async function submit() {
    setCreating(true)
    setError('')
    try {
      const playlist = await createPlaylist(
        `Top Tracks - ${rangeLabel} (Exported)`,
        eligible.flatMap((track) => track.spotifyTrackUri ? [track.spotifyTrackUri] : []),
        isPublic,
      )
      setCreated(playlist)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Playlist creation failed.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <button className="spotify-button" onClick={() => setOpen(true)} disabled={!tracks.length}>
        <Music2 size={17} /> Create playlist
      </button>
      {open && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="playlist-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-button close" aria-label="Close" onClick={() => setOpen(false)}><X /></button>
            {created ? (
              <div className="success-state">
                <CheckCircle2 size={44} />
                <span className="kicker">PLAYLIST READY</span>
                <h2>{created.name}</h2>
                <p>{created.trackCount} tracks were added to your Spotify account.</p>
                <a className="primary-action" href={created.url} target="_blank" rel="noreferrer">Open in Spotify <ExternalLink size={16} /></a>
              </div>
            ) : (
              <>
                <span className="kicker">EXPORT TO SPOTIFY</span>
                <h2 id="playlist-title">Turn the chart into a playlist.</h2>
                <p>{eligible.length} of {tracks.length} ranked tracks have a valid Spotify URI.</p>
                {!session ? (
                  <button className="primary-action" onClick={() => void connectSpotify()}>Connect Spotify</button>
                ) : (
                  <>
                    <div className="account-row">
                      <span>Connected as <strong>{session.displayName}</strong></span>
                      <button onClick={() => { disconnectSpotify(); setSession(null) }}><LogOut size={14} /> Disconnect</button>
                    </div>
                    <label className="check-row">
                      <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
                      Make this playlist public
                    </label>
                    <button className="primary-action" disabled={creating || !eligible.length} onClick={() => void submit()}>
                      {creating ? 'Building playlist…' : `Create with ${eligible.length} tracks`}
                    </button>
                  </>
                )}
                {error && <p className="inline-error">{error}</p>}
              </>
            )}
          </section>
        </div>
      )}
    </>
  )
}
