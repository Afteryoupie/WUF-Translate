/**
 * Clean-Room CacheManager (M01)
 *
 * Implements a dual-layer cache architecture:
 * - L1: Memory LRU cache (fastest lookup, default capacity: 500 items).
 * - L2: IndexedDB persistent cache (retains translations across sessions).
 * - Key computation: SHA-256(sourceLang:targetLang:engine:model:text).
 * - Supports TTL expiration (default 7 days) and graceful fallback if IndexedDB is unavailable.
 */

export interface CacheEntry {
  key: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  engine: string;
  model: string;
  createdAt: number;
  lastAccessedAt: number;
  ttlMs: number;
}

export interface CacheLookupParams {
  text: string;
  sourceLang?: string;
  targetLang: string;
  engine: string;
  model?: string;
}

export interface CacheStoreParams extends CacheLookupParams {
  translatedText: string;
  ttlMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  memorySize: number;
}

export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_L1_CAPACITY = 500;
const DB_NAME = 'wuf_cache_db';
const DB_VERSION = 1;
const STORE_NAME = 'translations';

export async function computeCacheKey(params: CacheLookupParams): Promise<string> {
  const sourceLang = (params.sourceLang || 'auto').trim().toLowerCase();
  const targetLang = (params.targetLang || 'zh-TW').trim().toLowerCase();
  const engine = (params.engine || '').trim().toLowerCase();
  const model = (params.model || '').trim().toLowerCase();
  const text = params.text || '';

  const rawKey = `${sourceLang}:${targetLang}:${engine}:${model}:${text}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(rawKey);

  if (globalThis.crypto?.subtle?.digest) {
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Pure fallback hash for environments lacking crypto.subtle
  let hash = 0;
  for (let i = 0; i < rawKey.length; i++) {
    const char = rawKey.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `fallback_${Math.abs(hash).toString(16)}`;
}

export class CacheManager {
  private l1Map = new Map<string, CacheEntry>();
  private readonly capacity: number;
  private hits = 0;
  private misses = 0;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor(capacity: number = DEFAULT_L1_CAPACITY) {
    this.capacity = capacity;
  }

  private getDb(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof globalThis.indexedDB === 'undefined') {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise(resolve => {
      try {
        const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  private touchL1(entry: CacheEntry): void {
    this.l1Map.delete(entry.key);
    this.l1Map.set(entry.key, entry);
    if (this.l1Map.size > this.capacity) {
      const oldestKey = this.l1Map.keys().next().value;
      if (oldestKey !== undefined) {
        this.l1Map.delete(oldestKey);
      }
    }
  }

  public async get(params: CacheLookupParams): Promise<string | null> {
    const key = await computeCacheKey(params);
    const now = Date.now();

    // 1. Check L1 Memory Cache
    const memEntry = this.l1Map.get(key);
    if (memEntry) {
      if (memEntry.ttlMs > 0 && now - memEntry.createdAt > memEntry.ttlMs) {
        this.l1Map.delete(key);
      } else {
        memEntry.lastAccessedAt = now;
        this.touchL1(memEntry);
        this.hits++;
        return memEntry.translatedText;
      }
    }

    // 2. Check L2 IndexedDB Cache
    const db = await this.getDb();
    if (!db) {
      this.misses++;
      return null;
    }

    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);

        req.onsuccess = () => {
          const entry = req.result as CacheEntry | undefined;
          if (!entry) {
            this.misses++;
            resolve(null);
            return;
          }

          if (entry.ttlMs > 0 && now - entry.createdAt > entry.ttlMs) {
            this.misses++;
            resolve(null);
            // Async delete expired item
            void this.deleteFromDb(key);
            return;
          }

          entry.lastAccessedAt = now;
          this.touchL1(entry);
          this.hits++;
          resolve(entry.translatedText);
        };

        req.onerror = () => {
          this.misses++;
          resolve(null);
        };
      } catch {
        this.misses++;
        resolve(null);
      }
    });
  }

  public async set(params: CacheStoreParams): Promise<void> {
    if (!params.translatedText || !params.translatedText.trim()) return;

    const key = await computeCacheKey(params);
    const now = Date.now();
    const entry: CacheEntry = {
      key,
      sourceText: params.text,
      translatedText: params.translatedText,
      sourceLang: (params.sourceLang || 'auto').trim().toLowerCase(),
      targetLang: (params.targetLang || 'zh-TW').trim().toLowerCase(),
      engine: (params.engine || '').trim().toLowerCase(),
      model: (params.model || '').trim().toLowerCase(),
      createdAt: now,
      lastAccessedAt: now,
      ttlMs: params.ttlMs ?? DEFAULT_CACHE_TTL_MS,
    };

    // Store in L1
    this.touchL1(entry);

    // Store in L2
    const db = await this.getDb();
    if (!db) return;

    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);
    } catch {
      // Best-effort storage
    }
  }

  public async getBatch(items: CacheLookupParams[]): Promise<Array<string | null>> {
    return Promise.all(items.map(item => this.get(item)));
  }

  public async setBatch(items: CacheStoreParams[]): Promise<void> {
    await Promise.all(items.map(item => this.set(item)));
  }

  private async deleteFromDb(key: string): Promise<void> {
    const db = await this.getDb();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
    } catch {
      // Ignore
    }
  }

  public async clear(): Promise<void> {
    this.l1Map.clear();
    this.hits = 0;
    this.misses = 0;

    const db = await this.getDb();
    if (!db) return;

    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  public getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      memorySize: this.l1Map.size,
    };
  }
}

// Global default singleton for extension background/shared use
export const globalCacheManager = new CacheManager();
