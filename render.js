'use strict';
// Fil: Sidebar, conversation view, messages, search results.

/* ---------- Rendering ---------- */

function render() {
  if (state.screen !== 'thread') return renderHome();
  document.body.classList.remove('home');
  renderSide();
  renderMain();
}

function renderSide() {
  if (state.screen !== 'thread') return;
  const thread = state.thread;
  $('#title').replaceChildren(thread ? platformBadge(thread.platform) : '', ` ${thread ? titleOf(thread) : 'Fil'}`);
  const backPerson = state.back !== 'home' && state.people.get(state.back);
  $('#home-label').textContent = backPerson ? backPerson.name : t('home');
  $('#span').textContent = thread ? `${plural(thread.messages.length, 'nMessage')} · ${spanText(thread)}` : t('noConvImported');
  const chips = $('#threads');
  chips.hidden = true;
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
    if (state.working.has(conv.id)) flags.append(el('span', { class: 'spinner', title: t('inProgress') }));
    else if (status === 'stale') flags.append(el('span', { class: 'dot stale', title: t('staleDot') }));
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
  if (!convs.length && state.thread) items.push(el('li', { class: 'none' }, t('noConvFilters')));
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
  if (state.screen !== 'thread') return renderHome();
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
    el('h2', { text: t('importTitle') }),
    el('p', { text: t('importHow') }),
    el('p', { text: t('importLocal') }),
    el('button', { type: 'button', class: 'pill accent', onclick: () => $('#file').click() }, icon('import'), t('chooseFile')),
  );
}

function head(title, meta, ...actions) {
  return el('div', { class: 'head' }, el('div', { class: 'titles' }, el('h2', { text: title }), meta && el('p', { text: meta })), ...actions);
}

function summarizeButton(conv) {
  const busy = state.working.has(conv.id);
  const status = noteStatus(conv);
  if (!state.llm?.url) {
    const copy = el('button', { type: 'button', class: 'pill accent small summarize', title: t('copyForLlmTitle') }, icon('copy'), t('copyForLlm'));
    copy.addEventListener('click', () => copyText(`${systemPrompt()}\n\n${userPrompt(conv)}`, copy, t('copied')));
    return copy;
  }
  const button = el(
    'button',
    { type: 'button', class: 'pill accent small summarize', disabled: busy },
    busy ? el('span', { class: 'spinner light' }) : icon('spark'),
    t(busy ? 'summarizing' : status === 'none' ? 'summarize' : status === 'grouped' ? 'redoAsOne' : 'redoSummary'),
  );
  button.addEventListener('click', () => summarizeOne(conv, button));
  return button;
}

