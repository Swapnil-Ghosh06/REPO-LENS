// idb.js - Minimal IndexedDB wrapper for RepoLens

const DB_NAME = "RepoLensDB";
const DB_VERSION = 1;

/**
 * Opens (or upgrades) the RepoLens database
 */
async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Chunks object store
      if (!db.objectStoreNames.contains("chunks")) {
        const store = db.createObjectStore("chunks", { keyPath: "chunk_id" });
        store.createIndex("by_repo", "repo_url", { unique: false });
      }

      // Meta object store for provider info
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Store an array of chunk objects for a repo
 * Each chunk: { chunk_id, repo_url, embedding: Float32Array, document: string, metadata: object }
 */
async function storeChunks(repoUrl, chunks) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readwrite");
    const store = tx.objectStore("chunks");

    for (const chunk of chunks) {
      store.put(chunk);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Delete all chunks for a repo (called before re-indexing)
 */
async function deleteChunks(repoUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readwrite");
    const store = tx.objectStore("chunks");
    const index = store.index("by_repo");
    const request = index.openCursor(IDBKeyRange.only(repoUrl));

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Return all chunks for a repo as an array
 */
async function getChunks(repoUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readonly");
    const store = tx.objectStore("chunks");
    const index = store.index("by_repo");
    const request = index.getAll(IDBKeyRange.only(repoUrl));

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Store provider used for a repo ("gemini" or "cohere")
 */
async function setProvider(repoUrl, provider) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    store.put({ key: `provider::${repoUrl}`, value: provider });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get provider for a repo (returns "gemini" by default)
 */
async function getProvider(repoUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readonly");
    const store = tx.objectStore("meta");
    const request = store.get(`provider::${repoUrl}`);

    request.onsuccess = () => {
      const result = request.result;
      resolve(result ? result.value : "gemini");
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Check if a repo has any stored chunks
 */
async function isIndexed(repoUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readonly");
    const store = tx.objectStore("chunks");
    const index = store.index("by_repo");
    const request = index.count(IDBKeyRange.only(repoUrl));

    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => reject(request.error);
  });
}
