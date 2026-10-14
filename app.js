'use strict';
// Fil: reads a Messenger export (end-to-end encrypted chats, JSON), keeps it
// in IndexedDB, merges later exports into it, cuts it into conversations
// (a silence longer than the chosen gap starts a new one) and summarises
// each conversation with any OpenAI-compatible service.

const GAP_TIME = 30 * 60e3; // a time separator inside a conversation after 30 minutes of silence
const GAP_GROUP = 5 * 60e3; // bubbles closer than 5 minutes stick together
const GAP_CHOICES = [30, 60, 120, 180]; // minutes of silence that end a conversation
const DEFAULT_GAP = 60;
const RANGE_JOIN = 24 * 3600e3; // two exports less than a day apart are one stretch: the gap is just silence
const MIN_TEXTS = 4; // shorter conversations are skipped by "summarise all"
const PARALLEL = 3;
const CONTEXT_BEFORE = 3; // summaries of the previous conversations sent as context
const TIMEOUT = 120e3;

const ICONS = {
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z M16 16l4.5 4.5',
  close: 'M7 7l10 10 M17 7L7 17',
  bubble: 'M7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6.5l-4 3.5V16H7a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 7 4z',
  star: 'M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z',
  doc: 'M7.5 3.5h9a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z M9.5 8h5 M9.5 11.5h5 M9.5 15h3',
  import: 'M12 4v10 M8 10l4 4 4-4 M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15',
  save: 'M12 14V4 M8 8l4-4 4 4 M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15',
  prev: 'M14.5 6l-6 6 6 6',
  next: 'M9.5 6l6 6-6 6',
  copy: 'M9.5 9h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z M15 9V6.5a1 1 0 0 0-1-1H6.5a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1H8.5',
  check: 'M5.5 12.5l4 4 9-9',
  photo: 'M5.5 6h13a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M4.5 15l4-4 3.5 3.5 2.5-2.5 5 5 M15 9.5h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  undo: 'M9 7L5 11l4 4 M5 11h9a5 5 0 0 1 0 10h-2',
  funnel: 'M4.5 5.5h15l-5.75 7v5.25l-3.5 1.75v-7z',
  chart: 'M5 19v-7 M10 19V5 M15 19v-5 M20 19V9 M3.5 19.5h17',
  person: 'M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5z M5 20a7 7 0 0 1 14 0',
  scissors: 'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M8.6 8.2L19 17 M8.6 15.8L19 7',
  merge: 'M7 4v4a5 5 0 0 0 5 5 5 5 0 0 1 5 5v2 M17 4v4a5 5 0 0 1-3 4.6 M4 17l3 3 3-3',
  sliders: 'M4 7h9 M17 7h3 M15 5v4 M4 17h3 M11 17h9 M9 15v4',
  frise: 'M3.5 12h17 M7 8.5v7 M11 6v12 M15 9v6 M18.5 10.5v3',
  spark: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
};

const fmt = {
  time: new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  dayMid: new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
  dayLong: new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  month: new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }),
  date: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }),
  dayMonth: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }),
  monthShort: new Intl.DateTimeFormat('fr-FR', { month: 'short' }),
  full: new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
};

const state = {
  db: null,
  threads: [],
  thread: null,
  gap: DEFAULT_GAP,
  llm: null, // { url, model, key }
  convs: [],
  notes: [], // summary records of the thread
  noteLinks: new Map(), // conversation index -> overlapping summary records
  summary: new Map(), // conversation index -> what to show: { status, kind, own, parts, title, text }
  stars: new Map(), // message id -> star record
  view: 'fil', // fil | favoris | resumes | reglages
  conv: 0,
  query: '',
  exact: false,
  who: null,
  folded: null, // { exact: string[], loose: string[] }, built on the first search
  nodes: new Map(), // message id -> rendered row of the open conversation
  working: new Set(), // conversation ids being summarised
  batch: null,
  mode: 'resume', // what a conversation shows first: resume | messages
  writing: null, // conversation whose empty summary is being written by hand
  span: 365, // days shown on the timeline (0: only what is imported)
  sel: null, // { from, to } chosen on the timeline
  zoom: null, // { from, to } shown by the timeline when zoomed in
  searchSort: 'score',
  searchLimit: 60,
  answer: null, // last answer of "Demander à Fil": { query, thread, text }
  asking: false,
  pending: null, // an export waiting for confirmation
  dragging: false,
  cuts: { merge: [], split: [], llm: {} }, // corrections of the cut, see cuts.js
  chapters: new Map(), // key -> chapter of a week or a month
  memory: new Map(), // key -> what a month left to remember (facts, people, places)
  factsDone: new Map(), // fact id -> when it was ticked
  asks: new Map(), // key -> question asked and its answer
  resView: 'convs',
  exportOpen: false,
  factType: 'all',
  showDone: false,
  portrait: null, // last portrait of both people, see stats.js
  portraitBusy: false,
  tags: [], // { name, kind: sujet | ambiance } of the open conversation thread
  filter: { from: null, to: null, tags: [], any: false, status: 'all', min: 0, sort: 'old' },
  calendar: null, // which date of the filter is being picked: from | to
  calMonth: null,
  calFor: null,
};

const $ = (selector) => document.querySelector(selector);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (n) => n.toLocaleString('fr-FR');
const firstName = (name) => (name || '?').split(' ')[0];
const plural = (n, one, many) => `${num(n)} ${n > 1 ? many : one}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function duration(ms) {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} jours`;
  const rest = minutes % 60;
  return rest && hours < 10 ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
}

/* ---------- Storage ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('fil', 2);
    request.onupgradeneeded = () => {
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
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('écriture annulée'));
  });
}

const getAll = (name) => read(name, (s) => s.getAll());
const getOne = (name, key) => read(name, (s) => s.get(key));
const getByThread = (name, id) => read(name, (s) => s.index('thread').getAll(id));
const put = (name, value) => write(name, (s) => s.put(value));
const remove = (name, key) => write(name, (s) => s.delete(key));

function savePrefs() {
  if (!state.thread) return;
  const conv = state.convs[state.conv];
  put('prefs', { k: 'ui', thread: state.thread.id, at: conv?.from }).catch(() => {});
}

/* ---------- Reading an export ---------- */

// FNV-1a, enough to tell messages sent at the same millisecond apart.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Messenger gives no message id. The id is the time, a fingerprint of the
// content and the rank among identical messages of the same millisecond
// (several photos sent together), so the same message gets the same id in
// every export and overlapping exports do not duplicate anything.
function readMessenger(json, fileName) {
  if (!json || !Array.isArray(json.messages) || !Array.isArray(json.participants)) {
    throw new Error(`« ${fileName} » n’est pas un export Messenger : il n’y a pas de liste de messages dedans.`);
  }
  const participants = json.participants.map(String).filter(Boolean);
  if (!participants.length) throw new Error(`« ${fileName} » ne dit pas qui participe à la conversation.`);
  const ranks = new Map();
  const messages = [];
  for (const m of json.messages) {
    if (!m || !Number.isFinite(m.timestamp)) continue;
    const from = String(m.senderName ?? '');
    const type = String(m.type ?? 'text');
    const text = typeof m.text === 'string' ? m.text : '';
    const base = `${m.timestamp.toString(36)}.${hash(`${from}\u0001${type}\u0001${text}`)}`;
    const rank = ranks.get(base) ?? 0;
    ranks.set(base, rank + 1);
    messages.push({
      id: `${base}.${rank}`,
      ts: m.timestamp,
      from,
      type,
      text,
      unsent: Boolean(m.isUnsent),
      media: Array.isArray(m.media) ? m.media.length : 0,
      react: Array.isArray(m.reactions)
        ? m.reactions.filter((r) => r && r.reaction).map((r) => [String(r.actor ?? ''), String(r.reaction)])
        : [],
    });
  }
  if (!messages.length) throw new Error(`« ${fileName} » ne contient aucun message.`);
  return { participants, messages };
}

function cleanStored(m) {
  if (!m || typeof m.id !== 'string' || !Number.isFinite(m.ts)) return null;
  return {
    id: m.id,
    ts: m.ts,
    from: String(m.from ?? ''),
    type: String(m.type ?? 'text'),
    text: typeof m.text === 'string' ? m.text : '',
    unsent: Boolean(m.unsent),
    media: Number.isFinite(m.media) ? m.media : 0,
    react: Array.isArray(m.react) ? m.react.filter((r) => Array.isArray(r) && r.length === 2).map((r) => [String(r[0]), String(r[1])]) : [],
    at: Number.isFinite(m.at) ? m.at : 0,
  };
}

function threadId(participants) {
  return [...participants].sort().join('\u0001');
}

// Messages already stored are never changed: an export only adds what is missing.
function mergeMessages(thread, incoming) {
  const known = new Set(thread.messages.map((m) => m.id));
  const at = Date.now();
  const fresh = incoming.filter((m) => !known.has(m.id)).map((m) => ({ ...m, at: m.at || at }));
  thread.messages = thread.messages.concat(fresh).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return fresh.length;
}

function addRange(ranges, from, to, join = 0) {
  const all = [...ranges, [from, to]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + join) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Stretches of time the stored messages cover, for display: two exports less
// than a day apart read as one stretch (the gap is just silence).
function coverage(thread) {
  return thread.ranges.reduce((out, [a, b]) => addRange(out, a, b, RANGE_JOIN), []);
}

// What an export would add. A message inside a period already imported is
// left out even when it differs from what is stored (unsent since, edited):
// what is stored wins, the export only fills the periods that are missing.
function planImport(participants, messages, file) {
  const id = threadId(participants);
  const thread = state.threads.find((t) => t.id === id) || null;
  const from = messages.reduce((a, m) => Math.min(a, m.ts), Infinity);
  const to = messages.reduce((a, m) => Math.max(a, m.ts), -Infinity);
  const plan = { id, participants, thread, messages, file, from, to, fresh: [], dup: 0, conflict: 0 };
  const known = new Set(thread ? thread.messages.map((m) => m.id) : []);
  const ranges = thread ? thread.ranges : [];
  for (const m of messages) {
    if (known.has(m.id)) plan.dup++;
    else if (ranges.some(([a, b]) => m.ts >= a && m.ts <= b)) plan.conflict++;
    else plan.fresh.push(m);
  }
  return plan;
}

async function commitImport(plan) {
  let thread = state.threads.find((t) => t.id === plan.id);
  if (!thread) {
    thread = { id: plan.id, participants: plan.participants, me: plan.participants[0], messages: [], ranges: [], imports: [] };
    state.threads.push(thread);
  }
  const added = mergeMessages(thread, plan.fresh);
  thread.ranges = addRange(thread.ranges, plan.from, plan.to);
  thread.imports.push({ at: Date.now(), file: plan.file, from: plan.from, to: plan.to, count: plan.messages.length, added, ignored: plan.conflict });
  await put('threads', thread);
  return { thread, added };
}

// Summary records cover a span of time [from, to]. Records written by the
// first version covered a day (5:00 to 5:00): they are read as that span.
function cleanNote(n, threads) {
  if (!n || !threads.has(n.thread) || typeof n.text !== 'string') return null;
  let { from, to } = n;
  if (!Number.isFinite(from) && typeof n.day === 'string') {
    const [y, m, d] = n.day.split('-').map(Number);
    from = new Date(y, m - 1, d, 5).getTime();
    to = from + 24 * 3600e3 - 1;
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    key: typeof n.key === 'string' && n.key.startsWith(`${n.thread}|`) ? n.key : `${n.thread}|${n.first ?? n.day ?? from}|${to}`,
    thread: n.thread,
    first: typeof n.first === 'string' ? n.first : null,
    from,
    to,
    count: Number(n.count) || 0,
    title: typeof n.title === 'string' ? n.title : '',
    text: n.text,
    by: typeof n.by === 'string' ? n.by : '',
    tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
    updatedAt: Number(n.updatedAt) || Date.now(),
  };
}

async function restoreBackup(json) {
  let added = 0;
  let last = null;
  for (const t of Array.isArray(json.threads) ? json.threads : []) {
    if (!t || !Array.isArray(t.participants) || !Array.isArray(t.messages)) continue;
    const participants = t.participants.map(String);
    const messages = t.messages.map(cleanStored).filter(Boolean);
    const id = threadId(participants);
    let thread = state.threads.find((x) => x.id === id);
    if (!thread) {
      thread = { id, participants, me: String(t.me || participants[0]), messages: [], ranges: [], imports: [] };
      state.threads.push(thread);
    }
    added += mergeMessages(thread, messages);
    for (const r of Array.isArray(t.ranges) ? t.ranges : []) {
      if (Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1])) thread.ranges = addRange(thread.ranges, r[0], r[1]);
    }
    await put('threads', thread);
    last = thread;
  }
  const known = new Set(state.threads.map((t) => t.id));
  const current = new Map((await getAll('notes')).map((n) => [n.key, n]));
  let notesKept = 0;
  for (const raw of Array.isArray(json.notes) ? json.notes : []) {
    const n = cleanNote(raw, known);
    if (!n || typeof n.key !== 'string') continue;
    const mine = current.get(n.key);
    if (mine && (mine.updatedAt || 0) >= n.updatedAt) continue;
    await put('notes', n);
    notesKept++;
  }
  for (const r of Array.isArray(json.tags) ? json.tags : []) {
    if (!r || typeof r.k !== 'string' || !known.has(r.k.slice(5)) || !Array.isArray(r.list)) continue;
    const mine = (await getOne('prefs', r.k))?.list || [];
    const list = [...mine];
    for (const t of r.list) {
      if (t && typeof t.name === 'string' && !list.some((x) => tagKey(x.name) === tagKey(t.name))) list.push({ name: cleanTagName(t.name), kind: t.kind === 'ambiance' ? 'ambiance' : 'sujet', at: Number(t.at) || Date.now() });
    }
    await put('prefs', { k: r.k, list });
  }
  for (const store of ['chapters', 'memory', 'asks']) {
    for (const r of Array.isArray(json[store]) ? json[store] : []) {
      if (!r || typeof r.key !== 'string' || !known.has(r.thread)) continue;
      const mine = await getOne(store, r.key);
      if (!mine || (mine.updatedAt || mine.at || 0) < (r.updatedAt || r.at || 0)) await put(store, r);
    }
  }
  for (const r of Array.isArray(json.prefs) ? json.prefs : []) {
    if (!r || typeof r.k !== 'string' || !known.has(r.k.slice(r.k.indexOf('|') + 1))) continue;
    const mine = await getOne('prefs', r.k);
    if (r.k.startsWith('portrait|') && typeof r.text === 'string' && (!mine || (mine.at || 0) < (r.at || 0))) await put('prefs', r);
    if (r.k.startsWith('facts|')) await put('prefs', { k: r.k, done: { ...(r.done || {}), ...(mine?.done || {}) } });
    if (r.k.startsWith('cuts|')) {
      const a = cleanCuts(mine);
      const b = cleanCuts(r);
      await put('prefs', { k: r.k, merge: [...new Set([...a.merge, ...b.merge])], split: [...new Set([...a.split, ...b.split])], llm: { ...b.llm, ...a.llm } });
    }
  }
  let starsKept = 0;
  for (const s of Array.isArray(json.stars) ? json.stars : []) {
    if (!s || !known.has(s.thread) || typeof s.msg !== 'string') continue;
    await put('stars', { key: `${s.thread}|${s.msg}`, thread: s.thread, msg: s.msg, at: Number(s.at) || Date.now() });
    starsKept++;
  }
  return { thread: last, added, notesKept, starsKept };
}

function importReport(plan, added, thread) {
  const parts = [`${titleOf(thread)} : ${added ? plural(added, 'nouveau message', 'nouveaux messages') : 'aucun nouveau message'}`];
  if (plan.dup) parts.push(plural(plan.dup, 'déjà présent', 'déjà présents'));
  if (plan.conflict) parts.push(`${plural(plan.conflict, 'ignoré', 'ignorés')} car dans une période que tu avais déjà`);
  return `${parts.join(', ')}. Tu as maintenant ${spanText(thread)}.`;
}

