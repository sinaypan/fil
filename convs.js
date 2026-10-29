'use strict';
// Fil: Cutting a thread into conversations; summaries attached to them.

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
const titleOf = (thread) =>
  thread.kind === 'group'
    ? thread.title || thread.participants.filter((p) => p !== thread.me).map((p) => firstName(displayName(thread.platform || 'messenger', p))).join(', ')
    : thread.participants.filter((p) => p !== thread.me).map((p) => displayName(thread.platform || 'messenger', p)).join(', ') || thread.participants[0];

function spanText(thread) {
  const parts = coverage(thread).map(([a, b]) => {
    const sameYear = new Date(a).getFullYear() === new Date(b).getFullYear();
    return t('spanFromTo', (sameYear ? fmt.dayMonth : fmt.date).format(a), fmt.date.format(b));
  });
  return parts.length ? parts.join(t('spanThen')) : t('noMessage');
}

const convLabel = (conv) => `${cap(fmt.dayMid.format(conv.from))} ${new Date(conv.from).getFullYear()}, ${fmt.time.format(conv.from)} → ${fmt.time.format(conv.to)}`;

