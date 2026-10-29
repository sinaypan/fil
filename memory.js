'use strict';
// Fil: what is built on top of the summaries, never on the messages:
// chapters (a week, a month), "À retenir" (promises, plans, dates, open
// questions, facts), the index of people and places, and the questions asked.
// All of it is saved; a chapter or a month is marked to redo when the
// summaries it was written from have changed.

const FACT_TYPES = [
  // key (stored), label, what it is, one of them, the word the LLM writes
  ['promesse', t('fxPromises'), t('fxPromisesWhat'), t('fxPromise'), t('fwPromise')],
  ['projet', t('fxPlans'), t('fxPlansWhat'), t('fxPlan'), t('fwPlan')],
  ['date', t('fxDates'), t('fxDatesWhat'), t('fxDate'), t('fwDate')],
  ['suspens', t('fxPending'), t('fxPendingWhat'), t('fxPendingOne'), t('fwPending')],
  ['fait', t('fxFacts'), t('fxFactsWhat'), t('fxFact'), t('fwFact')],
];
const ENTITY_KINDS = [
  ['personne', t('enPeople'), t('ewPerson')],
  ['lieu', t('enPlaces'), t('ewPlace')],
  ['autre', t('enOthers'), t('ewOther')],
];
const RES_VIEWS = [
  ['convs', t('conversations'), 'bubble'],
  ['weeks', t('weeks'), 'frise'],
  ['months', t('months'), 'doc'],
  ['facts', t('toRemember'), 'check'],
  ['index', t('enPeople'), 'person'],
  ['asks', t('questions'), 'spark'],
];

/* ---------- Periods ---------- */

function periodOf(kind, ts) {
  const d = new Date(ts);
  if (kind === 'month') {
    const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
    return { kind, from, to, label: cap(fmt.month.format(from)) };
  }
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const from = monday.getTime();
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const to = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7).getTime() - 1;
  const sameMonth = monday.getMonth() === sunday.getMonth();
  // The day alone when the month follows it anyway ("du 3 au 9 août"), else day and month.
  const dayFirst = fmt.date.format(sunday).startsWith(String(sunday.getDate()));
  const label = t('weekOf', sameMonth && dayFirst ? monday.getDate() : fmt.dayMonth.format(monday), fmt.date.format(sunday));
  return { kind, from, to, label };
}

// Every week or month that has conversations, oldest first, limited to the filtered period.
function periods(kind) {
  const f = state.filter;
  const map = new Map();
  for (const conv of state.convs) {
    if ((f.from != null && conv.to < f.from) || (f.to != null && conv.from > f.to)) continue;
    const p = periodOf(kind, conv.from);
    if (!map.has(p.from)) map.set(p.from, { ...p, key: `${state.thread.id}|${kind}|${p.from}`, convs: [] });
    map.get(p.from).convs.push(conv);
  }
  return [...map.values()].sort((a, b) => a.from - b.from);
}

// Fingerprint of the summaries a chapter or a month was written from (titles and texts, not tags).
function sigOf(convs) {
  return hash(
    convs
      .filter(isSummarized)
      .map((c) => {
        const s = state.summary.get(c.index);
        return `${c.id}:${s.title}:${s.text}`;
      })
      .join('\u0001'),
  );
}

function summaryList(convs, numbered) {
  return convs
    .filter(isSummarized)
    .map((c) => {
      const s = state.summary.get(c.index);
      return `${numbered ? `[${c.index + 1}] ` : ''}${convLabel(c)}${s.title ? ` · ${s.title}` : ''}${s.tags.length ? ` · ${t('trTags', s.tags.join(', '))}` : ''}\n${s.text.trim()}`;
    })
    .join('\n\n');
}

const llmIntro = () => systemPrompt().split('\n').slice(0, 3).join('\n');

/* ---------- Chapters ---------- */

function chapterStatus(period) {
  if (!period.convs.some(isSummarized)) return 'empty';
  const rec = state.chapters.get(period.key);
  if (!rec) return 'none';
  return rec.sig === sigOf(period.convs) ? 'ok' : 'stale';
}