async function importFiles(files) {
  const lines = [];
  let errors = 0;
  let target = null;
  for (const file of files) {
    try {
      let json;
      try {
        json = JSON.parse(await file.text());
      } catch {
        throw new Error(`« ${file.name} » n’est pas un fichier JSON lisible. Choisis le fichier .json téléchargé depuis Messenger.`);
      }
      if (json && json.fil === 1) {
        const r = await restoreBackup(json);
        target = r.thread || target;
        lines.push(`Sauvegarde « ${file.name} » réimportée : ${plural(r.added, 'message ajouté', 'messages ajoutés')}, ${plural(r.notesKept, 'résumé', 'résumés')}, ${plural(r.starsKept, 'favori', 'favoris')}.`);
        continue;
      }
      const { participants, messages } = readMessenger(json, file.name);
      const plan = planImport(participants, messages, file.name);
      // A single export for a conversation already here: show it on the timeline first.
      if (files.length === 1 && plan.thread) {
        state.pending = plan;
        if (state.thread !== plan.thread) await selectThread(plan.thread);
        return showView('frise');
      }
      const r = await commitImport(plan);
      target = r.thread;
      lines.push(importReport(plan, r.added, r.thread));
    } catch (e) {
      errors++;
      lines.push(e.name === 'QuotaExceededError' ? 'Plus de place pour enregistrer la conversation sur ce PC.' : e.message);
    }
  }
  if (target) {
    const at = state.thread === target ? state.convs[state.conv]?.from : null;
    await selectThread(target, at);
  } else render();
  showNotice(lines.join('\n'), errors === files.length ? 'error' : 'info');
}

async function confirmImport() {
  const pending = state.pending;
  state.pending = null;
  try {
    const plan = planImport(pending.participants, pending.messages, pending.file); // recomputed: the data may have changed meanwhile
    const r = await commitImport(plan);
    await selectThread(r.thread, state.convs[state.conv]?.from, 'frise');
    showNotice(importReport(plan, r.added, r.thread));
  } catch (e) {
    showView('frise');
    showNotice(e.name === 'QuotaExceededError' ? 'Plus de place pour enregistrer la conversation sur ce PC.' : `L’ajout a échoué : ${e.message}`, 'error');
  }
}

