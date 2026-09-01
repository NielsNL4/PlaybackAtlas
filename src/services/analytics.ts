import type { AnalyticsResult, IngestResult, InsightQuery, InsightResult, PlaylistRankingRequest, PlaylistRankingResult, QueryFilters } from '../types'

type ProgressCallback = (progress: number, label: string) => void

interface PendingRequest<T> {
  resolve: (result: T) => void
  reject: (error: Error) => void
  onProgress?: ProgressCallback
}

type WorkerResponse =
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'progress'; progress: number; label: string }
  | { id: number; type: 'error'; error: string }

class AnalyticsService {
  private worker = new Worker(
    new URL('../workers/duckdb.worker.ts', import.meta.url),
    { type: 'module' },
  )

  private sequence = 0
  private pending = new Map<number, PendingRequest<unknown>>()

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(data.id)
      if (!request) return

      if (data.type === 'progress') {
        request.onProgress?.(data.progress, data.label)
        return
      }

      this.pending.delete(data.id)
      if (data.type === 'error') request.reject(new Error(data.error))
      else request.resolve(data.result)
    }

    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Analytics worker failed to start')
      this.pending.forEach((request) => request.reject(error))
      this.pending.clear()
    }
  }

  private request<T>(message: object, onProgress?: ProgressCallback) {
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        onProgress,
      })
      this.worker.postMessage({ ...message, id })
    })
  }

  ingest(files: File[], onProgress: ProgressCallback) {
    return this.request<IngestResult>({ type: 'ingest', files }, onProgress)
  }

  query(filters: QueryFilters) {
    return this.request<AnalyticsResult>({ type: 'query', filters })
  }

  queryPlaylist(request: PlaylistRankingRequest) {
    return this.request<PlaylistRankingResult>({ type: 'playlist', request })
  }

  queryInsights(request: InsightQuery) {
    return this.request<InsightResult>({ type: 'insights', request })
  }
}

export const analytics = new AnalyticsService()