async function writeChapter(period, signal) {
  const thread = state.thread;
  const what = t(period.kind === 'month' ? 'chWhatMonth' : 'chWhatWeek');
  const answer = await chat(
    [
      {
        role: 'system',
        content: [
          llmIntro(),
          t('chPrompt1', what),
          t('pAnswerIn', LANG_NAME),
          t('chTitle'),
          t('chMood'),
          t('chPoint'),
          t('chPoints', period.kind === 'month' ? 8 : 6),
        ].join('\n'),
      },
      { role: 'user', content: t('chUser', period.label, plural(period.convs.filter(isSummarized).length, 'nConvSummarized'), summaryList(period.convs, false)) },
    ],
    signal,
  );
  if (state.thread !== thread) return;
  const lines = answer.trim().split('\n');
  const take = (word) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s*[#*]*\\s*${word}\\s*[*]*\\s*:`, 'i').test(l));
    if (i === -1) return '';
    const value = lines[i].replace(new RegExp(`^\\s*[#*]*\\s*${word}\\s*[*]*\\s*:\\s*`, 'i'), '').replace(/\*+/g, '').trim();
    lines.splice(i, 1);
    return value;
  };
  const record = {
    key: period.key,
    thread: thread.id,
    kind: period.kind,
    from: period.from,
    to: period.to,
    title: take('titre'),
    mood: take('ambiance'),
    text: lines.join('\n').trim(),
    sig: sigOf(period.convs),
    count: period.convs.filter(isSummarized).length,
    by: state.llm.model,
    updatedAt: Date.now(),
  };
  await put('chapters', record);
  state.chapters.set(record.key, record);
}

function chaptersView(kind) {
  const list = periods(kind);
  const todo = list.filter((p) => ['none', 'stale'].includes(chapterStatus(p)));
  const written = list.filter((p) => state.chapters.has(p.key)).length;
  const stale = list.filter((p) => chapterStatus(p) === 'stale').length;
  const actions = [];
  if (state.llm?.url && todo.length && !state.batch) {
    actions.push(el('button', { type: 'button', class: 'pill accent small', onclick: () => runJobs(todo, writeChapter, t('batchChapters'), 'nChapterWritten') }, icon('spark'), t('writeN', plural(todo.length, 'nChapter'))));
  }
  const out = [head(t(kind === 'month' ? 'months' : 'weeks'), `${plural(written, kind === 'month' ? 'chHaveMonth' : 'chHaveWeek', num(list.length))}${stale ? t('chStale', num(stale)) : ''}${t('chFromSummaries')}`, ...actions)];
  if (!list.length) return [...out, el('p', { class: 'edge', text: t('noConvHere') })];
  const empty = list.filter((p) => chapterStatus(p) === 'empty').length;
  for (const p of [...list].reverse()) {
    if (chapterStatus(p) === 'empty') continue;
    const rec = state.chapters.get(p.key);
    const status = chapterStatus(p);
    const missing = p.convs.filter((c) => !isSummarized(c) && textCount(c) >= MIN_TEXTS).length;
    const redo =
      state.llm?.url && status !== 'empty' && !state.batch
        ? el('button', { type: 'button', class: 'pill small', onclick: (event) => chapterOne(p, event.currentTarget) }, t(rec ? 'redo' : 'writeChapter'))
        : null;
    out.push(
      el(
        'section',
        { class: `summary chapter${status === 'stale' ? ' stale' : ''}` },
        el(
          'div',
          { class: 'chead' },
          el('button', { type: 'button', class: 'when', title: t('seePeriodConvs'), onclick: () => openPeriod(p) }, p.label),
          el('span', { class: 'muted', text: ` · ${plural(p.convs.length, 'nConv')}${missing ? plural(missing, 'nOfWhichNotSummarized') : ''}${status === 'stale' ? t('chSummariesChanged') : ''}` }),
          el('span', { class: 'grow' }),
          redo,
        ),
        rec?.title && el('h4', { text: rec.title }),
        rec?.mood && el('p', { class: 'mood', text: rec.mood }),
        rec ? el('p', { dir: 'auto', text: rec.text }) : el('p', { class: 'muted', text: t(status === 'empty' ? 'summarizeFirst' : 'notWrittenYet') }),
      ),
    );
  }
  if (empty) out.push(el('p', { class: 'edge', text: plural(empty, kind === 'month' ? 'nMonth' : 'nWeek') + t('chEmptyTail') }));
  return out;
}

