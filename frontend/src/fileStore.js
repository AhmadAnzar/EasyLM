// Keeps the files you upload inside the browser (IndexedDB) so the PDF preview still works after a
// page refresh. Every call fails soft: if IndexedDB is unavailable (private window, blocked, full)
// the app simply works without the stored copy.

const DB_NAME = 'easylm'
const STORE = 'files'
const MAX_STORED_BYTES = 200 * 1024 * 1024 // don't try to keep anything bigger than this

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run(mode, action) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = action(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(request?.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function putFile(id, file) {
  if (!file || file.size > MAX_STORED_BYTES) return false
  try {
    await run('readwrite', (store) => store.put(file, id))
    return true
  } catch {
    return false
  }
}

export async function getFile(id) {
  try {
    return (await run('readonly', (store) => store.get(id))) || null
  } catch {
    return null
  }
}

export async function removeFile(id) {
  try {
    await run('readwrite', (store) => store.delete(id))
  } catch {
    // nothing to do
  }
}

export async function clearFiles() {
  try {
    await run('readwrite', (store) => store.clear())
  } catch {
    // nothing to do
  }
}
