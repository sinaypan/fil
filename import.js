'use strict';
// Fil: Reading exports, merging them into a conversation, backups.

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

// Duos on Messenger keep the id of the first versions (the sorted names);
// other platforms are prefixed, groups also carry their name.
function threadId(participants, platform = 'messenger', kind = 'duo', title = '') {
  const people = [...participants].sort().join('\u0001');
  if (kind === 'group') return `${platform}:g:${tagKey(title)}:${hash(people)}`;
  return platform === 'messenger' ? people : `${platform}:${people}`;
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
async function planImport(parsed) {
  const { participants, messages, source: file } = parsed;
  let id = threadId(participants, parsed.platform, parsed.kind, parsed.title);
  // A Messenger group imported by a first version kept the plain id.
  const legacy = [...participants].sort().join('\u0001');
  if (parsed.platform === 'messenger' && state.threads.some((t) => t.id === legacy)) id = legacy;
  const meta = state.threads.find((t) => t.id === id) || null;
  const thread = meta ? await loadThread(meta) : null;
  const from = messages.reduce((a, m) => Math.min(a, m.ts), Infinity);
  const to = messages.reduce((a, m) => Math.max(a, m.ts), -Infinity);
  const plan = { id, parsed, participants, thread, messages, file, from, to, fresh: [], dup: 0, conflict: 0 };
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
  const p = plan.parsed;
  let thread = plan.thread ? (state.thread?.id === plan.id ? state.thread : plan.thread) : null;
  if (!thread) thread = { id: plan.id, platform: p.platform, kind: p.kind, title: p.title, participants: p.participants, me: p.me, messages: [], ranges: [], imports: [] };
  thread.participants = [...new Set([...thread.participants, ...p.participants])];
  if (!thread.me && p.me) thread.me = p.me;
  const added = mergeMessages(thread, plan.fresh);
  thread.ranges = addRange(thread.ranges, plan.from, plan.to);
  thread.imports.push({ at: Date.now(), file: plan.file, from: plan.from, to: plan.to, count: plan.messages.length, added, ignored: plan.conflict });
  await saveThread(thread);
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
    const platform = typeof t.platform === 'string' ? t.platform : 'messenger';
    const kind = t.kind === 'group' ? 'group' : participants.length > 2 ? 'group' : 'duo';
    const id = typeof t.id === 'string' ? t.id : threadId(participants, platform, kind, t.title || '');
    let thread = state.threads.some((x) => x.id === id) ? await loadThread(id) : null;
    if (!thread) thread = { id, platform, kind, title: String(t.title || ''), participants, me: String(t.me || participants[0]), messages: [], ranges: [], imports: [] };
    added += mergeMessages(thread, messages);
    for (const r of Array.isArray(t.ranges) ? t.ranges : []) {
      if (Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1])) thread.ranges = addRange(thread.ranges, r[0], r[1]);
    }
    await saveThread(thread);
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
  for (const p of Array.isArray(json.people) ? json.people : []) {
    if (p && typeof p.id === 'string' && Array.isArray(p.ids) && !(await getOne('people', p.id))) await put('people', { id: p.id, name: String(p.name || ''), ids: p.ids.filter((x) => typeof x === 'string'), me: Boolean(p.me) });
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
  const parts = [t('importNew', `${platformOf(thread.platform).name} · ${titleOf(thread)}`, added ? plural(added, 'nNewMessage') : t('noNewMessage'))];
  if (plan.dup) parts.push(plural(plan.dup, 'nAlreadyThere'));
  if (plan.conflict) parts.push(t('ignoredBecause', plural(plan.conflict, 'nIgnored')));
  return t('importNow', parts.join(', '), spanText(thread));
}