async function backup() {
  try {
    // The LLM settings (and its key) are not part of the backup.
    const data = {
      fil: 1,
      savedAt: new Date().toISOString(),
      threads: await getAll('threads'),
      notes: await getAll('notes'),
      stars: await getAll('stars'),
      tags: (await getAll('prefs')).filter((r) => typeof r.k === 'string' && r.k.startsWith('tags|')),
      chapters: await getAll('chapters'),
      memory: await getAll('memory'),
      asks: await getAll('asks'),
      prefs: (await getAll('prefs')).filter((r) => typeof r.k === 'string' && (r.k.startsWith('facts|') || r.k.startsWith('cuts|') || r.k.startsWith('portrait|'))),
    };
    const name = `fil-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    const link = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    showNotice(`Sauvegarde enregistrée dans Téléchargements : ${name}\nElle contient la conversation, tes résumés et tes favoris (pas ta clé de LLM). « Importer » la remet en place, par exemple après avoir réinstallé l’extension.`);
  } catch (e) {
    showNotice(`La sauvegarde a échoué : ${e.message}`, 'error');
  }
}

/* ---------- Conversations ---------- */

// A conversation ends when nobody writes for longer than the chosen gap,
// unless the LLM or a correction by hand decided otherwise (see cuts.js).
function buildConvs(messages, gapMinutes) {
  const gap = gapMinutes * 60e3;
  const convs = [];
  const split = new Set(state.cuts.split);
  const merge = new Set(state.cuts.merge);
  const llm = state.cuts.llm[gapMinutes] || {};
  let current = null;
  messages.forEach((m, i) => {
    const starts =
      !current || (split.has(m.id) ? true : merge.has(m.id) ? false : llm[m.id] ? llm[m.id] === 'new' : m.ts - messages[i - 1].ts > gap);
    if (starts) {
      current = { index: convs.length, start: i, end: i + 1, id: m.id, from: m.ts, to: m.ts };
      convs.push(current);
    } else {
      current.end = i + 1;
      current.to = m.ts;
    }
  });
  return convs;
}

const convMessages = (conv) => state.thread.messages.slice(conv.start, conv.end);
const convCount = (conv) => conv.end - conv.start;
const textCount = (conv) => convMessages(conv).filter((m) => m.text && m.type === 'text' && !m.unsent).length;

function convAt(ts) {
  const convs = state.convs;
  let lo = 0;
  let hi = convs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (convs[mid].from <= ts) lo = mid;
    else hi = mid - 1;
  }
  return convs[lo];
}

// Every summary is kept for the cut it was made with: changing the gap or
// redoing a summary never deletes another one. For each conversation of the
// current cut, the summary shown is worked out from the records that overlap it.
function linkNotes() {
  state.noteLinks = new Map();
  state.summary = new Map();
  for (const conv of state.convs) {
    const linked = state.notes.filter((n) => n.from <= conv.to && n.to >= conv.from);
    if (!linked.length) continue;
    state.noteLinks.set(conv.index, linked);
    state.summary.set(conv.index, describe(conv, linked));
  }
}

const isOwn = (n, conv) => n.first === conv.id && n.to === conv.to && n.count === convCount(conv);

// The largest summaries first, then the ones that fill what is left, without overlaps.
function pickParts(notes) {
  const picked = [];
  for (const n of [...notes].sort((a, b) => b.to - b.from - (a.to - a.from))) {
    if (!picked.some((p) => p.from <= n.to && p.to >= n.from)) picked.push(n);
  }
  return picked.sort((a, b) => a.from - b.from);
}

// ok: a summary made for exactly this conversation.
// grouped: no summary of its own, but summaries made with another gap cover
//   it: several smaller ones put end to end, or one larger one. A few
//   messages left out are fine (very short exchanges are never summarised).
// stale: summaries cover only part of it (new messages, or pieces never summarised).
function describe(conv, linked) {
  const own = linked.find((n) => isOwn(n, conv));
  if (own) return { status: 'ok', kind: 'own', own, parts: [own], title: own.title, text: own.text, tags: own.tags || [] };
  const messages = convMessages(conv);
  const inside = pickParts(linked.filter((n) => n.from >= conv.from && n.to <= conv.to));
  const around = linked.find((n) => n.from <= conv.from && n.to >= conv.to && n.count >= convCount(conv));
  const covered = messages.filter((m) => inside.some((n) => m.ts >= n.from && m.ts <= n.to)).length;
  const leftOut = messages.length - covered;
  // Messages imported after the summaries were made are news, never tolerated.
  const madeAt = Math.min(...inside.map((n) => n.updatedAt));
  const news = messages.some((m) => (m.at || 0) > madeAt && !inside.some((n) => m.ts >= n.from && m.ts <= n.to));
  const enough = !news && leftOut <= Math.max(3, Math.floor(messages.length * 0.05));
  let kind = 'stale';
  let parts = pickParts(linked);
  // Same number of messages inside the summarised pieces as when they were made: nothing was added there since.
  if (inside.length && enough && inside.reduce((sum, n) => sum + n.count, 0) === covered) {
    kind = 'parts';
    parts = inside;
  } else if (around) {
    kind = 'around';
    parts = [around];
  }
  const titles = [...new Set(parts.map((n) => n.title).filter(Boolean))];
  const text =
    parts.length === 1
      ? parts[0].text
      : parts.map((n) => `${fmt.time.format(n.from)} → ${fmt.time.format(n.to)}${n.title ? ` · ${n.title}` : ''}\n${n.text.trim()}`).join('\n\n');
  const tags = [...new Set(parts.flatMap((n) => n.tags || []))];
  return { status: kind === 'stale' ? 'stale' : 'grouped', kind, own: null, parts, title: titles.join(' + '), text, tags, leftOut: kind === 'parts' ? leftOut : 0 };
}

function noteStatus(conv) {
  return state.summary.get(conv.index)?.status || 'none';
}

const isSummarized = (conv) => {
  const status = noteStatus(conv);
  return status === 'ok' || status === 'grouped';
};

async function saveConvNote(conv, fields) {
  const own = state.summary.get(conv.index)?.own;
  const record = {
    key: own?.key || `${state.thread.id}|${conv.id}|${conv.to}`,
    thread: state.thread.id,
    first: conv.id,
    from: conv.from,
    to: conv.to,
    count: convCount(conv),
    title: fields.title || '',
    text: fields.text || '',
    by: fields.by || '',
    tags: fields.tags ?? own?.tags ?? [],
    updatedAt: Date.now(),
  };
  const keep = record.text.trim() || record.title.trim() || record.tags.length;
  if (keep) await put('notes', record);
  else await remove('notes', record.key);
  state.notes = state.notes.filter((n) => n.key !== record.key);
  if (keep) state.notes.push(record);
  state.notes.sort((a, b) => a.from - b.from);
  linkNotes();
}

const tsOfId = (id) => parseInt(id.split('.')[0], 36);
const titleOf = (thread) => thread.participants.filter((p) => p !== thread.me).join(', ') || thread.participants[0];

function spanText(thread) {
  const parts = coverage(thread).map(([a, b]) => {
    const sameYear = new Date(a).getFullYear() === new Date(b).getFullYear();
    return `du ${(sameYear ? fmt.dayMonth : fmt.date).format(a)} au ${fmt.date.format(b)}`;
  });
  return parts.length ? parts.join(', puis ') : 'aucun message';
}

const convLabel = (conv) => `${cap(fmt.dayMid.format(conv.from))} ${new Date(conv.from).getFullYear()}, ${fmt.time.format(conv.from)} → ${fmt.time.format(conv.to)}`;

/* ---------- Search ---------- */

const LETTER = /\p{L}/u;
const MARK = /\p{M}/gu;
const SYMBOL = /[^\p{L}\p{N}]/u;
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
const DIGIT_SOUND = { 2: '', 3: '', 5: 'kh', 7: 'h', 8: 'gh', 9: 'k' };

// Turns a text into a search form and keeps, for each output character, the
// index of the original one (to highlight what matched).
// Exact form: lower case, no accents.
// Loose form, for darja written in latin letters: vowels dropped (khedma = khdma),
// letters doubled for emphasis count once (wesh = weshhh), sh = ch, dj = j,
// q = k, and the digits used as letters read as sounds (3, 7, 9, 5, 8, 2).
function fold(text, loose) {
  const out = [];
  const map = [];
  const push = (ch, i) => {
    const last = out[out.length - 1];
    if (loose) {
      if (ch === last && map[map.length - 1] === i - 1 && ch !== ' ') {
        map[map.length - 1] = i;
        return;
      }
      if (ch === 'h' && last === 's') out[out.length - 1] = 'c';
      if (ch === 'j' && last === 'd') {
        out[out.length - 1] = 'j';
        map[map.length - 1] = i;
        return;
      }
    }
    out.push(ch);
    map.push(i);
  };
  for (let i = 0; i < text.length; i++) {
    for (const ch of text[i].toLowerCase().normalize('NFD').replace(MARK, '')) {
      if (loose) {
        if (ch in DIGIT_SOUND && (LETTER.test(text[i - 1] || '') || LETTER.test(text[i + 1] || ''))) {
          for (const s of DIGIT_SOUND[ch]) push(s, i);
          continue;
        }
        if (VOWELS.has(ch)) continue;
        if (ch === 'q') {
          push('k', i);
          continue;
        }
        if (/\s/.test(ch)) {
          if (out.length && out[out.length - 1] !== ' ') push(' ', i);
          continue;
        }
        if (SYMBOL.test(ch)) continue;
      }
      push(ch, i);
    }
  }
  return { s: out.join(''), map };
}

function folded() {
  if (!state.folded) {
    const messages = state.thread.messages;
    state.folded = {
      exact: messages.map((m) => fold(m.text, false).s),
      loose: messages.map((m) => fold(m.text, true).s),
    };
  }
  return state.folded;
}

/* ---------- LLM ---------- */

function endpoint(url) {
  const clean = url.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(clean) ? clean : `${clean}/chat/completions`;
}

function originPattern(url) {
  const u = new URL(url.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('L’adresse doit commencer par https:// (ou http:// pour un service sur ce PC).');
  return `${u.protocol}//${u.hostname}/*`;
}

async function chat(messages, signal) {
  const { url, model, key } = state.llm || {};
  if (!url || !model) throw new Error('Aucun LLM configuré : ouvre les Réglages.');
  if (!(await chrome.permissions.contains({ origins: [originPattern(url)] }))) {
    throw new Error('Fil n’a pas encore le droit de contacter ce service. Ouvre les Réglages et clique sur « Enregistrer et tester ».');
  }
  const timeout = AbortSignal.timeout(TIMEOUT);
  let response;
  try {
    response = await fetch(endpoint(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timeout.aborted) throw new Error('Le service n’a pas répondu en 2 minutes.');
    throw new Error(`Impossible de joindre ${new URL(endpoint(url)).host} : vérifie l’adresse et ta connexion.`);
  }
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  if (!response.ok) {
    const detail = json?.error?.message || json?.detail || json?.message || raw.slice(0, 200);
    const hint = response.status === 401 || response.status === 403 ? ' La clé est refusée.' : response.status === 404 ? ' Vérifie l’adresse et le nom du modèle.' : '';
    throw new Error(`Le service a répondu ${response.status}.${hint}${detail ? `\n${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Le service a répondu, mais sans texte (format inattendu).');
  return text;
}

function systemPrompt() {
  const thread = state.thread;
  const me = firstName(thread.me);
  const others = thread.participants.filter((p) => p !== thread.me).map(firstName).join(', ');
  return [
    `Tu résumes des conversations Messenger privées entre ${me} (c’est lui qui te demande le résumé) et ${others}.`,
    'Elles sont écrites en darja algérienne (en lettres latines, avec des chiffres pour certains sons : 3 = ع, 7 = ح, 9 = ق, 5 = خ, 8 = غ), en français et en anglais, souvent mélangés dans la même phrase.',
    `${me} a des trous de mémoire : il veut pouvoir retrouver plus tard ce qui s’est dit.`,
    'Réponds en français, exactement dans ce format :',
    'TITRE: <de 4 à 8 mots qui disent le sujet principal>',
    'TAGS: <de 2 à 5 tags, famille/nom, séparés par des virgules>',
    '- <point>',
    '- <point>',
    'Garde : les faits, les décisions, les projets et les dates, ce que chacun a promis ou demandé, les émotions ou tensions importantes, et ce qui reste en suspens. Si la conversation change de sujet, un point par sujet. Cite une phrase courte seulement si elle compte vraiment.',
    'De 2 à 8 points selon la longueur. Pas d’introduction, pas de conclusion, pas de conseils.',
    tagRules(),
  ].join('\n');
}

function userPrompt(conv) {
  const parts = [];
  const before = [];
  for (let i = conv.index - 1; i >= 0 && before.length < CONTEXT_BEFORE; i--) {
    const c = state.convs[i];
    if (isSummarized(c)) before.unshift(c);
  }
  if (before.length) {
    parts.push('Contexte, pour comprendre les références (résumés des conversations juste avant, à ne pas résumer) :');
    for (const c of before) {
      const sum = state.summary.get(c.index);
      parts.push(`${convLabel(c)}${sum.title ? ` : ${sum.title}` : ''}\n${sum.text.trim()}`);
    }
    parts.push('');
  }
  parts.push(tagList(), '');
  parts.push(`Conversation à résumer : ${convLabel(conv)} (${plural(convCount(conv), 'message', 'messages')}).`, '---', transcriptLines(conv).join('\n'));
  return parts.join('\n');
}

function parseSummary(text) {
  const lines = text.trim().split('\n');
  let title = '';
  const index = lines.findIndex((l) => /^\s*[#*]*\s*titre\s*[*]*\s*:/i.test(l));
  if (index !== -1) {
    title = lines[index].replace(/^\s*[#*]*\s*titre\s*[*]*\s*:\s*/i, '').replace(/\*+/g, '').trim();
    lines.splice(index, 1);
  }
  const tags = parseTagsLine(lines);
  return { title, tags, text: lines.join('\n').trim() };
}

async function summarize(conv, signal) {
  const thread = state.thread;
  state.working.add(conv.id);
  refreshConv(conv);
  try {
    const answer = await chat([{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPrompt(conv) }], signal);
    if (state.thread !== thread) return;
    const now = state.convs[conv.index];
    if (!now || now.id !== conv.id) return; // the cut changed meanwhile
    const parsed = parseSummary(answer);
    const { names, added, renames } = resolveTags(parsed.tags);
    if (added) await saveTags();
    if (renames.size) await retag(renames);
    await saveConvNote(conv, { title: parsed.title, text: parsed.text, tags: names, by: state.llm.model });
  } finally {
    state.working.delete(conv.id);
    refreshConv(conv);
  }
}

async function summarizeOne(conv, button) {
  if (!state.llm?.url) return showView('reglages');
  if (button) button.disabled = true;
  try {
    await summarize(conv);
  } catch (e) {
    if (button) button.disabled = false;
    showNotice(`Le résumé n’a pas pu être fait.\n${e.message}`, 'error');
  }
}

// Conversations that would be sent: no summary yet and long enough. Saved
// summaries are never asked again, only "Refaire le résumé" does that.
const toSummarize = (convs) => convs.filter((c) => noteStatus(c) === 'none' && textCount(c) >= MIN_TEXTS);

// Runs a job on each item, a few at a time, with progress in the sidebar and a Stop button.
async function runJobs(items, job, label, [one, many]) {
  if (state.batch) return;
  if (!state.llm?.url) return showView('reglages');
  if (!items.length) return;
  const controller = new AbortController();
  state.batch = { done: 0, total: items.length, failed: 0, controller, lastError: '', label };
  const refresh = () => ['resumes', 'frise', 'tags', 'reglages'].includes(state.view) && !state.query && renderMain();
  renderBatch();
  refresh();
  let next = 0;
  let streak = 0;
  const worker = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const item = items[next++];
      try {
        await job(item, controller.signal);
        streak = 0;
      } catch (e) {
        if (controller.signal.aborted) break;
        state.batch.failed++;
        state.batch.lastError = e.message;
        if (++streak >= 3) controller.abort();
      }
      state.batch.done++;
      renderBatch();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const { done, failed, lastError } = state.batch;
  const stopped = controller.signal.aborted;
  state.batch = null;
  renderBatch();
  refresh();
  if (failed) showNotice(`${stopped && failed >= 3 ? 'Arrêté après 3 erreurs de suite.' : `${num(failed)} en échec.`}\n${lastError}`, 'error');
  else showNotice(`${plural(done, one, many)}${stopped ? ' (arrêté)' : ''}.`);
}

function runBatch(convs = state.convs, kind = 'summary') {
  const tags = kind === 'tags';
  const todo = tags ? toTag(convs) : toSummarize(convs);
  if (!todo.length) return showNotice(tags ? 'Toutes ces conversations résumées ont déjà des tags.' : 'Toutes ces conversations ont déjà un résumé (ou sont trop courtes pour en avoir un).');
  return runJobs(todo, tags ? tagConv : summarize, tags ? 'Tags' : 'Résumés', tags ? ['conversation taguée', 'conversations taguées'] : ['conversation résumée', 'conversations résumées']);
}

function renderBatch() {
  const box = $('#batch');
  const b = state.batch;
  box.hidden = !b;
  if (!b) return;
  const stop = el('button', { type: 'button', class: 'pill small', text: 'Arrêter', onclick: () => b.controller.abort() });
  box.replaceChildren(
    el('div', { class: 'batch-line' }, el('span', { text: `${b.label} : ${num(b.done)} / ${num(b.total)}${b.failed ? ` · ${plural(b.failed, 'erreur', 'erreurs')}` : ''}` }), stop),
    el('div', { class: 'bar' }, el('span', { style: `width:${Math.round((b.done / b.total) * 100)}%` })),
    el('p', { class: 'muted', text: 'Garde cet onglet ouvert.' }),
  );
}

// After a summary changes: the sidebar row, and the main view if it shows it.
function refreshConv(conv) {
  renderTimeline();
  if (state.query) return;
  if (state.view === 'fil' && state.conv === conv.index && !document.activeElement?.closest?.('.card')) {
    if (state.mode === 'resume') return renderMain();
    const top = document.querySelector('.head');
    if (top) top.replaceWith(convHead(conv));
  }
  if ((state.view === 'resumes' || state.view === 'tags') && !state.batch) renderMain();
  if (state.view === 'frise' && !state.dragging) renderMain();
}

/* ---------- Tags ---------- */

const MAX_TAGS = 40;
const TAG_KINDS = [
  ['sujet', 'Sujets', 'de quoi on parle'],
  ['ambiance', 'Ambiance', 'le ton de l’échange'],
];

// Same tag whatever the accents, case or a final s/x: "Tristesse" = "tristesses".
const tagKey = (name) =>
  String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(MARK, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/(\S\S)[sx]\b/g, '$1');

const cleanTagName = (raw) =>
  String(raw)
    .replace(/^[\s#*_"'«-]+|[\s*_.,"'»]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 30);

const findTag = (name) => state.tags.find((t) => tagKey(t.name) === tagKey(name));
const kindOf = (name) => findTag(name)?.kind || 'sujet';

async function saveTags() {
  await put('prefs', { k: `tags|${state.thread.id}`, list: state.tags });
}

// What the LLM answered, matched against the list: an existing tag is reused,
// a new one is added while the list has room, anything else is dropped.
function resolveTags(raw) {
  const names = [];
  const renames = new Map();
  let added = false;
  for (const item of raw) {
    const slash = item.indexOf('/');
    const family = tagKey(slash === -1 ? '' : item.slice(0, slash));
    const name = cleanTagName(slash === -1 ? item : item.slice(slash + 1));
    if (!name || !tagKey(name)) continue;
    let tag = findTag(name);
    if (!tag) {
      if (state.tags.length >= MAX_TAGS) continue;
      tag = { name, kind: family.startsWith('amb') ? 'ambiance' : 'sujet', at: Date.now() };
      state.tags.push(tag);
      added = true;
    } else if (name.length < tag.name.length) {
      // Same tag written shorter (singular): that form wins everywhere.
      renames.set(tag.name, name);
      tag.name = name;
      added = true;
    }
    if (!names.includes(tag.name)) names.push(tag.name);
  }
  return { names: names.slice(0, 6), added, renames };
}

function parseTagsLine(lines) {
  const index = lines.findIndex((l) => /^\s*[#*]*\s*tags?\s*[*]*\s*:/i.test(l));
  if (index === -1) return [];
  const raw = lines[index].replace(/^\s*[#*]*\s*tags?\s*[*]*\s*:\s*/i, '').replace(/\*+/g, '');
  lines.splice(index, 1);
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tagRules() {
  return [
    'Les tags servent à retrouver les conversations plus tard. Deux familles :',
    '- sujet : de quoi on parle (par exemple cadeaux, études, travail, famille, argent, sortie, santé, voyage)',
    '- ambiance : le ton de l’échange (par exemple conflit, débat, tendresse, tristesse, humour, joie, stress, réconciliation)',
    'Donne de 2 à 5 tags, dont au moins un tag ambiance, écrits famille/nom : sujet/cadeaux, ambiance/conflit.',
    'Réutilise d’abord les tags existants, même si tu aurais choisi un mot voisin (pas « triste » si « tristesse » existe).',
    'N’en crée un nouveau que si aucun ne convient vraiment : un nom commun court, en français, au singulier, en minuscules.',
  ].join('\n');
}

function tagList() {
  if (!state.tags.length) return 'Tags existants : aucun pour l’instant, crée les premiers.';
  const of = (kind) =>
    state.tags
      .filter((t) => t.kind === kind)
      .map((t) => t.name)
      .join(', ') || '(aucun)';
  const full = state.tags.length >= MAX_TAGS ? '\nLa liste est complète : utilise uniquement ces tags.' : '';
  return `Tags existants (réutilise-les) :\nsujet : ${of('sujet')}\nambiance : ${of('ambiance')}${full}`;
}

const convTags = (conv) => state.summary.get(conv.index)?.tags || [];
const toTag = (convs) => convs.filter((c) => noteStatus(c) === 'ok' && !convTags(c).length);

async function tagConv(conv, signal) {
  const thread = state.thread;
  state.working.add(conv.id);
  refreshConv(conv);
  try {
    const intro = systemPrompt().split('\n').slice(0, 2).join('\n');
    const answer = await chat(
      [
        { role: 'system', content: `${intro}\nTu dois seulement mettre des tags sur une conversation.\n${tagRules()}\nRéponds par une seule ligne : TAGS: famille/nom, famille/nom` },
        { role: 'user', content: `${tagList()}\n\nConversation : ${convLabel(conv)}\n---\n${transcriptLines(conv).join('\n')}` },
      ],
      signal,
    );
    if (state.thread !== thread || state.convs[conv.index]?.id !== conv.id) return;
    const raw = parseTagsLine(answer.trim().split('\n'));
    if (!raw.length) throw new Error('Le LLM n’a pas donné de ligne « TAGS: ».');
    const { names, added, renames } = resolveTags(raw);
    if (added) await saveTags();
    if (renames.size) await retag(renames);
    await setConvTags(conv, names);
  } finally {
    state.working.delete(conv.id);
    refreshConv(conv);
  }
}

async function setConvTags(conv, names) {
  const sum = state.summary.get(conv.index);
  if (!sum) return;
  await saveConvNote(conv, { title: sum.title, text: sum.text, by: sum.own?.by || '', tags: names });
}

// Renames, merges or removes tags in every summary of the conversation, in one write.
async function retag(map) {
  const changed = [];
  for (const n of state.notes) {
    if (!n.tags?.length) continue;
    const next = [...new Set(n.tags.map((t) => (map.has(t) ? map.get(t) : t)).filter(Boolean))];
    if (next.join('\u0001') !== n.tags.join('\u0001')) {
      n.tags = next;
      changed.push(n);
    }
  }
  if (changed.length) await write('notes', (s) => changed.forEach((n) => s.put(n)));
  state.filter.tags = [...new Set(state.filter.tags.map((t) => (map.has(t) ? map.get(t) : t)).filter(Boolean))];
  linkNotes();
  return changed.length;
}

async function renameTag(tag, raw) {
  const name = cleanTagName(raw);
  if (!name || name === tag.name) return;
  const other = state.tags.find((t) => t !== tag && tagKey(t.name) === tagKey(name));
  if (other) return mergeTag(tag, other);
  const old = tag.name;
  tag.name = name;
  await saveTags();
  await retag(new Map([[old, name]]));
  render();
}

async function mergeTag(tag, into) {
  state.tags = state.tags.filter((t) => t !== tag);
  await saveTags();
  const n = await retag(new Map([[tag.name, into.name]]));
  render();
  showNotice(`« ${tag.name} » fusionné dans « ${into.name} » (${plural(n, 'résumé mis à jour', 'résumés mis à jour')}).`);
}

async function deleteTag(tag) {
  state.tags = state.tags.filter((t) => t !== tag);
  await saveTags();
  const n = await retag(new Map([[tag.name, null]]));
  render();
  showNotice(`Tag « ${tag.name} » supprimé (retiré de ${plural(n, 'résumé', 'résumés')}).`);
}

async function addTag(raw, kind) {
  const name = cleanTagName(raw);
  if (!name) return null;
  const existing = findTag(name);
  if (existing) return existing;
  if (state.tags.length >= MAX_TAGS) {
    showNotice(`La liste a déjà ${MAX_TAGS} tags : fusionne ou supprime-en un avant d’en ajouter.`, 'error');
    return null;
  }
  const tag = { name, kind, at: Date.now() };
  state.tags.push(tag);
  await saveTags();
  return tag;
}

function tagChip(name, conv) {
  const chip = el(
    'span',
    { class: `tag ${kindOf(name)}${state.filter.tags.includes(name) ? ' on' : ''}` },
    el('button', { type: 'button', class: 'tname', text: name, title: 'Voir toutes les conversations avec ce tag', onclick: () => filterByTag(name) }),
  );
  if (conv) {
    chip.append(
      el(
        'button',
        { type: 'button', class: 'x', title: 'Retirer ce tag de cette conversation', 'aria-label': `Retirer ${name}`, onclick: () => setConvTags(conv, convTags(conv).filter((t) => t !== name)).then(() => renderMain()) },
        icon('close'),
      ),
    );
  }
  return chip;
}

function tagRow(conv) {
  const sum = state.summary.get(conv.index);
  if (!sum) return null;
  const tags = sum.tags;
  const row = el('div', { class: 'tagrow' }, tags.map((name) => tagChip(name, conv)));
  if (!tags.length && state.llm?.url && sum.own) {
    const find = el('button', { type: 'button', class: 'tag add', disabled: state.working.has(conv.id) }, icon('spark'), 'Trouver les tags');
    find.addEventListener('click', () => tagConv(conv).catch((e) => showNotice(`Les tags n’ont pas pu être trouvés.\n${e.message}`, 'error')));
    row.append(find);
  }
  const add = el('button', { type: 'button', class: 'tag add', title: 'Ajouter un tag à la main' }, '+ Tag');
  add.addEventListener('click', () => {
    add.replaceWith(tagPicker(conv));
    row.querySelector('.picker input')?.focus();
  });
  row.append(add);
  return row;
}

function tagPicker(conv) {
  const current = convTags(conv);
  const input = el('input', { type: 'text', placeholder: 'Nouveau tag, puis Entrée', spellcheck: 'false' });
  let kind = 'sujet';
  const kinds = el(
    'span',
    { class: 'segmented mini' },
    TAG_KINDS.map(([k, label]) =>
      el('button', {
        type: 'button',
        class: k === kind ? 'on' : null,
        text: label,
        onclick: (event) => {
          kind = k;
          for (const b of kinds.children) b.classList.toggle('on', b === event.currentTarget);
        },
      }),
    ),
  );
  const pick = async (name) => {
    await setConvTags(conv, [...current, name]);
    renderMain();
  };
  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape') return renderMain();
    if (event.key !== 'Enter' || !input.value.trim()) return;
    const tag = await addTag(input.value, kind);
    if (tag && !current.includes(tag.name)) await pick(tag.name);
  });
  const free = state.tags.filter((t) => !current.includes(t.name));
  return el(
    'div',
    { class: 'picker' },
    free.length > 0 && el('div', { class: 'chips' }, free.map((t) => el('button', { type: 'button', class: `tag ${t.kind}`, text: t.name, onclick: () => pick(t.name) }))),
    el('div', { class: 'picker-new' }, input, kinds),
  );
}

function tagsView() {
  const counts = new Map();
  for (const conv of state.convs) for (const t of convTags(conv)) counts.set(t, (counts.get(t) || 0) + 1);
  const summarized = state.convs.filter((c) => state.summary.has(c.index));
  const tagged = summarized.filter((c) => convTags(c).length).length;
  const todo = toTag(state.convs);
  const actions = [];
  if (state.llm?.url && todo.length && !state.batch) {
    actions.push(el('button', { type: 'button', class: 'pill accent small', onclick: () => runBatch(state.convs, 'tags') }, icon('spark'), `Trouver les tags de ${num(todo.length)} résumées`));
  }
  const out = [head('Tags', `${num(state.tags.length)} / ${MAX_TAGS} tags · ${num(tagged)} conversations taguées sur ${num(summarized.length)} résumées`, ...actions)];
  out.push(
    el('p', {
      class: 'hint',
      text: 'Le LLM met les tags en résumant, en réutilisant cette liste. Ici tu les gardes propres : renomme, fusionne deux tags qui disent la même chose, change de famille, supprime. Les résumés sont mis à jour sans rien renvoyer au LLM.',
    }),
  );
  for (const [kind, label, what] of TAG_KINDS) {
    const tags = state.tags.filter((t) => t.kind === kind).sort((a, b) => (counts.get(b.name) || 0) - (counts.get(a.name) || 0) || a.name.localeCompare(b.name, 'fr'));
    const input = el('input', { type: 'text', placeholder: `Ajouter un tag ${kind}…`, spellcheck: 'false' });
    input.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      await addTag(input.value, kind);
      renderMain();
    });
    out.push(
      el('h3', { class: 'group', text: `${label} · ${what}` }),
      el(
        'div',
        { class: 'panel taglist' },
        tags.length ? tags.map((t) => tagLine(t, counts.get(t.name) || 0)) : el('p', { class: 'muted', text: 'Aucun pour l’instant.' }),
        el('div', { class: 'field' }, input),
      ),
    );
  }
  return out;
}

function tagLine(tag, count) {
  const line = el('div', { class: 'tagline' });
  const show = () => {
    const rename = el('button', { type: 'button', class: 'pill small', text: 'Renommer' });
    const merge = el('button', { type: 'button', class: 'pill small', text: 'Fusionner dans…' });
    const move = el('button', { type: 'button', class: 'pill small', text: tag.kind === 'sujet' ? 'Passer en ambiance' : 'Passer en sujet' });
    const del = el('button', { type: 'button', class: 'pill small danger', text: 'Supprimer' });
    rename.addEventListener('click', () => {
      const input = el('input', { type: 'text', spellcheck: 'false' });
      input.value = tag.name;
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') renameTag(tag, input.value);
        if (event.key === 'Escape') show();
      });
      line.replaceChildren(input, el('button', { type: 'button', class: 'pill small accent', text: 'Enregistrer', onclick: () => renameTag(tag, input.value) }), el('button', { type: 'button', class: 'pill small', text: 'Annuler', onclick: show }));
      input.focus();
      input.select();
    });
    merge.addEventListener('click', () => {
      const others = state.tags.filter((t) => t !== tag);
      line.replaceChildren(
        el('span', { class: 'flabel', text: `« ${tag.name} » devient :` }),
        el('div', { class: 'chips' }, others.map((t) => el('button', { type: 'button', class: `tag ${t.kind}`, text: t.name, onclick: () => mergeTag(tag, t) }))),
        el('button', { type: 'button', class: 'pill small', text: 'Annuler', onclick: show }),
      );
    });
    move.addEventListener('click', async () => {
      tag.kind = tag.kind === 'sujet' ? 'ambiance' : 'sujet';
      await saveTags();
      renderMain();
    });
    del.addEventListener('click', () => {
      if (del.dataset.sure) return deleteTag(tag);
      del.dataset.sure = '1';
      del.textContent = count ? `Oui, retirer de ${num(count)}` : 'Oui, supprimer';
    });
    line.replaceChildren(
      el('button', { type: 'button', class: `tag ${tag.kind}`, text: tag.name, title: 'Voir ces conversations', onclick: () => filterByTag(tag.name) }),
      el('span', { class: 'muted tcount', text: plural(count, 'conversation', 'conversations') }),
      el('span', { class: 'grow' }),
      rename,
      merge,
      move,
      del,
    );
  };
  show();
  return line;
}

/* ---------- Filters and sorting ---------- */

const NO_FILTER = { from: null, to: null, tags: [], any: false, status: 'all', min: 0, sort: 'old' };
const STATUSES = [
  ['all', 'Toutes'],
  ['ok', 'Résumées'],
  ['none', 'Pas résumées'],
  ['stale', 'À refaire'],
  ['untagged', 'Sans tags'],
  ['star', 'Avec favoris'],
];
const SIZES = [
  [0, 'Toutes'],
  [10, '10+'],
  [50, '50+'],
  [200, '200+'],
];
const SORTS = [
  ['old', 'Plus anciennes d’abord'],
  ['new', 'Plus récentes d’abord'],
  ['messages', 'Plus de messages'],
  ['duration', 'Plus longues'],
  ['silence', 'Plus long silence avant'],
  ['stars', 'Plus de favoris'],
];

function starCounts() {
  const counts = new Map();
  if (!state.convs.length) return counts;
  for (const s of state.stars.values()) {
    const i = convAt(tsOfId(s.msg)).index;
    counts.set(i, (counts.get(i) || 0) + 1);
  }
  return counts;
}

const filterActive = () => {
  const f = state.filter;
  return f.from != null || f.to != null || f.tags.length > 0 || f.status !== 'all' || f.min > 0;
};

function visibleConvs() {
  const f = state.filter;
  const stars = starCounts();
  let list = state.convs.filter((c) => (f.from == null || c.to >= f.from) && (f.to == null || c.from <= f.to) && convCount(c) >= f.min);
  if (f.tags.length) {
    list = list.filter((c) => {
      const tags = convTags(c);
      return f.any ? f.tags.some((t) => tags.includes(t)) : f.tags.every((t) => tags.includes(t));
    });
  }
  const keep = {
    ok: isSummarized,
    none: (c) => noteStatus(c) === 'none',
    stale: (c) => noteStatus(c) === 'stale',
    untagged: (c) => isSummarized(c) && !convTags(c).length,
    star: (c) => stars.has(c.index),
  }[f.status];
  if (keep) list = list.filter(keep);
  const silence = (c) => (c.index ? c.from - state.convs[c.index - 1].to : 0);
  const by = {
    new: (a, b) => b.from - a.from,
    messages: (a, b) => convCount(b) - convCount(a),
    duration: (a, b) => b.to - b.from - (a.to - a.from),
    silence: (a, b) => silence(b) - silence(a),
    stars: (a, b) => (stars.get(b.index) || 0) - (stars.get(a.index) || 0) || a.from - b.from,
  }[f.sort];
  return by ? list.sort(by) : list;
}

function setFilter(changes) {
  state.filter = { ...state.filter, ...changes };
  renderSide();
  if (state.view !== 'fil' || state.query) renderMain();
  renderFilterCard();
}

function filterByTag(name) {
  state.filter = { ...state.filter, tags: [name] };
  showView('resumes');
}

function filterSummary() {
  const f = state.filter;
  const parts = [];
  if (f.from != null || f.to != null) {
    parts.push(`${f.from != null ? fmt.dayMonth.format(f.from) : '…'} → ${f.to != null ? fmt.dayMonth.format(f.to) : '…'}`);
  }
  if (f.tags.length) parts.push(f.tags.join(f.any ? ' ou ' : ' + '));
  if (f.status !== 'all') parts.push(STATUSES.find(([k]) => k === f.status)[1].toLowerCase());
  if (f.min) parts.push(`${f.min}+ messages`);
  return parts.join(' · ');
}

function renderFilterBar() {
  const bar = $('#filterbar');
  bar.hidden = !state.thread;
  if (!state.thread) return;
  const active = filterActive();
  const count = active ? visibleConvs().length : state.convs.length;
  const sortName = state.filter.sort !== 'old' ? SORTS.find(([k]) => k === state.filter.sort)[1] : '';
  bar.replaceChildren(
    ...[
    el(
      'button',
      { type: 'button', class: `pill small${active ? ' on' : ''}`, id: 'filter-open', onclick: toggleFilterCard },
      icon('funnel'),
      active ? 'Filtré' : 'Filtrer et trier',
    ),
    el('span', { class: 'fsum', text: [active ? filterSummary() : '', sortName].filter(Boolean).join(' · ') || plural(count, 'conversation', 'conversations') }),
    active &&
      el('button', { type: 'button', class: 'reset', title: 'Enlever les filtres', 'aria-label': 'Enlever les filtres', onclick: () => setFilter({ ...NO_FILTER, sort: state.filter.sort }) }, icon('close')),
    ].filter(Boolean),
  );
}

function toggleFilterCard() {
  const card = $('#filtercard');
  card.hidden = !card.hidden;
  state.calendar = null;
  renderFilterCard();
}

function renderFilterCard() {
  const card = $('#filtercard');
  if (card.hidden || !state.thread) return;
  const f = state.filter;
  const chipRow = (items, current, onPick) =>
    el(
      'div',
      { class: 'chips' },
      items.map(([value, label]) => el('button', { type: 'button', class: `chip${current === value ? ' on' : ''}`, text: label, onclick: () => onPick(value) })),
    );
  const day = 864e5;
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const quick = [
    ['Tout', null, null],
    ['7 derniers jours', startOfDay(now) - 6 * day, null],
    ['30 derniers jours', startOfDay(now) - 29 * day, null],
    ['Ce mois-ci', new Date(now.getFullYear(), now.getMonth(), 1).getTime(), null],
    ['Mois dernier', new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1],
  ];
  if (state.sel) quick.push(['Sélection de la frise', state.sel.from, state.sel.to]);
  const dateButton = (which, label, value) =>
    el(
      'button',
      {
        type: 'button',
        class: `datefield${state.calendar === which ? ' on' : ''}`,
        onclick: () => {
          state.calendar = state.calendar === which ? null : which;
          renderFilterCard();
        },
      },
      el('span', { class: 'muted', text: label }),
      el('span', { text: value != null ? fmt.date.format(value) : 'non choisi' }),
    );

  const counts = new Map();
  for (const conv of state.convs) for (const t of convTags(conv)) counts.set(t, (counts.get(t) || 0) + 1);
  const tagGroups = TAG_KINDS.map(([kind, label]) => {
    const tags = state.tags.filter((t) => t.kind === kind && counts.has(t.name)).sort((a, b) => counts.get(b.name) - counts.get(a.name));
    if (!tags.length) return null;
    return el(
      'div',
      { class: 'tgroup' },
      el('span', { class: 'muted small', text: label }),
      el(
        'div',
        { class: 'chips' },
        tags.map((t) =>
          el(
            'button',
            {
              type: 'button',
              class: `tag ${t.kind}${f.tags.includes(t.name) ? ' on' : ''}`,
              onclick: () => setFilter({ tags: f.tags.includes(t.name) ? f.tags.filter((x) => x !== t.name) : [...f.tags, t.name] }),
            },
            t.name,
            el('span', { class: 'n', text: num(counts.get(t.name)) }),
          ),
        ),
      ),
    );
  }).filter(Boolean);

  const count = visibleConvs().length;
  const parts = [
    el('div', { class: 'fhead' }, el('b', { text: plural(count, 'conversation', 'conversations') }), el('button', { type: 'button', class: 'pill small', text: 'Tout réinitialiser', onclick: () => setFilter({ ...NO_FILTER }) }), el('button', { type: 'button', class: 'reset', 'aria-label': 'Fermer', onclick: toggleFilterCard }, icon('close'))),
    el('h4', { text: 'Période' }),
    el('div', { class: 'chips' }, quick.map(([label, from, to]) => el('button', { type: 'button', class: `chip${f.from === from && f.to === to ? ' on' : ''}`, text: label, onclick: () => setFilter({ from, to }) }))),
    el('div', { class: 'dates' }, dateButton('from', 'Du', f.from), dateButton('to', 'Au', f.to)),
    state.calendar && calendar(state.calendar === 'from' ? f.from : f.to),
    el('h4', {}, 'Tags', el('button', { type: 'button', class: 'inline small', text: 'Gérer les tags', onclick: () => { toggleFilterCard(); showView('tags'); } })),
    tagGroups.length
      ? [
          f.tags.length > 1 && chipRow([[false, 'Tous ces tags'], [true, 'Au moins un']], f.any, (any) => setFilter({ any })),
          tagGroups,
        ]
      : el('p', { class: 'muted small', text: 'Pas encore de tags : ils arrivent avec les résumés.' }),
    el('h4', { text: 'Statut' }),
    chipRow(STATUSES, f.status, (status) => setFilter({ status })),
    el('h4', { text: 'Taille' }),
    chipRow(SIZES, f.min, (min) => setFilter({ min })),
    el('h4', { text: 'Trier' }),
    chipRow(SORTS, f.sort, (sort) => setFilter({ sort })),
  ];
  card.replaceChildren(...parts.flat(2).filter((x) => x != null && x !== false));
}

// A month calendar in French, Monday first. Days with conversations are marked.
function calendar(value) {
  const which = state.calendar;
  const base = new Date(value ?? (which === 'from' ? state.convs[0]?.from : state.convs[state.convs.length - 1]?.to) ?? Date.now());
  if (!state.calMonth || state.calFor !== which) {
    state.calMonth = new Date(base.getFullYear(), base.getMonth(), 1).getTime();
    state.calFor = which;
  }
  const month = new Date(state.calMonth);
  const active = new Set(state.convs.map((c) => new Date(c.from).toDateString()));
  const f = state.filter;
  const grid = el('div', { class: 'calgrid' }, ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => el('span', { class: 'wd', text: d })));
  const first = new Date(month);
  const offset = (first.getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) grid.append(el('span'));
  for (let d = 1; d <= new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(); d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const start = date.getTime();
    const end = start + 864e5 - 1;
    const inRange = f.from != null && f.to != null && start >= f.from && end <= f.to;
    const picked = (which === 'from' && f.from === start) || (which === 'to' && f.to === end);
    grid.append(
      el('button', {
        type: 'button',
        class: `day${active.has(date.toDateString()) ? ' has' : ''}${inRange ? ' range' : ''}${picked ? ' on' : ''}`,
        text: String(d),
        onclick: () => {
          state.calendar = null;
          setFilter({ [which]: which === 'from' ? start : end });
        },
      }),
    );
  }
  const step = (n) => {
    state.calMonth = new Date(month.getFullYear(), month.getMonth() + n, 1).getTime();
    renderFilterCard();
  };
  return el(
    'div',
    { class: 'calendar' },
    el(
      'div',
      { class: 'calhead' },
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Mois précédent', onclick: () => step(-1) }, icon('prev')),
      el('b', { text: cap(fmt.month.format(month)) }),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Mois suivant', onclick: () => step(1) }, icon('next')),
    ),
    grid,
    el('button', {
      type: 'button',
      class: 'inline small',
      text: which === 'from' ? 'Sans date de début' : 'Sans date de fin',
      onclick: () => {
        state.calendar = null;
        setFilter({ [which]: null });
      },
    }),
  );
}

/* ---------- Rendering ---------- */

function render() {
  renderSide();
  renderMain();
}

function renderSide() {
  const thread = state.thread;
  $('#title').textContent = thread ? titleOf(thread) : 'Fil';
  $('#span').textContent = thread ? `${plural(thread.messages.length, 'message', 'messages')} · ${spanText(thread)}` : 'Aucune conversation importée';
  const chips = $('#threads');
  chips.hidden = state.threads.length < 2;
  chips.replaceChildren(
    ...state.threads.map((t) =>
      el('button', { type: 'button', class: `chip${t === thread ? ' on' : ''}`, text: titleOf(t), onclick: () => selectThread(t) }),
    ),
  );
  for (const tab of document.querySelectorAll('#tabs button')) {
    tab.classList.toggle('on', !state.query && tab.dataset.view === state.view);
    tab.disabled = !thread;
  }
  $('#settings').classList.toggle('on', state.view === 'reglages' && !state.query);
  $('#q').disabled = !thread;
  $('#backup').disabled = !state.threads.length;
  renderFilterBar();
  renderTimeline();
}

function renderTimeline() {
  const list = $('#timeline');
  const scroll = list.scrollTop;
  const starred = starCounts();
  const convs = visibleConvs();
  const byDate = state.filter.sort === 'old' || state.filter.sort === 'new';
  const items = [];
  let day = '';
  for (const conv of convs) {
    const label = cap(fmt.dayMid.format(conv.from));
    if (byDate && label !== day) {
      day = label;
      const year = new Date(conv.from).getFullYear();
      items.push(el('li', { class: 'dayhead' }, el('span', { text: label }), year !== new Date().getFullYear() && el('span', { class: 'muted', text: String(year) })));
    }
    const status = noteStatus(conv);
    const note = state.summary.get(conv.index);
    const flags = el('span', { class: 'flags' });
    if (state.working.has(conv.id)) flags.append(el('span', { class: 'spinner', title: 'En cours' }));
    else if (status === 'stale') flags.append(el('span', { class: 'dot stale', title: 'Résumé à refaire : une partie de la conversation n’est pas couverte' }));
    if (starred.has(conv.index)) flags.append(icon('star'));
    const when = byDate ? `${fmt.time.format(conv.from)} → ${fmt.time.format(conv.to)}` : `${cap(fmt.dayMid.format(conv.from))}, ${fmt.time.format(conv.from)}`;
    items.push(
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            class: `conv${conv.index === state.conv && state.view === 'fil' && !state.query ? ' on' : ''}`,
            dataset: { conv: conv.index },
            onclick: () => openConv(conv.index),
          },
          el('span', { class: 'line' }, el('span', { class: 'time', text: when }), flags, el('span', { class: 'count', text: num(convCount(conv)) })),
          note?.title && el('span', { class: 'ctitle', text: note.title }),
        ),
      ),
    );
  }
  if (!convs.length && state.thread) items.push(el('li', { class: 'none' }, 'Aucune conversation avec ces filtres.'));
  list.replaceChildren(...items);
  list.scrollTop = scroll;
}

// Previous and next follow the list as filtered and sorted, when the open conversation is in it.
function neighbours(conv) {
  const list = visibleConvs();
  const i = list.indexOf(conv);
  if (i === -1) return [state.convs[conv.index - 1], state.convs[conv.index + 1]];
  return [list[i - 1], list[i + 1]];
}

function scrollTimelineToConv(block = 'center') {
  const row = document.querySelector(`#timeline [data-conv="${state.conv}"]`);
  if (row) row.scrollIntoView({ block });
}

function renderMain() {
  const view = $('#view');
  state.nodes = new Map();
  const show = (nodes) => view.replaceChildren(...nodes.filter(Boolean));
  if (state.view === 'reglages') return show(settingsView());
  if (!state.thread) return show([emptyState()]);
  if (state.query.trim()) return show(searchView());
  if (state.view === 'favoris') return show(starsView());
  if (state.view === 'frise') return show(friseView());
  if (state.view === 'tags') return show(tagsView());
  if (state.view === 'analyse') return show(analyseView());
  if (state.view === 'resumes') return show(resumesView());
  show(convView());
}

function emptyState() {
  return el(
    'div',
    { class: 'empty' },
    el('span', { class: 'glyph' }, icon('bubble')),
    el('h2', { text: 'Importe ta conversation' }),
    el('p', { text: 'Dans Messenger : Préférences › Confidentialité et sécurité › Discussions chiffrées de bout en bout › Stockage des messages › Télécharger. Puis choisis le fichier .json de la conversation, ou glisse-le dans cette page.' }),
    el('p', { text: 'Tout reste sur ce PC. Les exports suivants se rajoutent au même fil, sans doublons.' }),
    el('button', { type: 'button', class: 'pill accent', onclick: () => $('#file').click() }, icon('import'), 'Choisir le fichier'),
  );
}

function head(title, meta, ...actions) {
  return el('div', { class: 'head' }, el('div', { class: 'titles' }, el('h2', { text: title }), meta && el('p', { text: meta })), ...actions);
}

function summarizeButton(conv) {
  const busy = state.working.has(conv.id);
  const status = noteStatus(conv);
  if (!state.llm?.url) {
    const copy = el('button', { type: 'button', class: 'pill accent small summarize', title: 'Copie la conversation avec une consigne de résumé, à coller dans un LLM' }, icon('copy'), 'Copier pour un LLM');
    copy.addEventListener('click', () => copyText(`${systemPrompt()}\n\n${userPrompt(conv)}`, copy, 'Copié'));
    return copy;
  }
  const button = el(
    'button',
    { type: 'button', class: 'pill accent small summarize', disabled: busy },
    busy ? el('span', { class: 'spinner light' }) : icon('spark'),
    busy ? 'Résumé en cours…' : status === 'none' ? 'Résumer' : status === 'grouped' ? 'Refaire en un seul résumé' : 'Refaire le résumé',
  );
  button.addEventListener('click', () => summarizeOne(conv, button));
  return button;
}

function convHead(conv) {
  const [prev, next] = neighbours(conv);
  const before = state.convs[conv.index - 1];
  const count = convCount(conv);
  const length = conv.to - conv.from < 60e3 ? 'un instant' : duration(conv.to - conv.from);
  const silence = before ? `après ${duration(conv.from - before.to)} de silence` : 'premier message de l’export';
  const title = state.summary.get(conv.index)?.title || '';
  return head(
    title || convLabel(conv),
    `${title ? `${convLabel(conv)} · ` : ''}${plural(count, 'message', 'messages')} · ${length} · ${silence}`,
    el('button', { type: 'button', class: 'icon-btn', title: 'Conversation précédente (←)', disabled: !prev, onclick: () => prev && openConv(prev.index) }, icon('prev')),
    el('button', { type: 'button', class: 'icon-btn', title: 'Conversation suivante (→)', disabled: !next, onclick: () => next && openConv(next.index) }, icon('next')),
    before && el('button', { type: 'button', class: 'icon-btn', title: 'Fusionner avec la conversation précédente', onclick: () => setCut(conv.id, 'merge') }, icon('merge')),
    summarizeButton(conv),
  );
}

function setMode(mode) {
  state.mode = mode;
  renderMain();
  $('#main').scrollTop = 0;
}

function convView() {
  const thread = state.thread;
  const conv = state.convs[state.conv] || state.convs[state.convs.length - 1];
  state.conv = conv.index;
  const messages = convMessages(conv);
  const has = state.noteLinks.has(conv.index);
  const modeButton = (mode, label, name) =>
    el('button', { type: 'button', class: state.mode === mode ? 'on' : null, onclick: () => setMode(mode) }, icon(name), label);
  const modes = el(
    'nav',
    { class: 'segmented modes' },
    modeButton('resume', has ? 'Résumé' : 'Résumé (pas encore fait)', 'doc'),
    modeButton('messages', `Messages · ${num(messages.length)}`, 'bubble'),
  );
  const out = [convHead(conv), el('div', { class: 'modebar' }, modes, tagRow(conv))];
  if (state.mode === 'resume') {
    out.push(has || state.writing === conv.id ? noteCard(conv) : emptySummary(conv));
    return out;
  }
  const startsRange = thread.ranges.some(([a]) => a === conv.from);
  const endsRange = thread.ranges.some(([, b]) => b === conv.to);
  out.push(
    cutNotice(conv),
    startsRange && el('p', { class: 'edge', text: `Début de l’export. Pour voir avant le ${fmt.date.format(conv.from)}, ajoute un export plus ancien depuis la Frise.` }),
    el('div', { class: 'messages' }, messageRows(messages)),
    endsRange && el('p', { class: 'edge', text: `Fin de l’export (${fmt.full.format(conv.to)}).` }),
  );
  return out;
}

function emptySummary(conv) {
  const short = textCount(conv) < MIN_TEXTS;
  const action = summarizeButton(conv);
  action.classList.remove('small');
  return el(
    'div',
    { class: 'card nosum' },
    el('p', { text: short ? 'Conversation très courte : tu peux la lire directement, ou la résumer quand même.' : 'Cette conversation n’a pas encore de résumé.' }),
    el(
      'div',
      { class: 'actions' },
      action,
      el('button', { type: 'button', class: 'pill', text: 'Voir les messages', onclick: () => setMode('messages') }),
      el('button', {
        type: 'button',
        class: 'pill',
        text: 'L’écrire moi-même',
        onclick: () => {
          state.writing = conv.id;
          renderMain();
          document.querySelector('.card .ntitle')?.focus();
        },
      }),
    ),
  );
}

function noteCard(conv) {
  const status = noteStatus(conv);
  const sum = state.summary.get(conv.index);
  const saved = el('span', { class: 'muted' });
  const title = el('input', { class: 'ntitle', type: 'text', placeholder: 'Titre', spellcheck: 'false' });
  const area = el('textarea', {
    rows: 2,
    placeholder: state.llm?.url
      ? 'Les points importants de cette conversation. « Résumer » les écrit ici ; tu peux les corriger.'
      : 'Les points importants de cette conversation. Configure un LLM dans les Réglages pour les écrire tout seul, ou colle ici le résumé d’un LLM.',
  });
  title.value = sum?.title || '';
  area.value = sum?.text || '';
  const grow = () => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  };
  let timer = 0;
  const changed = () => {
    saved.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const by = sum?.own?.by || '';
        await saveConvNote(conv, { title: title.value.trim(), text: area.value, by });
        saved.textContent = 'Enregistré';
        renderTimeline();
      } catch (e) {
        showNotice(`Le résumé n’a pas pu être enregistré : ${e.message}`, 'error');
      }
    }, 500);
  };
  title.addEventListener('input', changed);
  area.addEventListener('input', () => {
    grow();
    changed();
  });
  requestAnimationFrame(grow);
  let info = '';
  if (status === 'stale') info = 'Une partie de cette conversation n’est pas encore résumée (nouveaux messages, ou morceaux jamais résumés) : refais-le pour l’avoir en entier.';
  else if (sum?.kind === 'parts')
    info = `Regroupement de ${sum.parts.length} résumés faits avec un découpage plus fin${sum.leftOut ? ` (${plural(sum.leftOut, 'message court non résumé', 'messages courts non résumés')})` : ''}. Rien n’a été renvoyé au LLM ; « Refaire en un seul résumé » en fait un nouveau, sans effacer ceux-ci.`;
  else if (sum?.kind === 'around') info = 'Résumé de la conversation plus longue qui contient celle-ci (fait avec un découpage plus large).';
  else if (sum?.own?.by) info = `Par ${sum.own.by}, le ${fmt.date.format(sum.own.updatedAt)}`;
  return el(
    'div',
    { class: `card${status === 'stale' ? ' stale' : ''}${status === 'grouped' ? ' grouped' : ''}` },
    el('div', { class: 'label' }, 'Résumé', info && el('span', { class: 'muted', text: info }), saved),
    title,
    area,
  );
}

// Messages of one conversation. Photos sent together (same millisecond) share a bubble.
function messageRows(messages) {
  const rows = [];
  let prev = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const group = [m];
    if (isMedia(m)) {
      while (i + 1 < messages.length && isMedia(messages[i + 1]) && messages[i + 1].ts === m.ts && messages[i + 1].from === m.from) {
        group.push(messages[++i]);
      }
    }
    if (prev && m.ts - prev.ts > state.gap * 60e3) rows.push(joinedSeparator(m, prev));
    else if (prev && m.ts - prev.ts > GAP_TIME) rows.push(el('p', { class: 'sep', text: `${fmt.time.format(m.ts)} · ${duration(m.ts - prev.ts)} plus tard` }));
    const first = !prev || prev.from !== m.from || m.ts - prev.ts > GAP_GROUP;
    const row = messageRow(m, group, first, !!prev);
    for (const g of group) state.nodes.set(g.id, row);
    rows.push(row);
    prev = group[group.length - 1];
  }
  return rows;
}

const isMedia = (m) => m.type === 'media' || (m.media > 0 && !m.text);

function messageContent(m, count = 1) {
  if (m.unsent || m.type === 'placeholder') return [el('span', { class: 'ghost' }, icon('undo'), 'Message retiré')];
  if (isMedia(m)) {
    const total = count > 1 ? count : Math.max(1, m.media);
    return [el('span', { class: 'ghost', title: 'Messenger n’a pas mis les photos et vidéos dans l’export' }, icon('photo'), total > 1 ? `${total} photos ou vidéos` : 'Photo ou vidéo')];
  }
  if (m.type === 'link' && !m.text) return [el('span', { class: 'ghost' }, icon('link'), 'Lien partagé (adresse absente de l’export)')];
  return linkify(m.text);
}

function linkify(text) {
  const parts = [];
  let from = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    parts.push(text.slice(from, match.index));
    parts.push(el('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer', text: match[0] }));
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

function messageRow(m, group, first, canCut) {
  const mine = m.from === state.thread.me;
  const starred = group.some((g) => state.stars.has(g.id));
  const star = el('button', { type: 'button', class: 'star', title: starred ? 'Retirer des favoris' : 'Ajouter aux favoris' }, icon('star'));
  star.addEventListener('click', () => toggleStar(m.id, row));
  const reactions = [...new Set(group.flatMap((g) => g.react.map((r) => r[1])))];
  const row = el(
    'div',
    { class: `msg${mine ? ' mine' : ''}${first ? ' first' : ''}${starred ? ' starred' : ''}` },
    el(
      'div',
      { class: 'bwrap' },
      el('div', { class: 'bubble', dir: 'auto', title: fmt.full.format(m.ts) }, messageContent(m, group.length)),
      reactions.length > 0 && el('span', { class: 'react', text: reactions.join(' ') }),
    ),
    el(
      'div',
      { class: 'tools' },
      star,
      canCut && el('button', { type: 'button', class: 'star cut', title: 'Couper ici : une nouvelle conversation commence à ce message', onclick: () => setCut(m.id, 'split') }, icon('scissors')),
      el('time', { text: fmt.time.format(m.ts) }),
    ),
  );
  return row;
}

async function toggleStar(id, row) {
  const key = `${state.thread.id}|${id}`;
  try {
    if (state.stars.has(id)) {
      await remove('stars', key);
      state.stars.delete(id);
    } else {
      const record = { key, thread: state.thread.id, msg: id, at: Date.now() };
      await put('stars', record);
      state.stars.set(id, record);
    }
  } catch (e) {
    return showNotice(`Le favori n’a pas pu être enregistré : ${e.message}`, 'error');
  }
  if (row) {
    const on = state.stars.has(id);
    row.classList.toggle('starred', on);
    row.querySelector('.star').title = on ? 'Retirer des favoris' : 'Ajouter aux favoris';
  } else {
    renderMain();
  }
  renderTimeline();
}

function hit(m, body) {
  const mine = m.from === state.thread.me;
  return el(
    'button',
    { type: 'button', class: 'hit', onclick: () => openConv(convAt(m.ts).index, m.id) },
    el('span', { class: 'meta' }, el('span', { text: fmt.time.format(m.ts) }), el('b', { class: mine ? 'me' : null, text: firstName(m.from) })),
    el('span', { class: 'body', dir: 'auto' }, body),
  );
}

function grouped(messages, render) {
  const out = [];
  let current = -1;
  for (const m of messages) {
    const conv = convAt(m.ts);
    if (conv.index !== current) {
      current = conv.index;
      const title = state.summary.get(conv.index)?.title;
      out.push(el('h3', { class: 'group', text: `${convLabel(conv)}${title ? ` · ${title}` : ''}` }));
    }
    out.push(render(m));
  }
  return out;
}

// What was typed: words (all must be in the same conversation, any order),
// "an exact phrase", and -word to leave out the conversations that say it.
function parseQuery(raw) {
  const query = { terms: [], phrases: [], excludes: [] };
  const loose = !state.exact;
  const term = (word) => {
    const exact = fold(word, false).s.trim();
    const l = loose ? fold(word, true).s.trim() : '';
    // Too few consonants left: the loose form would match everything.
    return exact ? { word, exact, loose: l.replace(/ /g, '').length >= 2 ? l : '' } : null;
  };
  for (const match of raw.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    if (match[2] !== undefined) {
      const exact = fold(match[2], false).s.trim();
      if (!exact) continue;
      if (match[1]) query.excludes.push({ word: match[2], exact, loose: '' });
      else query.phrases.push({ word: match[2], exact, loose: '' });
    } else {
      const t = term(match[4]);
      if (!t) continue;
      if (match[3] && match[4].length > 1) query.excludes.push(t);
      else query.terms.push(t);
    }
  }
  return query;
}

// 2: the exact spelling is there. 1: only the loose form, at the start of a word. 0: absent.
function matchLevel(exactText, looseText, t) {
  if (exactText.includes(t.exact)) return 2;
  if (!t.loose || !looseText) return 0;
  for (let i = looseText.indexOf(t.loose); i !== -1; i = looseText.indexOf(t.loose, i + 1)) {
    if (i === 0 || looseText[i - 1] === ' ') return 1;
  }
  return 0;
}

// Marks every place where one of the searched words is, in exact or loose form.
function highlightAll(text, query) {
  const needles = [...query.terms, ...query.phrases];
  const ranges = [];
  const exact = fold(text, false);
  for (const t of needles) {
    for (let i = exact.s.indexOf(t.exact); i !== -1; i = exact.s.indexOf(t.exact, i + 1)) {
      ranges.push([exact.map[i], exact.map[i + t.exact.length - 1] + 1]);
    }
  }
  if (needles.some((t) => t.loose)) {
    const loose = fold(text, true);
    for (const t of needles) {
      if (!t.loose) continue;
      for (let i = loose.s.indexOf(t.loose); i !== -1; i = loose.s.indexOf(t.loose, i + 1)) {
        if (i && loose.s[i - 1] !== ' ') continue;
        let end = loose.map[i + t.loose.length - 1] + 1;
        while (end < text.length && VOWELS.has(text[end].toLowerCase())) end++;
        let start = loose.map[i];
        while (start > 0 && VOWELS.has(text[start - 1].toLowerCase()) && LETTER.test(text[start - 1]) && !LETTER.test(text[start - 2] || '')) start--;
        ranges.push([start, end]);
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let from = 0;
  for (const [a, b] of ranges) {
    if (b <= from) continue;
    const start = Math.max(a, from);
    parts.push(text.slice(from, start), el('mark', { text: text.slice(start, b) }));
    from = b;
  }
  parts.push(text.slice(from));
  return parts;
}

const SEARCH_SORTS = [
  ['score', 'Pertinence'],
  ['new', 'Plus récentes'],
  ['old', 'Plus anciennes'],
];

function runSearch(query) {
  const thread = state.thread;
  const messages = thread.messages;
  const texts = folded();
  const inFilter = filterActive() ? new Set(visibleConvs().map((c) => c.index)) : null;
  const needles = [...query.terms, ...query.phrases];
  const hits = new Map(); // conv index -> { found: number[] (best level per needle), score, messages: [index], summary: bool, excluded }
  const entry = (i) => {
    if (!hits.has(i)) hits.set(i, { found: needles.map(() => 0), score: 0, messages: [], summary: false, excluded: false });
    return hits.get(i);
  };
  let conv = 0;
  for (let i = 0; i < messages.length; i++) {
    while (state.convs[conv + 1] && state.convs[conv + 1].start <= i) conv++;
    if (inFilter && !inFilter.has(conv)) continue;
    const ex = texts.exact[i];
    const lo = texts.loose[i];
    if (query.excludes.some((t) => matchLevel(ex, lo, t))) {
      entry(conv).excluded = true;
      continue;
    }
    if (state.who && messages[i].from !== state.who) continue;
    let any = 0;
    needles.forEach((t, k) => {
      const level = matchLevel(ex, lo, t);
      if (level) {
        const e = entry(conv);
        e.found[k] = Math.max(e.found[k], level);
        e.score += level === 2 ? 2 : 1;
        any = Math.max(any, level);
      }
    });
    if (any) entry(conv).messages.push(i);
  }
  // Titles, tags and summaries: what was said in darja is often found through the French summary.
  for (const c of state.convs) {
    const sum = state.summary.get(c.index);
    if (!sum || (inFilter && !inFilter.has(c.index))) continue;
    const fields = [
      [sum.title, 6],
      [sum.tags.join(' '), 6],
      [sum.text, 3],
    ];
    for (const [text, weight] of fields) {
      if (!text) continue;
      const ex = fold(text, false).s;
      const lo = fold(text, true).s;
      if (query.excludes.some((t) => matchLevel(ex, lo, t))) entry(c.index).excluded = true;
      needles.forEach((t, k) => {
        const level = matchLevel(ex, lo, t);
        if (!level) return;
        const e = entry(c.index);
        e.found[k] = Math.max(e.found[k], level);
        e.score += level === 2 ? weight * 2 : weight;
        e.summary = true;
      });
    }
  }
  const results = [];
  for (const [index, e] of hits) {
    if (e.excluded || !e.found.every(Boolean)) continue;
    // Exact spellings first, then the rest, then many messages over few.
    const exactness = e.found.filter((f) => f === 2).length / Math.max(1, needles.length);
    results.push({ conv: state.convs[index], ...e, rank: exactness * 100 + Math.min(60, e.score) });
  }
  const sort = state.searchSort || 'score';
  results.sort(sort === 'new' ? (a, b) => b.conv.from - a.conv.from : sort === 'old' ? (a, b) => a.conv.from - b.conv.from : (a, b) => b.rank - a.rank || b.conv.from - a.conv.from);
  return { results, inFilter };
}

function searchView() {
  const thread = state.thread;
  const query = parseQuery(state.query.trim());
  const needles = [...query.terms, ...query.phrases];
  const { results, inFilter } = needles.length ? runSearch(query) : { results: [], inFilter: null };
  const totalMessages = results.reduce((sum, r) => sum + r.messages.length, 0);
  const shown = results.slice(0, state.searchLimit || 60);

  const chip = (label, on, onclick) => el('button', { type: 'button', class: `chip${on ? ' on' : ''}`, text: label, onclick });
  const meta =
    `${plural(results.length, 'conversation', 'conversations')}${totalMessages ? ` · ${plural(totalMessages, 'message', 'messages')}` : ' (trouvées par leurs résumés)'}` +
    (inFilter ? ` · dans les conversations filtrées (${filterSummary()})` : '');

  const out = [
    head(`« ${state.query.trim()} »`, meta),
    askCard(),
    el(
      'div',
      { class: 'toolbar' },
      chip('Tous', !state.who, () => ((state.who = null), renderMain())),
      ...thread.participants.map((p) => chip(p === thread.me ? `${firstName(p)} (moi)` : firstName(p), state.who === p, () => ((state.who = p), renderMain()))),
      el('span', { class: 'sepdot' }),
      ...SEARCH_SORTS.map(([k, label]) => chip(label, (state.searchSort || 'score') === k, () => ((state.searchSort = k), renderMain()))),
      el('span', { class: 'grow' }),
      switchControl('Orthographe exacte', state.exact, () => {
        state.exact = !state.exact;
        renderMain();
      }, 'Désactivé : khdma trouve aussi khedma, wesh trouve wech, 3lach trouve alach (au début des mots)'),
    ),
    el('p', { class: 'hint', text: 'Plusieurs mots : tous dans la même conversation, dans n’importe quel ordre · "entre guillemets" : la phrase exacte · -mot : sans les conversations qui le contiennent. Les titres, tags et résumés sont aussi cherchés.' }),
  ];
  if (!results.length) {
    out.push(el('p', { class: 'edge', text: needles.length ? 'Aucune conversation ne contient tout ça.' : 'Tape un mot à chercher.' }));
    return out;
  }
  for (const r of shown) out.push(resultCard(r, query));
  if (results.length > shown.length) {
    out.push(
      el('button', {
        type: 'button',
        class: 'pill more',
        text: `Afficher ${num(Math.min(60, results.length - shown.length))} de plus (${num(results.length - shown.length)} restantes)`,
        onclick: () => {
          state.searchLimit = (state.searchLimit || 60) + 60;
          renderMain();
        },
      }),
    );
  }
  return out;
}

function resultCard(r, query) {
  const { conv } = r;
  const sum = state.summary.get(conv.index);
  const messages = state.thread.messages;
  const card = el('section', { class: 'result-card' });
  card.append(
    el(
      'button',
      { type: 'button', class: 'when', onclick: () => ((state.mode = 'resume'), openConv(conv.index)) },
      convLabel(conv),
      el('span', { class: 'muted', text: r.messages.length ? ` · ${plural(r.messages.length, 'message trouvé', 'messages trouvés')}` : ' · trouvée par son résumé' }),
    ),
  );
  if (sum?.title) card.append(el('h4', {}, highlightAll(sum.title, query)));
  if (sum?.tags.length) card.append(el('div', { class: 'tagrow' }, sum.tags.map((t) => tagChip(t))));
  if (r.summary && sum?.text) {
    // The lines of the summary that contain a searched word.
    const lines = sum.text.split('\n').filter((line) => {
      const ex = fold(line, false).s;
      const lo = fold(line, true).s;
      return [...query.terms, ...query.phrases].some((t) => matchLevel(ex, lo, t));
    });
    if (lines.length) card.append(el('p', { class: 'sumhit', dir: 'auto' }, el('span', { class: 'muted', text: 'Résumé : ' }), highlightAll(lines.slice(0, 2).join(' '), query)));
  }
  // Up to 3 messages, chosen so that each searched word shows at least once.
  const texts = folded();
  const shown = [];
  for (const t of [...query.terms, ...query.phrases]) {
    const i = r.messages.find((j) => matchLevel(texts.exact[j], texts.loose[j], t));
    if (i !== undefined && !shown.includes(i) && shown.length < 3) shown.push(i);
  }
  for (const i of r.messages) if (shown.length < 3 && !shown.includes(i)) shown.push(i);
  shown.sort((a, b) => a - b);
  for (const i of shown) {
    const m = messages[i];
    const before = i > conv.start ? messages[i - 1] : null;
    const after = i + 1 < conv.end ? messages[i + 1] : null;
    const line = (msg, body, cls) =>
      el(
        'span',
        { class: `ctx ${cls}` },
        el('span', { class: 'meta' }, el('span', { text: fmt.time.format(msg.ts) }), el('b', { class: msg.from === state.thread.me ? 'me' : null, text: firstName(msg.from) })),
        el('span', { class: 'body', dir: 'auto' }, body),
      );
    card.append(
      el(
        'button',
        { type: 'button', class: 'hit', onclick: () => openConv(conv.index, m.id) },
        before && !shown.includes(i - 1) && line(before, messageText(before), 'around'),
        line(m, highlightAll(m.text, query), 'found'),
        after && !shown.includes(i + 1) && line(after, messageText(after), 'around'),
      ),
    );
  }
  if (r.messages.length > shown.length) {
    card.append(el('button', { type: 'button', class: 'inline small', text: `+ ${plural(r.messages.length - shown.length, 'autre message', 'autres messages')} dans cette conversation`, onclick: () => openConv(conv.index, messages[r.messages.find((i) => !shown.includes(i))].id) }));
  }
  return card;
}

const messageText = (m) => (m.unsent || m.type === 'placeholder' ? 'message retiré' : isMedia(m) ? 'photo ou vidéo' : m.type === 'link' && !m.text ? 'lien' : m.text);

/* ---------- Ask Fil ---------- */

function askScope() {
  const scope = filterActive() ? visibleConvs() : state.convs;
  return scope.filter((c) => isSummarized(c)).sort((a, b) => a.from - b.from);
}

function askCard() {
  const scope = askScope();
  const q = state.query.trim();
  const answer = (state.answer && state.answer.query === q && state.answer.thread === state.thread.id ? state.answer : null) || savedAsk(q) || null;
  if (!state.llm?.url || !scope.length) {
    return el('p', { class: 'hint', text: state.llm?.url ? 'Résume des conversations pour pouvoir poser des questions à Fil.' : 'Configure un LLM dans les Réglages pour poser des questions à Fil sur tes résumés.' });
  }
  const chars = scope.reduce((sum, c) => {
    const s = state.summary.get(c.index);
    return sum + s.text.length + s.title.length + 60;
  }, 0);
  const card = el('section', { class: 'ask' });
  const button = el(
    'button',
    { type: 'button', class: 'pill accent small', disabled: state.asking, title: `Environ ${num(Math.round(chars / 3.2 / 1000) * 1000)} tokens envoyés` },
    state.asking ? el('span', { class: 'spinner light' }) : icon('spark'),
    state.asking ? 'Fil cherche…' : answer ? 'Redemander (nouvelle requête)' : 'Demander à Fil',
  );
  button.addEventListener('click', () => askFil(q));
  card.append(
    el(
      'div',
      { class: 'askhead' },
      el('div', {}, el('b', { text: 'Demander à Fil' }), el('p', { class: 'muted', text: `Le LLM répond à « ${q} » à partir de ${plural(scope.length, 'résumé', 'résumés')}${filterActive() ? ' (filtrés)' : ''}, avec des liens vers les conversations.` })),
      button,
    ),
  );
  if (answer) {
    card.append(el('div', { class: 'answer', dir: 'auto' }, renderAnswer(answer)));
    if (answer.at) card.append(el('p', { class: 'muted small', text: `Réponse gardée du ${fmt.full.format(answer.at)} : la revoir ne coûte rien.` }));
  }
  return card;
}

async function askFil(question) {
  if (state.asking || !question) return;
  const scope = askScope();
  const thread = state.thread;
  const me = firstName(thread.me);
  const others = thread.participants.filter((p) => p !== thread.me).map(firstName).join(', ');
  const list = scope
    .map((c) => {
      const s = state.summary.get(c.index);
      return `[${c.index + 1}] ${convLabel(c)}${s.title ? ` · ${s.title}` : ''}${s.tags.length ? ` · tags : ${s.tags.join(', ')}` : ''}\n${s.text.trim()}`;
    })
    .join('\n\n');
  state.asking = true;
  renderMain();
  try {
    const text = await chat([
      {
        role: 'system',
        content: [
          `Tu aides ${me}, qui a des trous de mémoire, à retrouver ce qui s’est passé dans ses conversations avec ${others}.`,
          'Tu as seulement les résumés ci-dessous, numérotés entre crochets, du plus ancien au plus récent.',
          'Réponds en français, court et précis, en citant chaque conversation utilisée par son numéro entre crochets, par exemple [12].',
          'Si la réponse n’est pas dans les résumés, dis-le simplement et propose les conversations les plus proches. N’invente rien.',
        ].join('\n'),
      },
      { role: 'user', content: `Résumés :\n\n${list}\n\nQuestion : ${question}` },
    ]);
    // Each [n] is kept as the time of that conversation, so links survive a change of cut.
    const refs = {};
    for (const match of text.matchAll(/\d+/g)) {
      const conv = state.convs[Number(match[0]) - 1];
      if (conv) refs[match[0]] = conv.from;
    }
    state.answer = await saveAsk(question, text, scope.length);
    state.answer.refs = refs;
    await put('asks', state.answer);
  } catch (e) {
    showNotice(`Fil n’a pas pu répondre.\n${e.message}`, 'error');
  } finally {
    state.asking = false;
    if (state.query.trim() === question) renderMain();
  }
}

// The answer with each [n] turned into a link to that conversation.
function renderAnswer(answer) {
  const parts = [];
  let from = 0;
  for (const match of answer.text.matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g)) {
    parts.push(answer.text.slice(from, match.index));
    for (const n of match[1].split(/\s*[,;]\s*/)) {
      const ts = answer.refs?.[n];
      const conv = ts != null ? convAt(ts) : state.convs[Number(n) - 1];
      if (!conv) continue;
      parts.push(
        el('button', {
          type: 'button',
          class: 'convlink',
          text: `${cap(fmt.dayMid.format(conv.from))} ${fmt.time.format(conv.from)}`,
          title: state.summary.get(conv.index)?.title || convLabel(conv),
          onclick: () => ((state.mode = 'resume'), openConv(conv.index)),
        }),
      );
    }
    from = match.index + match[0].length;
  }
  parts.push(answer.text.slice(from));
  return parts;
}

function switchControl(label, on, toggle, title) {
  const button = el('button', { type: 'button', class: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), title }, el('span', { class: 'track' }), label);
  button.addEventListener('click', toggle);
  return button;
}

function starsView() {
  const thread = state.thread;
  const byId = new Map(thread.messages.map((m) => [m.id, m]));
  const list = [...state.stars.keys()].map((id) => byId.get(id)).filter(Boolean).sort((a, b) => a.ts - b.ts);
  if (!list.length) {
    return [
      head('Favoris'),
      el('p', { class: 'edge', text: 'Aucun favori. Passe la souris sur un message et clique sur l’étoile pour le garder ici.' }),
    ];
  }
  return [head('Favoris', plural(list.length, 'message gardé', 'messages gardés')), ...grouped(list, (m) => hit(m, messageContent(m)))];
}

function notesView() {
  const filtered = filterActive();
  const scope = visibleConvs();
  const summarized = scope.filter((c) => state.summary.has(c.index));
  const todo = toSummarize(scope);
  const untagged = toTag(scope);
  const stale = scope.filter((c) => noteStatus(c) === 'stale').length;
  const actions = [];
  if (state.llm?.url && !state.batch) {
    if (todo.length) {
      const chars = todo.reduce((sum, c) => sum + convMessages(c).reduce((s, m) => s + m.text.length + 12, 0), 0);
      actions.push(
        el(
          'button',
          { type: 'button', class: 'pill accent small', title: `Environ ${num(Math.round(chars / 3.2 / 1000) * 1000)} tokens envoyés au total`, onclick: () => runBatch(scope) },
          icon('spark'),
          `Résumer ${filtered ? 'ces' : 'les'} ${num(todo.length)} restantes`,
        ),
      );
    }
    if (untagged.length) {
      actions.push(el('button', { type: 'button', class: 'pill small', onclick: () => runBatch(scope, 'tags') }, icon('spark'), `Taguer ${num(untagged.length)}`));
    }
  }
  const copyAll = el('button', { type: 'button', class: 'pill small', disabled: !summarized.length }, icon('copy'), 'Tout copier');
  copyAll.addEventListener('click', () => copyText(allNotes(summarized), copyAll, 'Copié'));
  actions.push(copyAll);

  const meta =
    `${plural(summarized.length, 'conversation résumée', 'conversations résumées')} sur ${num(scope.length)}` +
    (filtered ? ` filtrées (${filterSummary()})` : '') +
    (stale ? ` · ${plural(stale, 'à refaire', 'à refaire')}` : '') +
    ' · enregistrés sur ce PC, jamais redemandés au LLM';
  const out = [head('Résumés', meta, ...actions)];
  if (!state.llm?.url) {
    out.push(
      el(
        'p',
        { class: 'edge' },
        'Pour tout résumer d’un coup, ',
        el('button', { type: 'button', class: 'inline', text: 'configure un LLM dans les Réglages', onclick: () => showView('reglages') }),
        '.',
      ),
    );
  }
  if (!summarized.length) {
    out.push(el('p', { class: 'edge', text: filtered ? 'Aucun résumé parmi les conversations filtrées.' : 'Aucun résumé pour l’instant.' }));
    return out;
  }
  const byDate = state.filter.sort === 'old' || state.filter.sort === 'new';
  let month = '';
  for (const conv of summarized) {
    const m = cap(fmt.month.format(conv.from));
    if (byDate && m !== month) {
      month = m;
      out.push(el('h3', { class: 'group', text: m }));
    }
    const sum = state.summary.get(conv.index);
    const stale = sum.status === 'stale';
    out.push(
      el(
        'section',
        { class: `summary${stale ? ' stale' : ''}` },
        el(
          'button',
          { type: 'button', class: 'when', onclick: () => openConv(conv.index) },
          convLabel(conv),
          el('span', { class: 'muted', text: ` · ${plural(convCount(conv), 'message', 'messages')}` }),
          stale && el('span', { class: 'muted', text: ' · à refaire' }),
          sum.kind === 'parts' && el('span', { class: 'muted', text: ` · ${sum.parts.length} résumés regroupés` }),
        ),
        sum.title && el('h4', { text: sum.title }),
        sum.tags.length > 0 && el('div', { class: 'tagrow' }, sum.tags.map((t) => tagChip(t))),
        el('p', { dir: 'auto', text: sum.text.trim() }),
      ),
    );
  }
  return out;
}

/* ---------- Timeline (frise) ---------- */

const SPANS = [
  [182, '6 mois'],
  [365, '1 an'],
  [730, '2 ans'],
  [0, 'Ce que j’ai'],
];

function friseView() {
  const thread = state.thread;
  const pending = state.pending;
  const firstTs = thread.messages[0].ts;
  const lastTs = thread.messages[thread.messages.length - 1].ts;
  const fullEnd = Math.max(Date.now(), lastTs, pending ? pending.to : 0);
  let fullStart = state.span ? Math.min(firstTs, fullEnd - state.span * 864e5) : firstTs;
  if (pending) fullStart = Math.min(fullStart, pending.from);
  const zoom = state.zoom;
  const start = zoom ? zoom.from : fullStart;
  const end = zoom ? zoom.to : fullEnd;
  const width = end - start || 1;
  const pct = (ts) => `${(((ts - start) / width) * 100).toFixed(4)}%`;
  const ranges = coverage(thread);
  const coveredDays = ranges.reduce((sum, [a, b]) => sum + (b - a) / 864e5, 0);

  // The track: missing time (dashed), covered stretches, one bar per conversation
  // (as wide as it lasted, at least 2 px).
  const track = el('div', { class: 'track' });
  track.append(el('div', { class: 'lane missing' }));
  for (const [a, b] of ranges) track.append(el('div', { class: 'lane covered', style: `left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})` }));
  if (pending) track.append(el('div', { class: 'lane pending', style: `left:${pct(pending.from)};width:max(3px, calc(${pct(pending.to)} - ${pct(pending.from)}))` }));
  // The selection sits under the bars so they stay readable; bars outside it fade.
  const sel = state.sel;
  const visible = filterActive() ? new Set(visibleConvs().map((c) => c.index)) : null;
  if (sel) track.append(el('div', { class: 'selection', style: `left:${pct(sel.from)};width:calc(${pct(sel.to)} - ${pct(sel.from)})` }));
  const max = Math.log(1 + Math.max(...state.convs.map(convCount)));
  const ticks = new Map();
  for (const conv of state.convs) {
    if (conv.to < start || conv.from > end) continue;
    const status = noteStatus(conv);
    const height = 18 + (Math.log(1 + convCount(conv)) / max) * 56;
    const out = sel ? !(conv.to >= sel.from && conv.from <= sel.to) : visible && !visible.has(conv.index);
    const tick = el('span', {
      class: `tick ${status}${state.working.has(conv.id) ? ' busy' : ''}${conv.index === state.conv ? ' current' : ''}${out ? ' out' : ''}`,
      style: `left:${pct(conv.from)};width:max(2px, calc(${pct(conv.to)} - ${pct(conv.from)}));height:${height.toFixed(0)}px`,
    });
    ticks.set(conv.index, tick);
    track.append(tick);
  }

  const hint = zoom
    ? 'Molette : zoomer · Maj + molette : se déplacer · glisse pour choisir une période · clique sur une barre pour l’ouvrir.'
    : 'Survole une barre pour voir la conversation, clique pour l’ouvrir. Molette pour zoomer. Glisse pour choisir une période.';
  const info = el('div', { class: 'friseinfo' }, el('span', { class: 'muted', text: hint }));
  wireTrack(track, info, ticks, { start, width, fullStart, fullEnd, hint });

  const spanChips = el(
    'div',
    { class: 'chips' },
    SPANS.map(([days, label]) =>
      el('button', {
        type: 'button',
        class: `chip${!zoom && state.span === days ? ' on' : ''}`,
        text: label,
        onclick: () => {
          state.span = days;
          state.zoom = null;
          renderMain();
        },
      }),
    ),
    zoom &&
      el('button', {
        type: 'button',
        class: 'chip on',
        text: `Zoom : ${fmt.dayMonth.format(start)} → ${fmt.dayMonth.format(end)} ✕`,
        title: 'Revenir à la vue complète',
        onclick: () => {
          state.zoom = null;
          renderMain();
        },
      }),
  );
  const summarized = state.convs.filter(isSummarized).length;
  const legend = el(
    'div',
    { class: 'legend' },
    el('span', {}, el('i', { class: 'k ok' }), 'résumée'),
    el('span', {}, el('i', { class: 'k grouped' }), 'regroupée'),
    el('span', {}, el('i', { class: 'k none' }), 'pas résumée'),
    el('span', {}, el('i', { class: 'k stale' }), 'à refaire'),
    el('span', {}, el('i', { class: 'k missing' }), 'pas importé'),
  );
  const add = el('button', { type: 'button', class: 'pill accent small', onclick: () => $('#file').click() }, icon('import'), 'Ajouter un export');

  return [
    head(
      'Frise',
      `Tu as ${spanText(thread)} · ${plural(Math.round(coveredDays), 'jour', 'jours')} · ${num(summarized)} / ${num(state.convs.length)} conversations résumées`,
      add,
    ),
    el('div', { class: 'toolbar' }, spanChips, el('span', { class: 'grow' }), legend),
    el('div', { class: 'frise' }, track, axisFor(start, end, pct), moodBand(start, end, pct), info),
    pending ? pendingCard(pending) : selectionCard(),
    importsList(thread),
  ];
}

// Labels under the track: months when it shows a long stretch, days when zoomed, hours when zoomed a lot.
function axisFor(start, end, pct) {
  const axis = el('div', { class: 'axis' });
  const days = (end - start) / 864e5;
  const marks = [];
  const d = new Date(start);
  if (days > 75) {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() + 1);
    for (let i = 0; d.getTime() < end; i++, d.setMonth(d.getMonth() + 1)) {
      const label = d.getMonth() === 0 || i === 0 ? `${fmt.monthShort.format(d)} ${d.getFullYear()}` : fmt.monthShort.format(d);
      marks.push([d.getTime(), label]);
    }
  } else if (days > 2) {
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    const step = Math.max(1, Math.ceil(days / 12));
    for (; d.getTime() < end; d.setDate(d.getDate() + 1)) marks.push([d.getTime(), (d.getDate() - 1) % step === 0 ? fmt.dayMid.format(d) : '']);
  } else {
    const step = days > 1 ? 6 : days > 0.4 ? 3 : 1;
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    for (; d.getTime() < end; d.setHours(d.getHours() + 1)) {
      if (d.getHours() % step) continue;
      marks.push([d.getTime(), d.getHours() === 0 ? fmt.dayMid.format(d) : `${d.getHours()} h`]);
    }
  }
  const every = Math.ceil(marks.filter(([, l]) => l).length / 14);
  let shown = 0;
  for (const [ts, label] of marks) {
    const keep = label && shown++ % every === 0;
    axis.append(el('span', { class: 'mtick', style: `left:${pct(ts)}` }, keep ? label : ''));
  }
  return axis;
}

function wireTrack(track, info, ticks, view) {
  const { start, width, fullStart, fullEnd, hint } = view;
  const px = () => track.clientWidth || 1;
  const tsAt = (x) => start + (x / px()) * width;
  const xOf = (ts) => ((ts - start) / width) * px();
  // The bar under the mouse, or the closest one within 6 px.
  const nearest = (x) => {
    let best = null;
    let gap = 6;
    for (const conv of state.convs) {
      const a = xOf(conv.from);
      const b = Math.max(xOf(conv.to), a + 2);
      const d = x < a ? a - x : x > b ? x - b : 0;
      if (d < gap || (d === 0 && gap === 0 && best && convCount(conv) > convCount(best))) {
        gap = d;
        best = conv;
      }
    }
    return best;
  };
  let hovered = null;
  const showInfo = (conv) => {
    if (hovered === conv) return;
    ticks.get(hovered?.index)?.classList.remove('hover');
    hovered = conv;
    if (!conv) return info.replaceChildren(el('span', { class: 'muted', text: hint }));
    ticks.get(conv.index)?.classList.add('hover');
    const sum = state.summary.get(conv.index);
    info.replaceChildren(
      el('b', { text: convLabel(conv) }),
      el('span', { class: 'muted', text: ` · ${plural(convCount(conv), 'message', 'messages')}` }),
      sum?.title ? el('span', { text: ` · ${sum.title}` }) : el('span', { class: 'muted', text: ' · pas encore résumée' }),
      ...(sum?.tags || []).slice(0, 4).map((t) => el('span', { class: `tag ${kindOf(t)}`, text: t })),
    );
  };
  let down = null;
  const x = (event) => Math.max(0, Math.min(px(), event.clientX - track.getBoundingClientRect().left));
  track.addEventListener('pointerdown', (event) => {
    down = x(event);
    state.dragging = true;
    track.setPointerCapture(event.pointerId);
  });
  track.addEventListener('pointermove', (event) => {
    const now = x(event);
    if (down != null && Math.abs(now - down) > 4) {
      showInfo(null);
      let box = track.querySelector('.selection');
      if (!box) track.insertBefore((box = el('div', { class: 'selection' })), track.querySelector('.tick'));
      box.style.left = `${Math.min(down, now)}px`;
      box.style.width = `${Math.abs(now - down)}px`;
      info.replaceChildren(el('b', { text: `${fmt.full.format(tsAt(Math.min(down, now)))} → ${fmt.full.format(tsAt(Math.max(down, now)))}` }));
      return;
    }
    showInfo(nearest(now));
  });
  track.addEventListener('pointerleave', () => down == null && showInfo(null));
  track.addEventListener('pointerup', (event) => {
    if (down == null) return;
    const now = x(event);
    const from = down;
    down = null;
    state.dragging = false;
    if (Math.abs(now - from) <= 4) {
      const conv = nearest(now);
      if (conv) openConv(conv.index);
      return;
    }
    state.sel = { from: tsAt(Math.min(from, now)), to: tsAt(Math.max(from, now)) };
    renderMain();
  });
  // Wheel: zoom around the mouse. Shift + wheel (or a sideways swipe): move along.
  let frame = 0;
  track.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const full = fullEnd - fullStart;
      let from = start;
      let to = start + width;
      const sideways = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (sideways) {
        const shift = ((event.shiftKey ? event.deltaY : event.deltaX) / px()) * width;
        from += shift;
        to += shift;
      } else {
        const factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY / 300)));
        const center = tsAt(x(event));
        const next = Math.max(3 * 3600e3, Math.min(full, width * factor));
        from = center - ((center - start) / width) * next;
        to = from + next;
      }
      const span = to - from;
      if (from < fullStart) [from, to] = [fullStart, fullStart + span];
      if (to > fullEnd) [from, to] = [fullEnd - span, fullEnd];
      state.zoom = span >= full - 1 ? null : { from, to };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => renderMain());
    },
    { passive: false },
  );
}

