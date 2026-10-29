'use strict';
// Fil: IndexedDB access.

/* ---------- Storage ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('fil', 3);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const make = (name, keyPath, byThread) => {
        if (db.objectStoreNames.contains(name)) return;
        const store = db.createObjectStore(name, { keyPath });
        if (byThread) store.createIndex('thread', 'thread');
      };
      make('threads', 'id', false);
      make('notes', 'key', true);
      make('stars', 'key', true);
      make('prefs', 'k', false);
      // Version 2: chapters, the monthly memory (À retenir, people and places), questions asked.
      make('chapters', 'key', true);
      make('memory', 'key', true);
      make('asks', 'key', true);
      // Version 3: messages apart from the thread (loaded only when the thread is opened), people.
      make('bodies', 'id', false);
      make('people', 'id', false);
      if (event.oldVersion >= 1 && event.oldVersion < 3) {
        const tx = request.transaction;
        const bodies = tx.objectStore('bodies');
        tx.objectStore('threads').openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const thread = cursor.value;
          if (Array.isArray(thread.messages)) {
            bodies.put({ id: thread.id, messages: thread.messages });
            cursor.update(threadMeta(thread));
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function read(storeName, run) {
  return new Promise((resolve, reject) => {
    const request = run(state.db.transaction(storeName).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function write(storeName, run) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, 'readwrite');
    run(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error(t('writeCancelled')));
  });
}

const getAll = (name) => read(name, (s) => s.getAll());
const getOne = (name, key) => read(name, (s) => s.get(key));
const getByThread = (name, id) => read(name, (s) => s.index('thread').getAll(id));
const put = (name, value) => write(name, (s) => s.put(value));
const remove = (name, key) => write(name, (s) => s.delete(key));

// What the home screen needs to know about a thread, without its messages.
function threadMeta(thread) {
  const per = {};
  for (const m of thread.messages) per[m.from] = (per[m.from] || 0) + 1;
  const participants = thread.participants || [];
  return {
    id: thread.id,
    platform: thread.platform || 'messenger',
    kind: thread.kind || (participants.length > 2 ? 'group' : 'duo'),
    title: thread.title || '',
    participants,
    me: thread.me ?? participants[0] ?? null,
    ranges: thread.ranges || [],
    imports: thread.imports || [],
    count: thread.messages.length,
    first: thread.messages[0]?.ts ?? null,
    last: thread.messages[thread.messages.length - 1]?.ts ?? null,
    per,
  };
}

// A thread is kept in two records: its description, and its messages.
function saveThread(thread) {
  const meta = threadMeta(thread);
  Object.assign(thread, meta);
  const i = state.threads.findIndex((t) => t.id === meta.id);
  if (i === -1) state.threads.push(meta);
  else state.threads[i] = meta;
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(['threads', 'bodies'], 'readwrite');
    tx.objectStore('threads').put(meta);
    tx.objectStore('bodies').put({ id: meta.id, messages: thread.messages });
    tx.oncomplete = () => resolve(thread);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error(t('writeCancelled')));
  });
}

async function loadThread(metaOrId) {
  const id = typeof metaOrId === 'string' ? metaOrId : metaOrId.id;
  if (state.thread?.id === id && Array.isArray(state.thread.messages)) return state.thread;
  const meta = state.threads.find((t) => t.id === id);
  if (!meta) return null;
  const body = await getOne('bodies', id);
  return { ...meta, messages: body?.messages || [] };
}

function savePrefs() {
  if (!state.thread) return;
  const conv = state.convs[state.conv];
  put('prefs', { k: 'ui', thread: state.thread.id, at: conv?.from }).catch(() => {});
}