async function importFiles(files) {
  let result;
  try {
    result = await parseInputs(files);
  } catch (e) {
    return showNotice(e.message, 'error');
  }
  const lines = [...result.errors];
  let errors = result.errors.length;
  let target = null;
  for (const b of result.backups) {
    try {
      const r = await restoreBackup(b.json);
      target = r.thread || target;
      lines.push(t('backupRestored', b.name, plural(r.added, 'nMessageAdded'), plural(r.notesKept, 'nSummary'), plural(r.starsKept, 'nFavorite')));
    } catch (e) {
      errors++;
      lines.push(e.message);
    }
  }
  const ready = [];
  for (const t of result.threads) {
    resolveOwner(t);
    if (t.platforms.length > 1 || !t.me) state.pendingImports.push(t);
    else ready.push(t);
  }
  // A single export of a conversation already here: show it on the timeline first.
  if (ready.length === 1 && !result.backups.length && !result.errors.length && result.threads.length === 1) {
    const plan = await planImport(ready[0]);
    if (plan.thread) {
      state.pending = plan;
      await selectThread(plan.thread);
      return showView('frise');
    }
  }
  const added = [];
  for (const t of ready) {
    try {
      const plan = await planImport(t);
      const r = await commitImport(plan);
      target = r.thread;
      added.push(r.thread);
      lines.push(importReport(plan, r.added, r.thread));
    } catch (e) {
      errors++;
      lines.push(e.name === 'QuotaExceededError' ? t('noRoomConvs') : e.message);
    }
  }
  await syncPeople();
  if (state.pendingImports.length) lines.push(t('pendingOnHome', plural(state.pendingImports.length, 'nConvWaiting')));
  if (lines.length > 6) lines.splice(5, lines.length - 6, t('moreLines', lines.length - 6));
  if (added.length === 1 && !state.pendingImports.length) {
    const at = state.thread?.id === target.id ? state.convs[state.conv]?.from : null;
    await selectThread(target, at);
  } else {
    await goHome('people');
  }
  if (lines.length) showNotice(lines.join('\n'), errors && errors >= lines.length ? 'error' : 'info');
}

// The owner of an export, when the file does not say: a name already confirmed as yours.
function resolveOwner(t) {
  if (t.me) return;
  for (const platform of t.platforms) {
    const found = t.participants.find((name) => state.meIds.has(`${platform}|${name}`));
    if (found) {
      t.me = found;
      if (t.platforms.length > 1) {
        t.platform = platform;
        t.platforms = [platform];
      }
      return;
    }
  }
}

// Answer to "which name is yours" or "which platform", then import.
async function answerPending(index, { me, platform }) {
  const t = state.pendingImports[index];
  if (!t) return;
  if (platform) {
    t.platform = platform;
    t.platforms = [platform];
    t.key = t.key.replace(/^meta\|/, `${platform}|`);
  }
  if (me) {
    t.me = me;
    state.meIds.add(`${t.platform}|${me}`);
  }
  if (t.platforms.length > 1 || !t.me) return render();
  state.pendingImports.splice(index, 1);
  // The same answer settles the other files waiting with the same name.
  for (const other of [...state.pendingImports]) {
    resolveOwner(other);
  }
  const done = [t, ...state.pendingImports.filter((o) => o.me && o.platforms.length === 1)];
  state.pendingImports = state.pendingImports.filter((o) => !done.includes(o));
  const lines = [];
  for (const item of done) {
    const plan = await planImport(item);
    const r = await commitImport(plan);
    lines.push(importReport(plan, r.added, r.thread));
  }
  await syncPeople();
  await goHome('people');
  showNotice(lines.join('\n'));
}

async function confirmImport() {
  const pending = state.pending;
  state.pending = null;
  try {
    const plan = await planImport(pending.parsed); // recomputed: the data may have changed meanwhile
    const r = await commitImport(plan);
    await selectThread(r.thread, state.convs[state.conv]?.from, 'frise');
    showNotice(importReport(plan, r.added, r.thread));
  } catch (e) {
    showView('frise');
    showNotice(e.name === 'QuotaExceededError' ? t('noRoomConv') : t('addFailed', e.message), 'error');
  }
}

async function backup() {
  try {
    // The LLM settings (and its key) are not part of the backup.
    const data = {
      fil: 1,
      savedAt: new Date().toISOString(),
      threads: await Promise.all(state.threads.map(async (meta) => ({ ...meta, messages: (await loadThread(meta)).messages }))),
      people: await getAll('people'),
      notes: await getAll('notes'),
      stars: await getAll('stars'),
      tags: (await getAll('prefs')).filter((r) => typeof r.k === 'string' && r.k.startsWith('tags|')),
      chapters: await getAll('chapters'),
      memory: await getAll('memory'),
      asks: await getAll('asks'),
      prefs: (await getAll('prefs')).filter((r) => typeof r.k === 'string' && (r.k.startsWith('facts|') || r.k.startsWith('cuts|') || r.k.startsWith('portrait|'))),
    };
    const name = t('backupFile', new Date().toISOString().slice(0, 10));
    const link = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    showNotice(t('backupSaved', name));
  } catch (e) {
    showNotice(t('backupFailed', e.message), 'error');
  }
}

