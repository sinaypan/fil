'use strict';
// Fil: reading exports of every platform into one common shape:
// { platform, kind: 'duo' | 'group', title, participants, me (or null when
//   the export does not say), messages: [{ id, ts, from, type, text, unsent, media, react }],
//   source, platforms (when the file could come from several), key }

/* ---------- Files, folders and zips ---------- */

// Every file given (or found in a folder or a .zip), as { name, path, text() }.
async function expandInputs(files) {
  const out = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (/\.zip$/i.test(file.name)) {
      for (const entry of await readZip(await file.arrayBuffer())) {
        if (/\.(txt|json|csv)$/i.test(entry.name)) out.push({ name: entry.name.split('/').pop(), path: `${file.name}/${entry.name}`, zip: file.name, text: entry.text });
      }
    } else if (/\.(txt|json|csv)$/i.test(file.name)) {
      out.push({ name: file.name, path, text: () => file.text() });
    }
  }
  return out;
}

// The entries of a .zip, inflated with the browser's own DecompressionStream.
async function readZip(buffer) {
  const view = new DataView(buffer);
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error(t('zipUnreadable'));
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, at + 46, nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = new Uint8Array(buffer, start, size);
    entries.push({
      name,
      text: async () => {
        if (method === 0) return decoder.decode(data);
        if (method !== 8) throw new Error(t('zipMethod', name));
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).text();
      },
    });
  }
  return entries;
}

/* ---------- Common shape ---------- */

// Same message, same id in every export: time, a fingerprint of the content and
// the rank among identical messages of the same moment.
function withIds(raw) {
  const ranks = new Map();
  const out = [];
  for (const m of raw) {
    if (!Number.isFinite(m.ts)) continue;
    const from = String(m.from ?? '');
    const type = String(m.type ?? 'text');
    const text = typeof m.text === 'string' ? m.text : '';
    const base = `${Math.round(m.ts).toString(36)}.${hash(`${from}\u0001${type}\u0001${text}`)}`;
    const rank = ranks.get(base) ?? 0;
    ranks.set(base, rank + 1);
    out.push({ id: `${base}.${rank}`, ts: Math.round(m.ts), from, type, text, unsent: Boolean(m.unsent), media: m.media || 0, react: m.react || [] });
  }
  return out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

function parsed(platform, { title, participants, me, messages, source, kind, platforms, key }) {
  const list = withIds(messages);
  const people = [...new Set([...participants, ...list.map((m) => m.from)].filter(Boolean))];
  return {
    platform,
    platforms: platforms || [platform],
    kind: kind || (people.length > 2 ? 'group' : 'duo'),
    title: title || '',
    participants: people,
    me: me && people.includes(me) ? me : null,
    messages: list,
    source,
    key: key || `${platform}|${source}`,
  };
}

/* ---------- Messenger (end-to-end encrypted export) ---------- */

function parseMessengerE2EE(json, source) {
  const participants = json.participants.map(String).filter(Boolean);
  const messages = json.messages
    .filter((m) => m && Number.isFinite(m.timestamp))
    .map((m) => ({
      ts: m.timestamp,
      from: String(m.senderName ?? ''),
      type: String(m.type ?? 'text'),
      text: typeof m.text === 'string' ? m.text : '',
      unsent: Boolean(m.isUnsent),
      media: Array.isArray(m.media) ? m.media.length : 0,
      react: Array.isArray(m.reactions) ? m.reactions.filter((r) => r && r.reaction).map((r) => [String(r.actor ?? ''), String(r.reaction)]) : [],
    }));
  const group = participants.length > 2;
  // The owner of the export comes first.
  return parsed('messenger', { title: group ? String(json.threadName || '').replace(/_\d+$/, '') : '', participants, me: participants[0], messages, source, kind: group ? 'group' : 'duo' });
}

/* ---------- Messenger and Instagram ("Download your information" JSON) ---------- */

// Those files store UTF-8 bytes as if each one were a character.
function fixMeta(text) {
  if (typeof text !== 'string') return '';
  try {
    return decodeURIComponent(escape(text));
  } catch {
    return text;
  }
}

function parseMetaClassic(json, source, path) {
  const participants = json.participants.map((p) => fixMeta(p.name || p)).filter(Boolean);
  const messages = json.messages
    .filter((m) => m && Number.isFinite(m.timestamp_ms))
    .map((m) => {
      const media = ['photos', 'videos', 'audio_files', 'gifs', 'files'].reduce((n, k) => n + (Array.isArray(m[k]) ? m[k].length : 0), 0) + (m.sticker ? 1 : 0);
      const text = fixMeta(m.content || (m.share?.link ? m.share.link : ''));
      return {
        ts: m.timestamp_ms,
        from: fixMeta(m.sender_name || ''),
        type: m.is_unsent ? 'placeholder' : media && !m.content ? 'media' : m.share?.link && !m.content ? 'link' : 'text',
        text,
        unsent: Boolean(m.is_unsent),
        media,
        react: Array.isArray(m.reactions) ? m.reactions.map((r) => [fixMeta(r.actor), fixMeta(r.reaction)]) : [],
      };
    });
  const lower = (path || '').toLowerCase();
  const platforms = /instagram/.test(lower) ? ['instagram'] : /facebook|messenger/.test(lower) ? ['messenger'] : ['messenger', 'instagram'];
  const threadPath = json.thread_path || json.thread_path_v2 || '';
  return parsed(platforms[0], {
    title: fixMeta(json.title || ''),
    participants,
    me: null,
    messages,
    source,
    kind: participants.length > 2 ? 'group' : 'duo',
    platforms,
    key: `meta|${threadPath || participants.slice().sort().join('|')}`,
  });
}

/* ---------- WhatsApp (.txt, or the .zip it makes) ---------- */

const WA_LINE = /^‎?\[?(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4}),?\s+(\d{1,2})[:h.](\d{2})(?::(\d{2}))?(?:[\s  ]*([AaPp])\.?\s?[Mm]\.?)?\]?\s*(?:[-–]\s*)?(.*)$/;
const WA_MEDIA = /^‎?(<?(médias? omis|media omitted|image omitted|video omitted|audio omitted|sticker omitted|gif omitted|document omitted|image absente|vidéo absente|audio omis|autocollant omis|gif omis|document omis)>?|<(attached|pièce jointe)\s*:.*>)$/i;
const WA_DELETED = /^‎?(ce message a été supprimé|this message was deleted|vous avez supprimé ce message|you deleted this message)\.?$/i;