function selectionCard() {
  if (!state.sel) return null;
  const { from, to } = state.sel;
  const convs = state.convs.filter((c) => c.to >= from && c.from <= to);
  const todo = toSummarize(convs);
  const done = convs.filter(isSummarized).length;
  const other = convs.length - done - todo.length;
  const actions = [];
  if (todo.length && state.llm?.url && !state.batch) {
    actions.push(el('button', { type: 'button', class: 'pill accent', onclick: () => runBatch(convs) }, icon('spark'), todo.length > 1 ? `Résumer ces ${num(todo.length)} conversations` : 'Résumer cette conversation'));
  } else if (todo.length && !state.llm?.url) {
    actions.push(el('button', { type: 'button', class: 'pill accent', text: 'Configurer un LLM pour résumer', onclick: () => showView('reglages') }));
  }
  actions.push(
    el('button', {
      type: 'button',
      class: 'pill',
      text: 'Filtrer sur cette période',
      title: 'La liste à gauche, les résumés et la recherche ne montrent plus que cette période',
      onclick: () => {
        state.sel = null;
        setFilter({ from, to });
      },
    }),
  );
  actions.push(
    el('button', {
      type: 'button',
      class: 'pill',
      text: 'Zoomer sur cette période',
      onclick: () => {
        const margin = (to - from) * 0.05;
        state.zoom = { from: from - margin, to: to + margin };
        renderMain();
      },
    }),
  );
  if (convs.length) actions.push(el('button', { type: 'button', class: 'pill', text: 'Ouvrir la première', onclick: () => openConv(convs[0].index) }));
  actions.push(
    el('button', {
      type: 'button',
      class: 'pill',
      text: 'Effacer la sélection',
      onclick: () => {
        state.sel = null;
        renderMain();
      },
    }),
  );
  const details = convs.length
    ? `${plural(convs.length, 'conversation', 'conversations')} : ${num(done)} déjà résumée${done > 1 ? 's' : ''} (enregistrées, rien n’est renvoyé au LLM), ${num(todo.length)} à résumer${other > 0 ? `, ${plural(other, 'trop courte ou à refaire', 'trop courtes ou à refaire')}` : ''}.`
    : 'Aucune conversation importée sur cette période.';
  const list = el(
    'div',
    { class: 'sellist' },
    convs.map((c) => {
      const sum = state.summary.get(c.index);
      const status = noteStatus(c);
      return el(
        'button',
        { type: 'button', class: 'selrow', onclick: () => openConv(c.index) },
        el('i', { class: `k ${status}` }),
        el('span', { class: 'when', text: convLabel(c) }),
        el('span', { class: `what${sum?.title ? '' : ' muted'}`, text: sum?.title || (textCount(c) < MIN_TEXTS ? 'très courte' : 'pas encore résumée') }),
        el('span', { class: 'count', text: num(convCount(c)) }),
      );
    }),
  );
  return el(
    'div',
    { class: 'panel' },
    el('p', { class: 'flabel', text: `Du ${fmt.full.format(from)} au ${fmt.full.format(to)}` }),
    el('p', { text: details }),
    el('div', { class: 'actions' }, actions),
    convs.length > 0 && list,
  );
}

