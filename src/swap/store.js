'use strict';

// Short-lived memory for the swap flow. The site quotes, then executes the
// quote by id, then polls a tracking id — this remembers what each id meant.
//
// In memory on purpose: the API is one process, the entries live for seconds
// to an hour, and losing them on a restart costs a buyer one re-quote. Nothing
// here is a record of money; Relay's requestId is the durable handle.

const crypto = require('crypto');

function createStore({ ttlMs, max = 5000, now = Date.now } = {}) {
  const map = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k);
    // Bounded: a flood of quotes cannot grow memory without limit. Oldest go
    // first (Map keeps insertion order).
    while (map.size > max) map.delete(map.keys().next().value);
  }

  return {
    /** Stores `value`, returns { id, expiresAt }. */
    put(value, id = crypto.randomBytes(12).toString('hex')) {
      sweep();
      const expiresAt = now() + ttlMs;
      map.set(id, { value, expiresAt });
      return { id, expiresAt };
    },
    /** The value, or null when unknown or expired. */
    get(id) {
      const e = map.get(String(id));
      if (!e) return null;
      if (e.expiresAt <= now()) {
        map.delete(String(id));
        return null;
      }
      return e.value;
    },
    /** Merges `patch` into a live entry without extending its life. */
    patch(id, patch) {
      const e = map.get(String(id));
      if (e && e.expiresAt > now()) e.value = { ...e.value, ...patch };
    },
    size: () => map.size,
  };
}

module.exports = { createStore };