function parseWhatsApp(text, source, zipName) {
  const lines = text.replace(/\r/g, '').split('\n');
  const heads = [];
  for (const line of lines) {
    const m = WA_LINE.exec(line);
    if (m) heads.push(m);
  }
  if (heads.length < 2) throw new Error(t('notWhatsApp', source));
  // Day/month or month/day: a first number above 12 is a day, a second one above 12 is a day.
  let order = 'dmy';
  if (heads.some((m) => Number(m[1]) > 31)) order = 'ymd';
  else if (!heads.some((m) => Number(m[1]) > 12) && heads.some((m) => Number(m[2]) > 12)) order = 'mdy';
  const toTs = (m) => {
    let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    let [y, mo, d] = order === 'ymd' ? [a, b, c] : order === 'mdy' ? [c, a, b] : [c, b, a];
    if (y < 100) y += 2000;
    let h = Number(m[4]);
    if (m[7]) {
      const pm = /p/i.test(m[7]);
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    return new Date(y, mo - 1, d, h, Number(m[5]), Number(m[6] || 0)).getTime();
  };
  const messages = [];
  let last = null;
  for (const line of lines) {
    const m = WA_LINE.exec(line);
    if (!m) {
      if (last && line.trim()) last.text += `\n${line}`;
      continue;
    }
    const rest = m[8];
    const colon = rest.indexOf(': ');
    if (colon <= 0) {
      last = null; // a line from WhatsApp itself (encryption notice, someone joined…)
      continue;
    }
    last = { ts: toTs(m), from: rest.slice(0, colon).replace(/^‎/, '').trim(), text: rest.slice(colon + 2) };
    messages.push(last);
  }
  for (const msg of messages) {
    const t = msg.text.replace(/‎/g, '').replace(/\s*<(ce message a été modifié|this message was edited)>\s*$/i, '').trim();
    if (WA_MEDIA.test(t)) Object.assign(msg, { type: 'media', text: '', media: 1 });
    else if (WA_DELETED.test(t)) Object.assign(msg, { type: 'placeholder', text: '', unsent: true });
    else Object.assign(msg, { type: /^https?:\/\/\S+$/.test(t) ? 'link' : 'text', text: t });
  }
  const name = (zipName || source).replace(/\.(txt|zip)$/i, '');
  const title = (name.match(/(?:Discussion WhatsApp avec|WhatsApp Chat with|WhatsApp Chat -|Chat WhatsApp con|WhatsApp-Chat mit)\s*(.+)$/i) || [])[1] || '';
  const senders = [...new Set(messages.map((x) => x.from))];
  const duo = senders.length <= 2 && (!title || senders.some((s) => tagKey(s) === tagKey(title)) || senders.length === 1);
  return parsed('whatsapp', { title: duo ? '' : title, participants: duo && title && !senders.some((s) => tagKey(s) === tagKey(title)) ? [...senders, title] : senders, me: null, messages, source: zipName || source, kind: duo ? 'duo' : 'group', key: `whatsapp|${tagKey(title || senders.join(' '))}` });
}

/* ---------- Telegram (Telegram Desktop, JSON) ---------- */

function telegramText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

function parseTelegramChat(chat, meId, source) {
  if (!Array.isArray(chat.messages)) return null;
  if (/channel|saved_messages/.test(chat.type || '')) return null;
  let me = null;
  const messages = [];
  for (const m of chat.messages) {
    if (m.type !== 'message') continue;
    const from = m.from || m.actor || t('unknownName');
    if (meId && m.from_id === meId) me = from;
    const text = telegramText(m.text);
    const media = m.photo || m.file || m.media_type || m.sticker_emoji ? 1 : 0;
    const react = [];
    for (const r of m.reactions || []) for (const who of r.recent || []) react.push([who.from || '', r.emoji || '♥']);
    messages.push({ ts: Number(m.date_unixtime) * 1000 || Date.parse(m.date), from, type: media && !text ? 'media' : 'text', text, media, react });
  }
  if (!messages.length) return null;
  const group = /group/.test(chat.type || '');
  const participants = group ? [] : [String(chat.name || '')].filter(Boolean);
  return parsed('telegram', { title: group ? String(chat.name || '') : '', participants, me, messages, source, kind: group ? 'group' : 'duo', key: `telegram|${chat.id ?? chat.name}` });
}

function parseTelegram(json, source) {
  if (json.chats && Array.isArray(json.chats.list)) {
    const meId = json.personal_information?.user_id ? `user${json.personal_information.user_id}` : null;
    return json.chats.list.map((c) => parseTelegramChat(c, meId, source)).filter(Boolean);
  }
  return [parseTelegramChat(json, null, source)].filter(Boolean);
}

/* ---------- Discord (data package: only your own messages) ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

async function parseDiscord(entries) {
  const byPath = new Map(entries.map((e) => [e.path.toLowerCase(), e]));
  const find = (re) => entries.find((e) => re.test(e.path.toLowerCase().replace(/\\/g, '/')));
  const user = find(/account\/user\.json$/);
  let me = t('meName');
  if (user) {
    try {
      const u = JSON.parse(await user.text());
      me = u.global_name || u.username || me;
    } catch {}
  }
  const indexEntry = find(/messages\/index\.json$/);
  let index = {};
  if (indexEntry) {
    try {
      index = JSON.parse(await indexEntry.text());
    } catch {}
  }
  const out = [];
  const dirs = new Map();
  for (const e of entries) {
    const p = e.path.replace(/\\/g, '/');
    const m = /messages\/c?(\d+)\/(channel\.json|messages\.json|messages\.csv)$/i.exec(p);
    if (!m) continue;
    if (!dirs.has(m[1])) dirs.set(m[1], {});
    dirs.get(m[1])[m[2].toLowerCase()] = e;
  }
  for (const [id, files] of dirs) {
    let channel = {};
    if (files['channel.json']) {
      try {
        channel = JSON.parse(await files['channel.json'].text());
      } catch {}
    }
    let rows = [];
    if (files['messages.json']) {
      try {
        rows = JSON.parse(await files['messages.json'].text()).map((r) => ({ ts: Date.parse(String(r.Timestamp || '').replace(' ', 'T')), text: r.Contents || '', attachments: r.Attachments || '' }));
      } catch {}
    } else if (files['messages.csv']) {
      const csv = parseCsv(await files['messages.csv'].text());
      const head = csv.shift() || [];
      const col = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
      rows = csv.filter((r) => r.length > 1).map((r) => ({ ts: Date.parse(String(r[col('timestamp')] || '').replace(' ', 'T')), text: r[col('contents')] || '', attachments: r[col('attachments')] || '' }));
    }
    if (!rows.length) continue;
    const label = index[id] || channel.name || t('channelN', id);
    const dm = /^Direct Message with (.+)$/i.exec(label);
    const other = dm ? dm[1].replace(/#0$/, '') : null;
    const messages = rows.map((r) => ({ ts: r.ts, from: me, type: r.attachments && !r.text ? 'media' : 'text', text: r.text, media: r.attachments ? 1 : 0 }));
    out.push(parsed('discord', { title: dm ? '' : label.replace(/ in /, ' · '), participants: dm ? [me, other] : [me], me, messages, source: `Discord ${label}`, kind: dm ? 'duo' : 'group', key: `discord|${id}` }));
  }
  if (!byPath.size || !out.length) return [];
  return out;
}

/* ---------- Detection ---------- */

// Reads every entry and returns { threads: [...parsed], backups: [json], errors: [text] }.
async function parseInputs(files) {
  const entries = await expandInputs(files);
  const result = { threads: [], backups: [], errors: [] };
  const isDiscord = entries.some((e) => /messages\/c?\d+\/(messages\.(json|csv)|channel\.json)$/i.test(e.path.replace(/\\/g, '/')));
  if (isDiscord) {
    result.threads.push(...(await parseDiscord(entries)));
  }
  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, '/');
    if (isDiscord && /messages\/|account\/|servers\/|activity\/|activities/i.test(path)) continue;
    try {
      const text = await entry.text();
      if (/\.txt$/i.test(entry.name)) {
        result.threads.push(parseWhatsApp(text, entry.name, entry.zip));
        continue;
      }
      if (!/\.json$/i.test(entry.name)) continue;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(t('badJson', entry.name));
      }
      if (json && json.fil === 1) result.backups.push({ json, name: entry.name });
      else if (Array.isArray(json?.messages) && Array.isArray(json?.participants) && json.messages.some((m) => 'senderName' in m) && typeof json.participants[0] === 'string') result.threads.push(parseMessengerE2EE(json, entry.name));
      else if (Array.isArray(json?.messages) && Array.isArray(json?.participants) && (json.messages.some((m) => 'sender_name' in m) || json.participants.some((p) => p && p.name))) result.threads.push(parseMetaClassic(json, entry.name, path));
      else if (json?.chats?.list || (Array.isArray(json?.messages) && json.messages.some((m) => 'date_unixtime' in m || 'from_id' in m))) result.threads.push(...parseTelegram(json, entry.name));
      else if (files.length === 1 || entries.length === 1) throw new Error(t('notExport', entry.name));
    } catch (e) {
      result.errors.push(e.message);
    }
  }
  // Several files of the same thread (message_1.json, message_2.json…) become one.
  const merged = new Map();
  for (const thread of result.threads) {
    if (!thread.messages.length) continue;
    const prev = merged.get(thread.key);
    if (!prev) merged.set(thread.key, thread);
    else {
      prev.messages = withIds([...prev.messages, ...thread.messages].map(({ id, ...m }) => m));
      prev.participants = [...new Set([...prev.participants, ...thread.participants])];
      prev.source = `${prev.source}, ${thread.source}`;
    }
  }
  result.threads = [...merged.values()];
  if (!entries.length) result.errors.push(t('noReadableFile'));
  return result;
}
