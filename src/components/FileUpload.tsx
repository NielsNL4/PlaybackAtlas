import { FileJson, ShieldCheck, UploadCloud } from 'lucide-react'
import { useRef, useState } from 'react'

interface FileUploadProps {
  busy: boolean
  progress: number
  progressLabel: string
  onFiles: (files: File[]) => void
}

export function FileUpload({ busy, progress, progressLabel, onFiles }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function accept(files: FileList | null) {
    const jsonFiles = Array.from(files || []).filter((file) => file.name.toLowerCase().endsWith('.json'))
    if (jsonFiles.length) onFiles(jsonFiles)
  }

  return (
    <section className="upload-panel" aria-labelledby="upload-title">
      <div className="eyebrow"><ShieldCheck size={14} /> Local processing only</div>
      <h2 id="upload-title">Drop your listening archive.</h2>
      <p>Your files stay in this browser. Nothing is uploaded to a server.</p>

      <button
        type="button"
        className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          accept(event.dataTransfer.files)
        }}
      >
        {busy ? <FileJson size={32} /> : <UploadCloud size={32} />}
        <span>{busy ? progressLabel : 'Choose JSON files or drag them here'}</span>
        <small>Streaming_History_Audio_*.json or endsong_*.json</small>
        {busy && (
          <span className="progress-track" aria-label={`${progress}% processed`}>
            <span style={{ width: `${progress}%` }} />
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        multiple
        hidden
        onChange={(event) => {
          accept(event.target.files)
          event.target.value = ''
        }}
      />
    </section>
  )
}
