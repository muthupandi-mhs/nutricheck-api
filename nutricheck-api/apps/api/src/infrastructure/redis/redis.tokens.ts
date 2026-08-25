/**
 * Two clients, two logical databases, because their eviction policies differ.
 *
 * db 0 holds BullMQ jobs and must never evict. db 1 holds the phrase cache and
 * draft store and is allkeys-lru. Sharing one database means a cache flood
 * silently evicts queued jobs — see BACKEND.md ADR-006.
 */
export const REDIS_QUEUE = Symbol('REDIS_QUEUE');
export const REDIS_CACHE = Symbol('REDIS_CACHE');

export const REDIS_DB_QUEUE = 0;
export const REDIS_DB_CACHE = 1;