function convHead(conv) {
  const [prev, next] = neighbours(conv);
  const before = state.convs[conv.index - 1];
  const count = convCount(conv);
  const length = conv.to - conv.from < 60e3 ? t('aMoment') : duration(conv.to - conv.from);
  const silence = before ? t('afterSilence', duration(conv.from - before.to)) : t('firstOfExport');
  const title = state.summary.get(conv.index)?.title || '';
  return head(
    title || convLabel(conv),
    `${title ? `${convLabel(conv)} · ` : ''}${plural(count, 'nMessage')} · ${length} · ${silence}`,
    el('button', { type: 'button', class: 'icon-btn', title: t('prevConv'), disabled: !prev, onclick: () => prev && openConv(prev.index) }, icon('prev')),
    el('button', { type: 'button', class: 'icon-btn', title: t('nextConv'), disabled: !next, onclick: () => next && openConv(next.index) }, icon('next')),
    before && el('button', { type: 'button', class: 'icon-btn', title: t('mergePrev'), onclick: () => setCut(conv.id, 'merge') }, icon('merge')),
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
    modeButton('resume', t(has ? 'summary' : 'summaryNotYet'), 'doc'),
    modeButton('messages', t('messagesCount', num(messages.length)), 'bubble'),
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
    startsRange && el('p', { class: 'edge', text: t('exportStart', fmt.date.format(conv.from)) }),
    el('div', { class: 'messages' }, messageRows(messages)),
    endsRange && el('p', { class: 'edge', text: t('exportEnd', fmt.full.format(conv.to)) }),
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
    el('p', { text: t(short ? 'veryShort' : 'noSummaryYet') }),
    el(
      'div',
      { class: 'actions' },
      action,
      el('button', { type: 'button', class: 'pill', text: t('seeMessages'), onclick: () => setMode('messages') }),
      el('button', {
        type: 'button',
        class: 'pill',
        text: t('writeMyself'),
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
  const title = el('input', { class: 'ntitle', type: 'text', placeholder: t('titlePlaceholder'), spellcheck: 'false' });
  const area = el('textarea', {
    rows: 2,
    placeholder: state.llm?.url
      ? t('pointsWithLlm')
      : t('pointsNoLlm'),
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
        saved.textContent = t('saved');
        renderTimeline();
      } catch (e) {
        showNotice(t('summarySaveFailed', e.message), 'error');
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
  if (status === 'stale') info = t('staleInfo');
  else if (sum?.kind === 'parts')
    info = t('partsInfo', sum.parts.length, sum.leftOut ? ` (${plural(sum.leftOut, 'nShortNotSummarized')})` : '');
  else if (sum?.kind === 'around') info = t('aroundInfo');
  else if (sum?.own?.by) info = t('byOn', sum.own.by, fmt.date.format(sum.own.updatedAt));
  return el(
    'div',
    { class: `card${status === 'stale' ? ' stale' : ''}${status === 'grouped' ? ' grouped' : ''}` },
    el('div', { class: 'label' }, t('summary'), info && el('span', { class: 'muted', text: info }), saved),
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
    else if (prev && m.ts - prev.ts > GAP_TIME) rows.push(el('p', { class: 'sep', text: t('laterBy', fmt.time.format(m.ts), duration(m.ts - prev.ts)) }));
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
  if (m.unsent || m.type === 'placeholder') return [el('span', { class: 'ghost' }, icon('undo'), t('messageRemoved'))];
  if (isMedia(m)) {
    const total = count > 1 ? count : Math.max(1, m.media);
    return [el('span', { class: 'ghost', title: t('mediaMissing') }, icon('photo'), total > 1 ? t('mediaMany', total) : t('mediaOne'))];
  }
  if (m.type === 'link' && !m.text) return [el('span', { class: 'ghost' }, icon('link'), t('linkShared'))];
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
  const star = el('button', { type: 'button', class: 'star', title: t(starred ? 'unstar' : 'star') }, icon('star'));
  star.addEventListener('click', () => toggleStar(m.id, row));
  const reactions = [...new Set(group.flatMap((g) => g.react.map((r) => r[1])))];
  const row = el(
    'div',
    { class: `msg${mine ? ' mine' : ''}${first ? ' first' : ''}${starred ? ' starred' : ''}` },
    el(
      'div',
      { class: 'bwrap' },
      state.thread.kind === 'group' && !mine && first && el('span', { class: `who ${personClass(m.from)}`, text: shortName(displayName(state.thread.platform, m.from)) }),
      el('div', { class: 'bubble', dir: 'auto', title: fmt.full.format(m.ts) }, messageContent(m, group.length)),
      reactions.length > 0 && el('span', { class: 'react', text: reactions.join(' ') }),
    ),
    el(
      'div',
      { class: 'tools' },
      star,
      canCut && el('button', { type: 'button', class: 'star cut', title: t('cutHere'), onclick: () => setCut(m.id, 'split') }, icon('scissors')),
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
    return showNotice(t('starFailed', e.message), 'error');
  }
  if (row) {
    const on = state.stars.has(id);
    row.classList.toggle('starred', on);
    row.querySelector('.star').title = t(on ? 'unstar' : 'star');
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
    el('span', { class: 'meta' }, el('span', { text: fmt.time.format(m.ts) }), el('b', { class: mine ? 'me' : null, text: shortName(m.from) })),
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
  ['score', t('sRelevance')],
  ['new', t('sNewest')],
  ['old', t('sOldest')],
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
    `${plural(results.length, 'nConv')}${totalMessages ? ` · ${plural(totalMessages, 'nMessage')}` : t('foundBySummaries')}` +
    (inFilter ? t('inFiltered', filterSummary()) : '');

  const out = [
    head(t('quoted', state.query.trim()), meta),
    askCard(),
    el(
      'div',
      { class: 'toolbar' },
      chip(t('allPeople'), !state.who, () => ((state.who = null), renderMain())),
      ...thread.participants.map((p) => chip(p === thread.me ? t('me', firstName(p)) : firstName(p), state.who === p, () => ((state.who = p), renderMain()))),
      el('span', { class: 'sepdot' }),
      ...SEARCH_SORTS.map(([k, label]) => chip(label, (state.searchSort || 'score') === k, () => ((state.searchSort = k), renderMain()))),
      el('span', { class: 'grow' }),
      switchControl(t('exactSpelling'), state.exact, () => {
        state.exact = !state.exact;
        renderMain();
      }, t('exactHint')),
    ),
    el('p', { class: 'hint', text: t('searchHint') }),
  ];
  if (!results.length) {
    out.push(el('p', { class: 'edge', text: t(needles.length ? 'noMatchAll' : 'typeWord') }));
    return out;
  }
  for (const r of shown) out.push(resultCard(r, query));
  if (results.length > shown.length) {
    out.push(
      el('button', {
        type: 'button',
        class: 'pill more',
        text: t('showMore', num(Math.min(60, results.length - shown.length)), num(results.length - shown.length)),
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
      el('span', { class: 'muted', text: r.messages.length ? ` · ${plural(r.messages.length, 'nMessageFound')}` : t('foundBySummary') }),
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
    if (lines.length) card.append(el('p', { class: 'sumhit', dir: 'auto' }, el('span', { class: 'muted', text: t('summaryColon') }), highlightAll(lines.slice(0, 2).join(' '), query)));
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
    card.append(el('button', { type: 'button', class: 'inline small', text: t('moreInConv', plural(r.messages.length - shown.length, 'nOtherMessage')), onclick: () => openConv(conv.index, messages[r.messages.find((i) => !shown.includes(i))].id) }));
  }
  return card;
}

const messageText = (m) => (m.unsent || m.type === 'placeholder' ? t('tMessageRemoved') : isMedia(m) ? t('tMedia') : m.type === 'link' && !m.text ? t('tLink') : m.text);

