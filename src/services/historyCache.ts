const DATABASE_NAME = 'playback-atlas'
const DATABASE_VERSION = 1
const STORE_NAME = 'history'
const ACTIVE_HISTORY_KEY = 'active'

interface StoredFile {
  name: string
  type: string
  lastModified: number
  data: Blob
}

interface StoredHistory {
  id: typeof ACTIVE_HISTORY_KEY
  files: StoredFile[]
  savedAt: number
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Local history storage could not be opened.'))
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Local history storage failed.'))
    transaction.onabort = () => reject(transaction.error || new Error('Local history storage was interrupted.'))
  })
}

export async function cacheHistoryFiles(files: File[]) {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const history: StoredHistory = {
      id: ACTIVE_HISTORY_KEY,
      savedAt: Date.now(),
      files: files.map((file) => ({
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        data: file,
      })),
    }
    transaction.objectStore(STORE_NAME).put(history)
    await transactionComplete(transaction)
  } catch (error) {
    if (error instanceof DOMException && ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error.name)) {
      throw new Error('The history loaded, but this browser does not have enough storage to cache the files.')
    }
    throw error
  } finally {
    database.close()
  }
}

export async function getCachedHistoryFiles() {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(ACTIVE_HISTORY_KEY)
    const history = await new Promise<StoredHistory | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredHistory | undefined)
      request.onerror = () => reject(request.error || new Error('Cached history could not be read.'))
    })
    await transactionComplete(transaction)
    return history?.files.map((file) => new File([file.data], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    })) || []
  } finally {
    database.close()
  }
}

export async function clearCachedHistory() {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(ACTIVE_HISTORY_KEY)
    await transactionComplete(transaction)
  } finally {
    database.close()
  }
}