function pendingCard(plan) {
  const first = plan.thread.messages[0].ts;
  const last = plan.thread.messages[plan.thread.messages.length - 1].ts;
  const before = plan.fresh.filter((m) => m.ts < first).length;
  const after = plan.fresh.filter((m) => m.ts > last).length;
  const between = plan.fresh.length - before - after;
  const where = [before && `${num(before)} avant ce que tu as`, after && `${num(after)} après`, between && `${num(between)} dans un trou`].filter(Boolean);
  const lines = [
    `Ce fichier va du ${fmt.full.format(plan.from)} au ${fmt.full.format(plan.to)} (${plural(plan.messages.length, 'message', 'messages')}).`,
    plan.fresh.length
      ? `À ajouter : ${plural(plan.fresh.length, 'message', 'messages')}${where.length ? ` (${where.join(', ')})` : ''}.`
      : 'Rien de nouveau : tout ce fichier couvre une période que tu as déjà.',
    plan.dup ? `Déjà présents : ${num(plan.dup)}.` : '',
    plan.conflict
      ? `Ignorés : ${plural(plan.conflict, 'message', 'messages')} dans une période que tu as déjà, mais différents de ce que tu as (retirés ou modifiés depuis). Ce que tu as est gardé tel quel.`
      : '',
  ].filter(Boolean);
  const cancel = el('button', {
    type: 'button',
    class: 'pill',
    text: plan.fresh.length ? 'Annuler' : 'Fermer',
    onclick: () => {
      state.pending = null;
      renderMain();
    },
  });
  return el(
    'div',
    { class: 'panel pending-card' },
    el('p', { class: 'flabel', text: `Nouvel export : ${plan.file}` }),
    lines.map((t) => el('p', { text: t })),
    el(
      'div',
      { class: 'actions' },
      plan.fresh.length > 0 && el('button', { type: 'button', class: 'pill accent', onclick: confirmImport }, icon('check'), `Ajouter ${plural(plan.fresh.length, 'message', 'messages')}`),
      cancel,
    ),
  );
}

