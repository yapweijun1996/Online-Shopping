import { createHash } from 'node:crypto';

/*
 * Sliding-window attempt limiter kept in the database, so limits survive process
 * restarts and Durable Object eviction. Each attempt reserves a slot before the
 * guarded work runs, so concurrent requests cannot exceed the limit.
 * Client keys are stored as hashes, not raw addresses.
 */
export class SqlLimiter {
  constructor(store, bucket, { limit, windowMs, now = Date.now }) {
    this.store = store;
    this.bucket = bucket;
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  #keyHash(key) {
    return createHash('sha256').update(`${this.bucket}:${key}`).digest('hex');
  }

  async attempt(key) {
    const now = this.now();
    const keyHash = this.#keyHash(key);
    return await this.store.transaction(async () => {
      await this.store.run('DELETE FROM rate_limit_attempt WHERE bucket = ? AND attempted_at <= ?', this.bucket, now - this.windowMs);
      const { count } = await this.store.get('SELECT COUNT(*) AS count FROM rate_limit_attempt WHERE bucket = ? AND key_hash = ?',
        this.bucket, keyHash);
      if (count >= this.limit) return false;
      await this.store.run('INSERT INTO rate_limit_attempt(bucket, key_hash, attempted_at) VALUES (?, ?, ?)', this.bucket, keyHash, now);
      return true;
    });
  }

  async clear(key) {
    await this.store.run('DELETE FROM rate_limit_attempt WHERE bucket = ? AND key_hash = ?', this.bucket, this.#keyHash(key));
  }
}
