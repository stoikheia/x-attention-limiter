// IndexedDB wrapper shared by the service worker (writer) and the Debug page (reader).
// Stores (SPEC §32): posts (PostSnapshots), attention (AttentionEvents), states (StateEvents).

const DB_NAME = 'x-attention-limiter';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export class XalDB {
  constructor() {
    this.db = null;
    this.opening = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('posts')) {
          const s = db.createObjectStore('posts', { keyPath: 'id' });
          s.createIndex('lastSeenAt', 'lastSeenAt');
          s.createIndex('firstSeenAt', 'firstSeenAt');
          s.createIndex('cost', 'cost');
        }
        if (!db.objectStoreNames.contains('attention')) {
          const s = db.createObjectStore('attention', { autoIncrement: true });
          s.createIndex('ts', 'ts');
        }
        if (!db.objectStoreNames.contains('states')) {
          const s = db.createObjectStore('states', { autoIncrement: true });
          s.createIndex('ts', 'ts');
        }
      };
      r.onsuccess = () => {
        this.db = r.result;
        this.db.onversionchange = () => {
          this.db.close();
          this.db = null;
        };
        resolve(this.db);
      };
      r.onerror = () => reject(r.error);
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  async _store(name, mode) {
    const db = await this.open();
    const tx = db.transaction(name, mode);
    return { tx, store: tx.objectStore(name) };
  }

  // ---- posts ----
  async getPost(id) {
    const { store } = await this._store('posts', 'readonly');
    return req(store.get(id));
  }

  async putPosts(list) {
    if (!list.length) return;
    const { tx, store } = await this._store('posts', 'readwrite');
    for (const p of list) store.put(p);
    await txDone(tx);
  }

  async getPosts(ids) {
    const { store } = await this._store('posts', 'readonly');
    const out = await Promise.all(ids.map((id) => req(store.get(id))));
    return out.filter(Boolean);
  }

  async getAllPosts() {
    const { store } = await this._store('posts', 'readonly');
    return req(store.getAll());
  }

  async countPosts() {
    const { store } = await this._store('posts', 'readonly');
    return req(store.count());
  }

  async deletePosts(ids) {
    if (!ids.length) return;
    const { tx, store } = await this._store('posts', 'readwrite');
    for (const id of ids) store.delete(id);
    await txDone(tx);
  }

  // ---- attention events: { ts, postId, delta } ----
  async addAttention(list) {
    if (!list.length) return;
    const { tx, store } = await this._store('attention', 'readwrite');
    for (const e of list) store.add(e);
    await txDone(tx);
  }

  // Ranges are [lo, hi): half-open, so adjacent ranges never share an event.
  async getAttention(lo, hi) {
    const { store } = await this._store('attention', 'readonly');
    return req(store.index('ts').getAll(IDBKeyRange.bound(lo, hi, false, true)));
  }

  async countAttention() {
    const { store } = await this._store('attention', 'readonly');
    return req(store.count());
  }

  // ---- state events: { ts, state } ----
  async addState(ev) {
    const { tx, store } = await this._store('states', 'readwrite');
    store.add(ev);
    await txDone(tx);
  }

  async getStates(lo, hi) {
    const { store } = await this._store('states', 'readonly');
    return req(store.index('ts').getAll(IDBKeyRange.bound(lo, hi, false, true)));
  }

  // Last state event strictly before ts (to know the state at the left edge of a chart window).
  async lastStateBefore(ts) {
    const { store } = await this._store('states', 'readonly');
    return new Promise((resolve, reject) => {
      const r = store.index('ts').openCursor(IDBKeyRange.upperBound(ts, true), 'prev');
      r.onsuccess = () => resolve(r.result ? r.result.value : null);
      r.onerror = () => reject(r.error);
    });
  }

  // ---- maintenance ----
  async deleteRange(storeName, lo, hi) {
    const { tx, store } = await this._store(storeName, 'readwrite');
    const r = store.index('ts').openCursor(IDBKeyRange.bound(lo, hi));
    r.onsuccess = () => {
      const c = r.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    await txDone(tx);
  }

  async prune({ retentionDays, maxPosts, eventRetentionDays }) {
    const now = Date.now();
    const posts = await this.getAllPosts();
    const cutoff = now - retentionDays * 86400e3;
    let victims = posts.filter((p) => p.lastSeenAt < cutoff).map((p) => p.id);
    const survivors = posts.filter((p) => p.lastSeenAt >= cutoff).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    if (survivors.length > maxPosts) {
      victims = victims.concat(survivors.slice(0, survivors.length - maxPosts).map((p) => p.id));
    }
    await this.deletePosts(victims);
    const evCutoff = now - eventRetentionDays * 86400e3;
    await this.deleteRange('attention', 0, evCutoff);
    await this.deleteRange('states', 0, evCutoff);
    return victims.length;
  }

  async clearAll() {
    const db = await this.open();
    const tx = db.transaction(['posts', 'attention', 'states'], 'readwrite');
    tx.objectStore('posts').clear();
    tx.objectStore('attention').clear();
    tx.objectStore('states').clear();
    await txDone(tx);
  }

  async exportAll() {
    const db = await this.open();
    const tx = db.transaction(['posts', 'attention', 'states'], 'readonly');
    const [posts, attention, states] = await Promise.all([
      req(tx.objectStore('posts').getAll()),
      req(tx.objectStore('attention').getAll()),
      req(tx.objectStore('states').getAll()),
    ]);
    return { exportedAt: new Date().toISOString(), posts, attention, states };
  }
}