async function chapterOne(period, button) {
  if (button) button.disabled = true;
  try {
    await writeChapter(period);
    renderMain();
  } catch (e) {
    if (button) button.disabled = false;
    showNotice(t('chapterFailed', e.message), 'error');
  }
}

function openPeriod(period) {
  state.resView = 'convs';
  state.filter = { ...state.filter, from: period.from, to: period.to };
  renderSide();
  renderMain();
}

/* ---------- À retenir, people and places (one pass per month) ---------- */

function memoryStatus(period) {
  if (!period.convs.some(isSummarized)) return 'empty';
  const rec = state.memory.get(period.key);
  if (!rec) return 'none';
  return rec.sig === sigOf(period.convs) ? 'ok' : 'stale';
}

function knownEntities() {
  const map = new Map();
  for (const rec of state.memory.values()) for (const e of rec.entities) if (!map.has(tagKey(e.name))) map.set(tagKey(e.name), e.name);
  return [...map.values()];
}

async function extractMemory(period, signal) {
  const thread = state.thread;
  const me = firstName(thread.me);
  const others = thread.participants.filter((p) => p !== thread.me).map(firstName);
  const known = knownEntities();
  const answer = await chat(
    [
      {
        role: 'system',
        content: [
          llmIntro(),
          t('mPrompt1'),
          t('mFactLine'),
          t('mTypes', FACT_TYPES.map(([, , what, , word]) => `${word} (${what})`).join(', ')),
          t('mWhen'),
          t('mText'),
          t('mThen'),
          t('mEntityLine'),
          t('mNotAdd', me, others.join(t('mNor'))) + (known.length ? t('mKnown', known.slice(0, 80).join(', ')) : ''),
          t('mNothing'),
        ].join('\n'),
      },
      { role: 'user', content: t('mUser', period.label, summaryList(period.convs, true)) },
    ],
    signal,
  );
  if (state.thread !== thread) return;
  const facts = [];
  const entities = [];
  const convOf = (n) => state.convs[Number(n) - 1];
  // The French word or the one of the interface language, both accepted.
  const kindOf = (list, cell, wordAt) => list.find((kind) => [kind[0], kind[wordAt]].some((w) => tagKey(cell).startsWith(tagKey(w).slice(0, 4))))?.[0];
  for (const line of answer.split('\n')) {
    const cells = line.replace(/\*+/g, '').split('|').map((c) => c.trim());
    const kind = tagKey(cells[0] || '');
    if ((kind === 'fait' || kind === 'fact') && cells.length >= 5) {
      const conv = convOf((cells[1].match(/\d+/) || [])[0]);
      const type = kindOf(FACT_TYPES, cells[2], 4) || 'fait';
      const text = cells.slice(4).join(' | ').trim();
      if (!text) continue;
      facts.push({ id: hash(`${type}\u0001${tagKey(text)}`), type, when: cells[3] === '-' ? '' : cells[3], text, ts: conv?.from ?? period.from });
    } else if ((kind === 'entite' || kind === 'entity') && cells.length >= 4) {
      const name = cells[2].replace(/^[«"]|[»"]$/g, '').trim();
      if (!name || others.some((o) => tagKey(o) === tagKey(name)) || tagKey(name) === tagKey(me)) continue;
      const refs = [...(cells[4] || '').matchAll(/\d+/g)].map((m) => convOf(m[0])?.from).filter(Number.isFinite);
      const type = kindOf(ENTITY_KINDS, cells[1], 2) || 'autre';
      entities.push({ name, kind: type, about: cells[3] || '', ts: refs });
    }
  }
  const record = { key: period.key, thread: thread.id, month: period.from, facts, entities, sig: sigOf(period.convs), by: state.llm.model, updatedAt: Date.now() };
  await put('memory', record);
  state.memory.set(record.key, record);
}