function importsList(thread) {
  if (!thread.imports?.length) return null;
  return el(
    'div',
    {},
    el('h3', { class: 'group', text: 'Exports importés' }),
    el(
      'div',
      { class: 'panel imports' },
      [...thread.imports].reverse().map((i) =>
        el(
          'div',
          { class: 'import' },
          el('span', { class: 'iname', text: i.file || 'Export' }),
          el('span', {
            class: 'muted',
            text: `du ${fmt.date.format(i.from)} au ${fmt.date.format(i.to)} · ${plural(i.added, 'message ajouté', 'messages ajoutés')}${i.ignored ? `, ${num(i.ignored)} ignorés` : ''} · importé le ${fmt.date.format(i.at)}`,
          }),
        ),
      ),
    ),
  );
}

/* ---------- Settings ---------- */

function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'flabel', text: label }), input, hint && el('span', { class: 'hint', text: hint }));
}

function settingsView() {
  const llm = state.llm || {};
  const url = el('input', { id: 'llm-url', type: 'text', placeholder: 'https://…/v1', spellcheck: 'false', autocomplete: 'off' });
  const model = el('input', { id: 'llm-model', type: 'text', placeholder: 'gpt-4.1', spellcheck: 'false', autocomplete: 'off' });
  const key = el('input', { id: 'llm-key', type: 'password', placeholder: 'sk-…', spellcheck: 'false', autocomplete: 'off' });
  url.value = llm.url || '';
  model.value = llm.model || '';
  key.value = llm.key || '';
  const result = el('p', { class: 'result' });
  const save = el('button', { type: 'button', class: 'pill accent' }, icon('check'), 'Enregistrer et tester');
  save.addEventListener('click', () => saveLlm({ url: url.value.trim(), model: model.value.trim(), key: key.value.trim() }, result, save));
  const forget = el('button', { type: 'button', class: 'pill', disabled: !state.llm, text: 'Oublier ce LLM' });
  forget.addEventListener('click', async () => {
    await remove('prefs', 'llm');
    state.llm = null;
    showNotice('Le LLM et sa clé ont été effacés de Fil.');
    renderMain();
  });

  const gapChips = el(
    'div',
    { class: 'chips' },
    GAP_CHOICES.map((minutes) =>
      el('button', {
        type: 'button',
        class: `chip${state.gap === minutes ? ' on' : ''}`,
        text: minutes < 60 ? `${minutes} min` : `${minutes / 60} h`,
        onclick: () => setGap(minutes),
      }),
    ),
  );
  const gapCount = state.thread ? `Avec ${state.gap < 60 ? `${state.gap} min` : `${state.gap / 60} h`} : ${plural(state.convs.length, 'conversation', 'conversations')}.` : '';

  return [
    head('Réglages'),
    el('h3', { class: 'group', text: 'Découpage' }),
    el(
      'div',
      { class: 'panel' },
      field('Une nouvelle conversation commence après un silence de', gapChips, `${gapCount} Aucun résumé n’est perdu en changeant : chacun reste gardé pour son découpage. Une conversation qui en regroupe plusieurs déjà résumées affiche leurs résumés bout à bout, sans rien renvoyer au LLM.`),
      cutsPanel(),
    ),
    el('h3', { class: 'group', text: 'LLM pour les résumés' }),
    el(
      'div',
      { class: 'panel' },
      field('Adresse de l’API', url, 'Un service compatible OpenAI : l’adresse qui finit par /v1, ou l’adresse complète en /chat/completions (LiteLLM, OpenAI, OpenRouter, Ollama…).'),
      field('Modèle', model),
      field('Clé', key, 'Elle reste dans Fil, sur ce PC. Elle n’est pas dans les sauvegardes.'),
      el('div', { class: 'actions' }, save, forget),
      result,
      el('p', { class: 'hint', text: 'Quand tu demandes un résumé, les messages de cette conversation (et les résumés des 3 précédentes, pour le contexte) sont envoyés à ce service. Rien d’autre ne sort de ce PC.' }),
    ),
  ];
}