async function saveFactsDone() {
  await put('prefs', { k: `facts|${state.thread.id}`, done: Object.fromEntries(state.factsDone) });
}

function memoryActions(list) {
  const todo = list.filter((p) => ['none', 'stale'].includes(memoryStatus(p)));
  if (!state.llm?.url || !todo.length || state.batch) return [];
  return [el('button', { type: 'button', class: 'pill accent small', onclick: () => runJobs(todo, extractMemory, t('batchMemory'), 'nMonthRead') }, icon('spark'), t('readN', plural(todo.length, 'nMonth')))];
}

function memoryNote(list) {
  const read = list.filter((p) => state.memory.has(p.key)).length;
  const stale = list.filter((p) => memoryStatus(p) === 'stale').length;
  return `${t('mNote', num(read), num(list.length))}${stale ? t('mStale', num(stale)) : ''}${t('mFrom')}`;
}

function factsView() {
  const months = periods('month');
  const f = state.filter;
  const facts = [];
  for (const p of months) for (const fact of state.memory.get(p.key)?.facts || []) if ((f.from == null || fact.ts >= f.from) && (f.to == null || fact.ts <= f.to)) facts.push(fact);
  const counts = new Map();
  for (const fact of facts) if (!state.factsDone.has(fact.id)) counts.set(fact.type, (counts.get(fact.type) || 0) + 1);
  const type = state.factType || 'all';
  const shown = facts.filter((x) => (type === 'all' || x.type === type) && (state.showDone || !state.factsDone.has(x.id))).sort((a, b) => a.ts - b.ts);
  const out = [head(t('toRemember'), memoryNote(months), ...memoryActions(months))];
  out.push(
    el(
      'div',
      { class: 'toolbar' },
      el('button', { type: 'button', class: `chip${type === 'all' ? ' on' : ''}`, text: t('fEverything'), onclick: () => ((state.factType = 'all'), renderMain()) }),
      FACT_TYPES.map(([k, label]) => el('button', { type: 'button', class: `chip fact-${k}${type === k ? ' on' : ''}`, onclick: () => ((state.factType = k), renderMain()) }, label, counts.get(k) ? el('span', { class: 'n', text: ` ${num(counts.get(k))}` }) : null)),
      el('span', { class: 'grow' }),
      switchControl(t('showSettled'), !!state.showDone, () => ((state.showDone = !state.showDone), renderMain())),
    ),
  );
  if (!facts.length) {
    out.push(el('p', { class: 'edge', text: t(state.memory.size ? 'nothingToRemember' : 'clickRead') }));
    return out;
  }
  let month = '';
  for (const fact of shown) {
    const m = cap(fmt.month.format(fact.ts));
    if (m !== month) {
      month = m;
      out.push(el('h3', { class: 'group', text: m }));
    }
    const done = state.factsDone.has(fact.id);
    const conv = convAt(fact.ts);
    out.push(
      el(
        'div',
        { class: `fact${done ? ' done' : ''}` },
        el(
          'button',
          {
            type: 'button',
            class: 'check',
            role: 'checkbox',
            'aria-checked': String(done),
            title: t(done ? 'markUndone' : 'markSettled'),
            onclick: async () => {
              if (done) state.factsDone.delete(fact.id);
              else state.factsDone.set(fact.id, Date.now());
              await saveFactsDone();
              renderMain();
            },
          },
          done && icon('check'),
        ),
        el(
          'div',
          { class: 'ftext' },
          el('span', { class: `ftype fact-${fact.type}`, text: FACT_TYPES.find(([k]) => k === fact.type)?.[3] || fact.type }),
          el('span', { dir: 'auto', text: fact.text }),
          fact.when && el('span', { class: 'muted', text: ` · ${fact.when}` }),
        ),
        el('button', { type: 'button', class: 'convlink', text: `${cap(fmt.dayMid.format(conv.from))} ${fmt.time.format(conv.from)}`, title: t('openConvTitle'), onclick: () => ((state.mode = 'resume'), openConv(conv.index)) }),
      ),
    );
  }
  if (!shown.length) out.push(el('p', { class: 'edge', text: t('allSettled') }));
  return out;
}