async function saveLlm(config, result, button) {
  result.className = 'result';
  let pattern;
  try {
    if (!config.url || !config.model) throw new Error('Il faut au moins l’adresse et le modèle.');
    pattern = originPattern(config.url);
  } catch (e) {
    result.className = 'result error';
    result.textContent = e.message;
    return;
  }
  // Asked straight from the click, as Chrome requires: the right to contact this one site only.
  const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  if (!granted) {
    result.className = 'result error';
    result.textContent = 'Sans ton accord, Fil ne peut pas contacter ce service. Clique à nouveau et choisis « Autoriser ».';
    return;
  }
  await put('prefs', { k: 'llm', ...config });
  state.llm = config;
  button.disabled = true;
  result.textContent = 'Enregistré. Test en cours…';
  try {
    const answer = await chat([{ role: 'user', content: 'Réponds seulement : OK' }]);
    result.className = 'result ok';
    result.textContent = `Ça marche. Réponse de ${config.model} : « ${answer.trim().slice(0, 80)} »`;
  } catch (e) {
    result.className = 'result error';
    result.textContent = `Enregistré, mais le test a échoué.\n${e.message}`;
  } finally {
    button.disabled = false;
  }
}

async function setGap(minutes) {
  if (state.batch) return showNotice('Attends la fin des résumés en cours (ou arrête-les) avant de changer le découpage.', 'error');
  const at = state.convs[state.conv]?.from;
  state.gap = minutes;
  await put('prefs', { k: 'gap', minutes });
  if (state.thread) {
    state.convs = buildConvs(state.thread.messages, state.gap);
    linkNotes();
    state.conv = at != null ? convAt(at).index : state.convs.length - 1;
  }
  render();
}