function entityIndex() {
  const f = state.filter;
  const map = new Map();
  for (const rec of state.memory.values()) {
    for (const e of rec.entities) {
      const ts = e.ts.filter((t) => (f.from == null || t >= f.from) && (f.to == null || t <= f.to));
      if (!ts.length && (f.from != null || f.to != null)) continue;
      const key = tagKey(e.name);
      if (!map.has(key)) map.set(key, { name: e.name, kind: e.kind, about: e.about, ts: new Set(), names: new Map(), last: 0 });
      const item = map.get(key);
      for (const t of ts) item.ts.add(t);
      item.names.set(e.name, (item.names.get(e.name) || 0) + 1);
      if (rec.month >= item.last && e.about) {
        item.about = e.about;
        item.last = rec.month;
      }
    }
  }
  for (const item of map.values()) item.name = [...item.names].sort((a, b) => b[1] - a[1])[0][0];
  return [...map.values()];
}

function indexView() {
  const months = periods('month');
  const items = entityIndex();
  const out = [head(t('peoplePlaces'), `${plural(items.length, 'nName')} · ${memoryNote(months)}`, ...memoryActions(months))];
  if (!items.length) {
    out.push(el('p', { class: 'edge', text: t('clickReadIndex') }));
    return out;
  }
  for (const [kind, label] of ENTITY_KINDS) {
    const list = items.filter((i) => i.kind === kind).sort((a, b) => b.ts.size - a.ts.size || a.name.localeCompare(b.name, LANG));
    if (!list.length) continue;
    out.push(
      el('h3', { class: 'group', text: label }),
      el(
        'div',
        { class: 'panel entities' },
        list.map((item) =>
          el(
            'div',
            { class: 'entity' },
            el(
              'div',
              { class: 'ehead' },
              el('button', { type: 'button', class: 'ename', text: item.name, title: t('searchName'), onclick: () => searchFor(item.name) }),
              el('span', { class: 'muted', text: ` · ${plural(item.ts.size, 'nConv')}` }),
            ),
            item.about && el('p', { class: 'muted', text: item.about }),
            el(
              'div',
              { class: 'tagrow' },
              [...item.ts]
                .sort((a, b) => a - b)
                .slice(-8)
                .map((ts) => {
                  const conv = convAt(ts);
                  return el('button', { type: 'button', class: 'convlink', text: `${cap(fmt.dayMid.format(conv.from))}`, title: state.summary.get(conv.index)?.title || convLabel(conv), onclick: () => ((state.mode = 'resume'), openConv(conv.index)) });
                }),
            ),
          ),
        ),
      ),
    );
  }
  return out;
}

function searchFor(text) {
  setQuery(text);
  state.searchLimit = 60;
  renderSide();
  renderMain();
  $('#main').scrollTop = 0;
}

/* ---------- Questions asked ---------- */

async function saveAsk(question, text, scope) {
  const record = { key: `${state.thread.id}|${hash(question.trim().toLowerCase())}`, thread: state.thread.id, query: question.trim(), text, scope, at: Date.now() };
  await put('asks', record);
  state.asks.set(record.key, record);
  return record;
}

const savedAsk = (question) => state.asks.get(`${state.thread.id}|${hash(question.trim().toLowerCase())}`);

function asksView() {
  const list = [...state.asks.values()].sort((a, b) => b.at - a.at);
  const out = [head(t('questions'), plural(list.length, 'nQuestionAsked') + t('asksKept'))];
  if (!list.length) {
    out.push(el('p', { class: 'edge', text: t('asksEmpty') }));
    return out;
  }
  for (const ask of list) {
    out.push(
      el(
        'section',
        { class: 'summary askitem' },
        el(
          'div',
          { class: 'chead' },
          el('button', { type: 'button', class: 'when', text: ask.query, title: t('seeSearchAgain'), onclick: () => searchFor(ask.query) }),
          el('span', { class: 'muted', text: `${t('askedOn', fmt.date.format(ask.at))}${ask.scope ? ` · ${plural(ask.scope, 'nSummaryRead')}` : ''}` }),
          el('span', { class: 'grow' }),
          el(
            'button',
            {
              type: 'button',
              class: 'reset',
              title: t('forgetQuestion'),
              'aria-label': t('forgetQuestion'),
              onclick: async () => {
                await remove('asks', ask.key);
                state.asks.delete(ask.key);
                renderMain();
              },
            },
            icon('close'),
          ),
        ),
        el('p', { class: 'answer', dir: 'auto' }, renderAnswer(ask)),
      ),
    );
  }
  return out;
}

/* ---------- The "Résumés" tab and its sub-views ---------- */

function resumesView() {
  const view = state.resView || 'convs';
  const content =
    view === 'weeks' ? chaptersView('week') : view === 'months' ? chaptersView('month') : view === 'facts' ? factsView() : view === 'index' ? indexView() : view === 'asks' ? asksView() : notesView();
  const nav = el(
    'div',
    { class: 'resnav' },
    el(
      'nav',
      { class: 'segmented' },
      RES_VIEWS.map(([k, label, ic]) =>
        el(
          'button',
          {
            type: 'button',
            class: view === k ? 'on' : null,
            onclick: () => {
              state.resView = k;
              renderMain();
              $('#main').scrollTop = 0;
            },
          },
          icon(ic),
          label,
        ),
      ),
    ),
    el('button', { type: 'button', class: `pill small${state.exportOpen ? ' on' : ''}`, onclick: () => ((state.exportOpen = !state.exportOpen), renderMain()) }, icon('save'), t('exportBtn')),
  );
  return [content[0], nav, state.exportOpen && exportPanel(), ...content.slice(1)];
}

/* ---------- Mood band under the timeline ---------- */

// Each ambiance tag keeps its colour everywhere: see moodSlot in home.js.

function moodBand(start, end, pct) {
  const ambiance = new Set(state.tags.filter((t) => t.kind === 'ambiance').map((t) => t.name));
  if (!ambiance.size) return null;
  const inView = state.convs.filter((c) => c.to >= start && c.from <= end && isSummarized(c));
  const totals = new Map();
  for (const c of inView) for (const t of convTags(c)) if (ambiance.has(t)) totals.set(t, (totals.get(t) || 0) + 1);
  const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  if (!top.length) return null;
  // Buckets: a week when the frise shows months, a day when zoomed in.
  const daily = end - start < 60 * 864e5;
  const bucketOf = (ts) => {
    if (daily) {
      const d = new Date(ts);
      const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      return { from, to: from + 864e5 - 1, label: cap(fmt.dayMid.format(from)) };
    }
    return periodOf('week', ts);
  };
  const buckets = new Map();
  for (const c of inView) {
    const b = bucketOf(c.from);
    if (!buckets.has(b.from)) buckets.set(b.from, { ...b, total: 0, tags: new Map() });
    const bucket = buckets.get(b.from);
    bucket.total++;
    for (const t of convTags(c)) bucket.tags.set(t, (bucket.tags.get(t) || 0) + 1);
  }
  return el(
    'div',
    { class: 'mood-band' },
    top.map((tag, row) =>
      el(
        'div',
        { class: 'moodrow' },
        [...buckets.values()]
          .filter((b) => b.tags.get(tag))
          .map((b) => {
            const n = b.tags.get(tag);
            return el('button', {
              type: 'button',
              class: 'mcell',
              style: `left:${pct(b.from)};width:calc(${pct(b.to)} - ${pct(b.from)});background:var(--m${moodSlot(tag)});opacity:${(0.25 + 0.75 * (n / b.total)).toFixed(2)}`,
              title: `${b.label} · ${t('moodCell', tag, plural(n, 'nConv'), num(b.total))}`,
              onclick: () => {
                state.resView = 'convs';
                state.filter = { ...state.filter, tags: [tag], from: b.from, to: b.to };
                showView('resumes');
              },
            });
          }),
        el('span', { class: 'mlabel', text: tag }),
      ),
    ),
  );
}