/* ---------- Texts for a LLM ---------- */

function transcriptLines(conv) {
  const messages = convMessages(conv);
  const lines = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let count = 1;
    if (isMedia(m)) {
      while (i + 1 < messages.length && isMedia(messages[i + 1]) && messages[i + 1].ts === m.ts && messages[i + 1].from === m.from) {
        i++;
        count++;
      }
    }
    let content;
    if (m.unsent || m.type === 'placeholder') content = '(message retiré)';
    else if (isMedia(m)) content = count > 1 ? `[${count} photos/vidéos]` : '[photo/vidéo]';
    else if (m.type === 'link' && !m.text) content = '[lien]';
    else content = m.text.replace(/\s*\n\s*/g, ' / ');
    lines.push(`[${fmt.time.format(m.ts)}] ${firstName(m.from)} : ${content}`);
  }
  return lines;
}

function allNotes(convs) {
  return convs
    .map((c) => {
      const sum = state.summary.get(c.index);
      return `## ${convLabel(c)}${sum.title ? ` — ${sum.title}` : ''}${sum.tags.length ? `\nTags : ${sum.tags.join(', ')}` : ''}\n${sum.text.trim()}`;
    })
    .join('\n\n');
}

async function copyText(text, button, done) {
  const label = [...button.childNodes];
  try {
    await navigator.clipboard.writeText(text);
    button.replaceChildren(icon('check'), done);
    setTimeout(() => button.replaceChildren(...label), 1600);
  } catch (e) {
    showNotice(`La copie a échoué : ${e.message}. Clique dans la page puis réessaie.`, 'error');
  }
}

/* ---------- Navigation ---------- */

async function selectThread(thread, at, view = 'fil') {
  const switching = state.thread !== thread;
  if (state.batch && switching) state.batch.controller.abort();
  state.thread = thread;
  state.cuts = cleanCuts(await getOne('prefs', `cuts|${thread.id}`));
  state.convs = buildConvs(thread.messages, state.gap);
  state.folded = null;
  const known = new Set([thread.id]);
  state.notes = (await getByThread('notes', thread.id))
    .map((n) => cleanNote(n, known))
    .filter(Boolean)
    .sort((a, b) => a.from - b.from);
  linkNotes();
  state.stars = new Map((await getByThread('stars', thread.id)).map((s) => [s.msg, s]));
  state.tags = ((await getOne('prefs', `tags|${thread.id}`))?.list || []).filter((t) => t && typeof t.name === 'string');
  state.chapters = new Map((await getByThread('chapters', thread.id)).map((r) => [r.key, r]));
  state.memory = new Map((await getByThread('memory', thread.id)).map((r) => [r.key, r]));
  state.asks = new Map((await getByThread('asks', thread.id)).map((r) => [r.key, r]));
  state.factsDone = new Map(Object.entries((await getOne('prefs', `facts|${thread.id}`))?.done || {}));
  state.portrait = (await getOne('prefs', `portrait|${thread.id}`)) || null;
  if (switching) state.filter = { ...NO_FILTER };
  state.conv = Number.isFinite(at) && state.convs.length ? convAt(at).index : state.convs.length - 1;
  state.view = view;
  state.sel = null;
  state.who = null;
  setQuery('');
  render();
  scrollTimelineToConv();
  $('#main').scrollTop = 0;
  savePrefs();
}

function openConv(index, focusId) {
  if (!state.convs[index]) return;
  state.conv = index;
  state.view = 'fil';
  state.writing = null;
  if (focusId) state.mode = 'messages';
  setQuery('');
  renderSide();
  renderMain();
  savePrefs();
  const row = focusId && state.nodes.get(focusId);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1900);
  } else {
    $('#main').scrollTop = 0;
  }
  scrollTimelineToConv('nearest');
}

function setQuery(value) {
  state.query = value;
  $('#q').value = value;
  $('#clear').hidden = !value;
}

function showView(view) {
  state.view = view;
  setQuery('');
  renderSide();
  renderMain();
  $('#main').scrollTop = 0;
}

function showNotice(text, kind = 'info') {
  $('#notice-text').textContent = text;
  $('#notice').className = kind;
  $('#notice').hidden = false;
}

/* ---------- Wiring ---------- */

function wire() {
  for (const slot of document.querySelectorAll('[data-icon]')) slot.replaceWith(icon(slot.dataset.icon));

  $('#import').addEventListener('click', () => $('#file').click());
  $('#backup').addEventListener('click', backup);
  $('#settings').addEventListener('click', () => showView('reglages'));
  $('#file').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#notice-close').addEventListener('click', () => ($('#notice').hidden = true));
  for (const tab of document.querySelectorAll('#tabs button')) tab.addEventListener('click', () => showView(tab.dataset.view));

  let timer = 0;
  $('#q').addEventListener('input', (event) => {
    $('#clear').hidden = !event.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = event.target.value;
      state.searchLimit = 60;
      renderSide();
      renderMain();
      $('#main').scrollTop = 0;
    }, 160);
  });
  $('#q').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setQuery('');
      render();
    }
  });
  $('#clear').addEventListener('click', () => {
    setQuery('');
    render();
    $('#q').focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      $('#q').focus();
      return;
    }
    if (!state.thread || state.view !== 'fil' || state.query) return;
    const [prev, next] = neighbours(state.convs[state.conv]);
    const target = event.key === 'ArrowLeft' ? prev : event.key === 'ArrowRight' ? next : null;
    if (target) {
      event.preventDefault();
      openConv(target.index);
    }
  });

  const drop = $('#drop');
  window.addEventListener('dragenter', (event) => {
    if (event.dataTransfer?.types.includes('Files')) drop.hidden = false;
  });
  drop.addEventListener('dragover', (event) => event.preventDefault());
  drop.addEventListener('dragleave', () => (drop.hidden = true));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.hidden = true;
    const files = [...event.dataTransfer.files];
    if (files.length) importFiles(files);
  });

  document.addEventListener('pointerdown', (event) => {
    const card = $('#filtercard');
    if (!card.hidden && !event.target.closest('#filtercard, #filter-open')) toggleFilterCard();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#filtercard').hidden) toggleFilterCard();
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.batch) event.preventDefault();
  });
  window.addEventListener('error', (event) => showNotice(`Erreur : ${event.message}`, 'error'));
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.name === 'AbortError') return;
    showNotice(`Erreur : ${event.reason?.message || event.reason}`, 'error');
  });
}

async function start() {
  wire();
  try {
    state.db = await openDb();
    state.threads = await getAll('threads');
    const [ui, gap, llm] = await Promise.all([getOne('prefs', 'ui'), getOne('prefs', 'gap'), getOne('prefs', 'llm')]);
    if (GAP_CHOICES.includes(gap?.minutes)) state.gap = gap.minutes;
    if (llm?.url) state.llm = { url: llm.url, model: llm.model, key: llm.key || '' };
    const thread = state.threads.find((t) => t.id === ui?.thread) || state.threads.slice().sort((a, b) => b.messages.length - a.messages.length)[0];
    if (thread) await selectThread(thread, ui?.at);
    else render();
  } catch (e) {
    render();
    showNotice(`Fil n’arrive pas à ouvrir ses données : ${e.message}`, 'error');
  }
}
