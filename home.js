'use strict';
// Fil: the home screen (people, groups, sources, graph, "Ma vie") and the page of a person.

const HOME_TABS = [
  ['people', t('enPeople'), 'person'],
  ['groups', t('htGroups'), 'bubble'],
  ['life', t('htLife'), 'doc'],
  ['graph', t('htGraph'), 'graph'],
  ['sources', t('htSources'), 'import'],
];

/* ---------- Data for the home screen (no messages loaded) ---------- */

async function loadHomeData() {
  const [notes, memory, prefs, chapters] = await Promise.all([getAll('notes'), getAll('memory'), getAll('prefs'), getAll('chapters')]);
  const kinds = new Map();
  const done = new Map();
  for (const r of prefs) {
    if (typeof r.k !== 'string') continue;
    if (r.k.startsWith('tags|')) kinds.set(r.k.slice(5), new Map((r.list || []).map((t) => [t.name, t.kind])));
    if (r.k.startsWith('facts|')) done.set(r.k.slice(6), new Set(Object.keys(r.done || {})));
  }
  const byThread = new Map();
  const entry = (id) => {
    if (!byThread.has(id)) byThread.set(id, { moods: new Map(), topics: new Map(), notes: 0, facts: [], entities: [] });
    return byThread.get(id);
  };
  for (const n of notes) {
    const e = entry(n.thread);
    e.notes++;
    const k = kinds.get(n.thread);
    for (const t of n.tags || []) {
      const map = k?.get(t) === 'ambiance' ? e.moods : e.topics;
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  for (const r of memory) {
    const e = entry(r.thread);
    const d = done.get(r.thread);
    for (const f of r.facts || []) if (!d?.has(f.id)) e.facts.push({ ...f, thread: r.thread });
    for (const x of r.entities || []) e.entities.push({ ...x, thread: r.thread });
  }
  state.home = { byThread, notes, memory, chapters };
}

const homeOf = (threadId) => state.home?.byThread.get(threadId) || { moods: new Map(), topics: new Map(), notes: 0, facts: [], entities: [] };

function sumMaps(maps) {
  const out = new Map();
  for (const m of maps) for (const [k, v] of m) out.set(k, (out.get(k) || 0) + v);
  return out;
}

/* ---------- Colours of moods: one per mood, the same everywhere ---------- */

function moodSlot(tag) {
  state.moodSlots ||= new Map();
  if (!state.moodSlots.has(tag)) {
    state.moodSlots.set(tag, (state.moodSlots.size % 6) + 1);
    put('prefs', { k: 'moods', slots: Object.fromEntries(state.moodSlots) }).catch(() => {});
  }
  return state.moodSlots.get(tag);
}

function moodBar(moods) {
  const list = [...moods].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = list.reduce((s, [, n]) => s + n, 0);
  if (!total) return el('div', { class: 'moodline nomood', title: t('noMoodYet') });
  return el(
    'div',
    { class: 'moodline', title: list.map(([tag, n]) => `${tag} ${percent(n / total)}`).join(' · ') },
    list.map(([t, n]) => el('span', { class: `seg m${moodSlot(t)}`, style: `flex:${n}` })),
  );
}

function avatar(name, big) {
  const words = String(name || '?').trim().split(/\s+/);
  const letters = (words[0][0] || '?') + (words[1]?.[0] || '');
  const hue = parseInt(hash(tagKey(name || '?')), 36) % 360;
  return el('span', { class: `avatar${big ? ' big' : ''}`, style: `--h:${hue}`, text: letters.toUpperCase() });
}

const lastLabel = (ts) => (ts ? t('lastExchange', fmt.date.format(ts)) : t('noMessageShort'));

/* ---------- Navigation ---------- */

async function goHome(tab) {
  if (tab) state.homeTab = tab;
  state.screen = 'home';
  state.person = null;
  await loadHomeData();
  render();
  $('#main').scrollTop = 0;
}

// From the home cards, someone with a single conversation opens it straight away;
// from the graph (direct: false), it is always their page.
function openPerson(id, { direct = true } = {}) {
  const person = state.people.get(id);
  if (!person) return;
  const { duos, groups } = threadsOf(person);
  if (direct && duos.length === 1 && !groups.length) return openThread(duos[0].id, { back: 'home' });
  state.screen = 'person';
  state.person = id;
  render();
  $('#main').scrollTop = 0;
}

// conv: a moment of the thread to open; find: a name to look for in that
// conversation, to land on the message that says it.
async function openThread(id, { back = 'home', at = null, conv = null, find = null } = {}) {
  state.back = back;
  const meta = state.threads.find((t) => t.id === id);
  if (!meta) return;
  await selectThread(meta, at);
  if (conv == null) return;
  const c = convAt(conv);
  const hit = find && findInConv(c, find);
  if (hit) {
    state.mode = 'messages';
    return openConv(c.index, hit);
  }
  openConv(c.index);
}

// The first message of a conversation that says this name (or its longest word).
function findInConv(conv, name) {
  const words = [name, ...String(name).split(/\s+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)];
  for (const word of words) {
    const t = { exact: fold(word, false).s.trim(), loose: fold(word, true).s.trim() };
    if (!t.exact) continue;
    if (t.loose.replace(/ /g, '').length < 2) t.loose = '';
    const m = convMessages(conv).find((x) => x.text && matchLevel(fold(x.text, false).s, fold(x.text, true).s, t));
    if (m) return m.id;
  }
  return null;
}

function goBack() {
  if (state.back && state.back !== 'home' && state.people.has(state.back)) {
    state.screen = 'person';
    state.person = state.back;
    loadHomeData().then(render);
  } else goHome();
}

/* ---------- The home screen ---------- */

function renderHome() {
  document.body.classList.add('home');
  state.nodes = new Map();
  const view = $('#view');
  const parts = state.screen === 'person' ? personPage() : homeView();
  view.replaceChildren(...parts.flat(3).filter((x) => x != null && x !== false));
  renderBatch();
}

function homeHead() {
  const tab = state.homeTab || 'people';
  const fileButton = el('button', { type: 'button', class: 'pill accent small', onclick: () => $('#file').click() }, icon('import'), t('import'));
  const folderButton = el('button', { type: 'button', class: 'pill small', title: t('folderTitle'), onclick: () => $('#folder').click() }, t('aFolder'));
  return el(
    'header',
    { class: 'homehead' },
    el('div', { class: 'brand' }, el('img', { src: 'icons/icon32.png', alt: '' }), el('b', { text: 'Fil' })),
    el(
      'nav',
      { class: 'segmented' },
      HOME_TABS.map(([k, label, ic]) =>
        el(
          'button',
          {
            type: 'button',
            class: tab === k ? 'on' : null,
            onclick: () => {
              state.homeTab = k;
              render();
              $('#main').scrollTop = 0;
            },
          },
          icon(ic),
          label,
        ),
      ),
    ),
    el('span', { class: 'grow' }),
    fileButton,
    folderButton,
    el('button', { type: 'button', class: 'icon-btn', title: t('backupAll'), 'aria-label': t('backup'), disabled: !state.threads.length, onclick: backup }, icon('save')),
    el('button', { type: 'button', class: `icon-btn${tab === 'settings' ? ' on' : ''}`, title: t('settings'), 'aria-label': t('settings'), onclick: () => ((state.homeTab = 'settings'), render()) }, icon('sliders')),
  );
}

function homeView() {
  const tab = state.homeTab || 'people';
  const out = [homeHead(), el('div', { id: 'home-batch', class: 'batchbox', hidden: true }), pendingCards()];
  if (!state.threads.length && !['sources', 'settings'].includes(tab)) {
    out.push(
      el(
        'div',
        { class: 'empty' },
        el('span', { class: 'glyph' }, icon('bubble')),
        el('h2', { text: t('importYours') }),
        el('p', { text: t('importYoursHint') }),
        el('button', { type: 'button', class: 'pill accent', onclick: () => ((state.homeTab = 'sources'), render()) }, t('seeHowExport')),
      ),
    );
    return out;
  }
  if (tab === 'groups') out.push(groupsView());
  else if (tab === 'sources') out.push(sourcesView());
  else if (tab === 'graph') out.push(graphView());
  else if (tab === 'life') out.push(lifeView());
  else if (tab === 'settings') out.push(settingsView());
  else out.push(peopleView());
  return out;
}

/* ---------- Waiting imports: whose export is it, which platform ---------- */

function pendingCards() {
  if (!state.pendingImports.length) return null;
  return state.pendingImports.slice(0, 3).map((pending, index) => {
    const head = el('p', {}, el('b', { text: pending.source }), el('span', { class: 'muted', text: ` · ${plural(pending.messages.length, 'nMessage')} · ${pending.participants.slice(0, 6).join(', ')}${pending.participants.length > 6 ? '…' : ''}` }));
    let question;
    if (pending.platforms.length > 1) {
      question = [el('p', { text: t('whichPlatform') }), el('div', { class: 'chips' }, pending.platforms.map((p) => el('button', { type: 'button', class: 'chip', onclick: () => answerPending(index, { platform: p }) }, platformBadge(p), ` ${platformOf(p).name}`)))];
    } else {
      question = [
        el('p', { text: t('whichName', platformOf(pending.platform).name) }),
        el('div', { class: 'chips' }, pending.participants.slice(0, 30).map((n) => el('button', { type: 'button', class: 'chip', text: n, onclick: () => answerPending(index, { me: n }) }))),
      ];
    }
    return el(
      'section',
      { class: 'panel pending-card' },
      head,
      question,
      el('button', {
        type: 'button',
        class: 'inline small',
        text: t('dontImport'),
        onclick: () => {
          state.pendingImports.splice(index, 1);
          render();
        },
      }),
    );
  });
}

/* ---------- People ---------- */

function personStats(person) {
  const { duos, groups } = threadsOf(person);
  const all = [...duos, ...groups];
  const last = Math.max(0, ...all.map((t) => t.last || 0)) || null;
  const exchanged = duos.reduce((s, t) => s + t.count, 0);
  const moods = sumMaps(duos.map((t) => homeOf(t.id).moods));
  const facts = duos.reduce((s, t) => s + homeOf(t.id).facts.length, 0);
  const platforms = [...new Set(all.map((t) => t.platform))];
  return { duos, groups, last, exchanged, moods, facts, platforms, written: messagesOf(person, all) };
}

function peopleView() {
  const q = tagKey(state.homeQuery || '');
  const pf = state.homePlatform || 'all';
  const sort = state.homeSort || 'recent';
  let list = [...state.people.values()]
    .filter((p) => !p.me)
    .map((p) => ({ p, s: personStats(p) }))
    .filter(({ s }) => s.duos.length + s.groups.length > 0);
  const platforms = [...new Set(state.threads.map((t) => t.platform))];
  if (pf !== 'all') list = list.filter(({ s }) => s.platforms.includes(pf));
  if (q) list = list.filter(({ p }) => tagKey(p.name).includes(q));
  const showGroupsOnly = state.homeGroupsToo;
  if (!showGroupsOnly) list = list.filter(({ s }) => s.duos.length > 0);
  list.sort(sort === 'name' ? (a, b) => a.p.name.localeCompare(b.p.name, LANG) : sort === 'volume' ? (a, b) => b.s.exchanged - a.s.exchanged : (a, b) => (b.s.last || 0) - (a.s.last || 0));

  const search = el('input', { type: 'text', class: 'homesearch', placeholder: t('searchPerson'), spellcheck: 'false' });
  search.value = state.homeQuery || '';
  let timer = 0;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.homeQuery = search.value;
      render();
      const again = document.querySelector('.homesearch');
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    }, 200);
  });
  const chip = (label, on, onclick, extra) => el('button', { type: 'button', class: `chip${on ? ' on' : ''}`, onclick }, extra, label);
  return [
    el(
      'div',
      { class: 'toolbar homebar' },
      search,
      chip(t('fAll'), pf === 'all', () => ((state.homePlatform = 'all'), render())),
      platforms.length > 1 && platforms.map((p) => chip(` ${platformOf(p).name}`, pf === p, () => ((state.homePlatform = p), render()), platformBadge(p))),
      el('span', { class: 'grow' }),
      chip(t('recent'), sort === 'recent', () => ((state.homeSort = 'recent'), render())),
      chip(t('mostExchanges'), sort === 'volume', () => ((state.homeSort = 'volume'), render())),
      chip('A → Z', sort === 'name', () => ((state.homeSort = 'name'), render())),
      switchControl(t('groupsToo'), !!showGroupsOnly, () => ((state.homeGroupsToo = !state.homeGroupsToo), render()), t('groupsTooTip')),
    ),
    suggestionCard(),
    list.length ? el('div', { class: 'cards' }, list.map(({ p, s }) => personCard(p, s))) : el('p', { class: 'edge', text: t('nobodyMatches') }),
  ];
}

function personCard(person, s) {
  return el(
    'button',
    { type: 'button', class: 'homecard', onclick: () => openPerson(person.id) },
    el('div', { class: 'hc-top' }, avatar(person.name), el('div', { class: 'hc-name' }, el('b', { text: person.name }), el('span', { class: 'badges' }, s.platforms.map((p) => platformBadge(p))))),
    el('p', { class: 'muted small', text: `${s.duos.length ? plural(s.exchanged, 'nMsgDuo') : plural(s.written, 'nMsgGroup')} · ${lastLabel(s.last)}` }),
    moodBar(s.moods),
    el(
      'p',
      { class: 'hc-foot' },
      s.facts > 0 && el('span', { class: 'flag', text: t('toRememberN', num(s.facts)) }),
      s.groups.length > 0 && el('span', { class: 'muted', text: t('inGroups', plural(s.groups.length, 'nGroup')) }),
    ),
  );
}

function suggestionCard() {
  if (!state.suggestionList) {
    suggestions().then((list) => {
      state.suggestionList = list;
      if (list.length && state.screen === 'home' && (state.homeTab || 'people') === 'people') render();
    });
    return null;
  }
  const list = state.suggestionList.filter((s) => state.people.has(s.a.id) && state.people.has(s.b.id) && !state.suggestionsOff?.has(s.pair));
  if (!list.length) return null;
  return el(
    'section',
    { class: 'panel suggest' },
    el('p', {}, el('b', { text: t('samePerson') }), el('span', { class: 'muted', text: t('samePersonHint') })),
    list.slice(0, 4).map(({ a, b, pair }) =>
      el(
        'div',
        { class: 'suggestrow' },
        avatar(a.name),
        el('span', {}, el('b', { text: a.name }), ' ', a.ids.map((id) => platformBadge(identityPlatform(id)))),
        el('span', { class: 'muted', text: t('and') }),
        avatar(b.name),
        el('span', {}, el('b', { text: b.name }), ' ', b.ids.map((id) => platformBadge(identityPlatform(id)))),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'pill small accent', text: t('link'), onclick: () => linkPeople(a, b).then(() => (state.suggestionList = null)) }),
        el('button', { type: 'button', class: 'pill small', text: t('no'), onclick: () => dismissSuggestion(pair) }),
      ),
    ),
  );
}

/* ---------- Groups ---------- */

function groupsView() {
  const groups = state.threads.filter((t) => t.kind === 'group').sort((a, b) => (b.last || 0) - (a.last || 0));
  if (!groups.length) return el('p', { class: 'edge', text: t('noGroups') });
  return el('div', { class: 'cards' }, groups.map((t) => groupCard(t)));
}

function groupCard(thread, person) {
  const h = homeOf(thread.id);
  const members = thread.participants.filter((n) => n !== thread.me);
  const theirs = person ? messagesOf(person, [thread]) : 0;
  return el(
    'button',
    { type: 'button', class: 'homecard', onclick: () => openThread(thread.id, { back: person ? person.id : 'home' }) },
    el('div', { class: 'hc-top' }, avatar(thread.title || members[0]), el('div', { class: 'hc-name' }, el('b', { text: titleOf(thread) }), el('span', { class: 'badges' }, platformBadge(thread.platform)))),
    el('p', { class: 'muted small', text: members.length ? t('kv', plural(members.length + 1, 'nMember'), `${members.slice(0, 4).map((n) => firstName(displayName(thread.platform, n))).join(', ')}${members.length > 4 ? '…' : ''}`) : t('onlyYours', platformOf(thread.platform).name) }),
    el('p', { class: 'muted small', text: `${plural(thread.count, 'nMessage')}${person ? t('ofWhichFrom', num(theirs), firstName(person.name)) : ''} · ${lastLabel(thread.last)}` }),
    moodBar(h.moods),
  );
}

/* ---------- Sources ---------- */

function sourcesView() {
  return [
    el('p', { class: 'hint', text: t('sourcesHint') }),
    el(
      'div',
      { class: 'cards sources' },
      PLATFORMS.map((p) => {
        const count = state.threads.filter((t) => t.platform === p.id).length;
        return el(
          'section',
          { class: `homecard source${p.ready ? '' : ' later'}` },
          el('div', { class: 'hc-top' }, platformBadge(p.id), el('div', { class: 'hc-name' }, el('b', { text: p.name }), el('span', { class: 'muted small', text: p.ready ? (count ? plural(count, 'nConvImported') : t('available')) : t('comingSoon') }))),
          p.steps && el('ol', { class: 'steps' }, p.steps.map((s) => el('li', { text: s }))),
          p.note && el('p', { class: 'muted small', text: p.note }),
        );
      }),
    ),
  ];
}

/* ---------- The page of a person ---------- */

function personPage() {
  const person = state.people.get(state.person);
  if (!person) return [homeHead(), el('p', { class: 'edge', text: t('personGone') })];
  const s = personStats(person);
  const nameButton = el('button', { type: 'button', class: 'pname', title: t('rename'), text: person.name });
  nameButton.addEventListener('click', () => {
    const input = el('input', { type: 'text', class: 'pname-input', spellcheck: 'false' });
    input.value = person.name;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') renamePerson(person, input.value);
      if (e.key === 'Escape') render();
    });
    input.addEventListener('blur', () => renamePerson(person, input.value));
    nameButton.replaceWith(input);
    input.focus();
    input.select();
  });
  const others = [...state.people.values()].filter((p) => !p.me && p.id !== person.id).sort((a, b) => a.name.localeCompare(b.name, LANG));
  const linker = state.linking
    ? el(
        'div',
        { class: 'panel' },
        el('p', { text: t('linkTo', person.name) }),
        el('div', { class: 'chips' }, others.slice(0, 60).map((o) => el('button', { type: 'button', class: 'chip', onclick: () => ((state.linking = false), linkPeople(person, o)) }, o.name, ' ', o.ids.map((id) => platformBadge(identityPlatform(id)))))),
        el('button', { type: 'button', class: 'inline small', text: t('cancel'), onclick: () => ((state.linking = false), render()) }),
      )
    : null;
  const facts = s.duos.flatMap((t) => homeOf(t.id).facts.map((f) => ({ ...f, t }))).sort((a, b) => b.ts - a.ts);
  const mentions = mentionsOf(person);
  const topics = [...sumMaps(s.duos.map((t) => homeOf(t.id).topics))].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return [
    homeHead(),
    el('button', { type: 'button', class: 'backlink', onclick: () => goHome() }, icon('prev'), (HOME_TABS.find(([k]) => k === (state.homeTab || 'people')) || HOME_TABS[0])[1]),
    el(
      'header',
      { class: 'personhead' },
      avatar(person.name, true),
      el('div', {}, nameButton, el('p', { class: 'muted', text: `${s.duos.length ? `${plural(s.exchanged, 'nMsgDuo')} · ` : ''}${lastLabel(s.last)}` }), el('div', { class: 'badges' }, s.platforms.map((p) => platformBadge(p, true)))),
      el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'pill small', text: t('linkOther'), onclick: () => ((state.linking = true), render()) }),
    ),
    linker,
    person.ids.length > 1 &&
      el(
        'div',
        { class: 'chips idents' },
        person.ids.map((id) => el('span', { class: 'chip' }, platformBadge(identityPlatform(id)), ` ${identityName(id)} `, el('button', { type: 'button', class: 'inline small', text: t('detach'), onclick: () => unlinkIdentity(person, id) }))),
      ),
    el('h3', { class: 'group', text: t('moodTopics') }),
    !s.moods.size && !topics.length
      ? el('p', { class: 'muted', text: t('noMoodTopics') })
      : el('div', { class: 'panel' }, moodBar(s.moods), el('div', { class: 'tagrow' }, [...s.moods].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => el('span', { class: 'tag ambiance', text: `${t} ${n}` })), topics.map(([t, n]) => el('span', { class: 'tag sujet', text: `${t} ${n}` })))),
    s.duos.length > 0 && [el('h3', { class: 'group', text: t('yourConvs') }), el('div', { class: 'cards' }, s.duos.map((t) => duoCard(t, person)))],
    s.groups.length > 0 && [el('h3', { class: 'group', text: t('commonGroups') }), el('div', { class: 'cards' }, s.groups.map((t) => groupCard(t, person)))],
    facts.length > 0 && [
      el('h3', { class: 'group', text: t('toRemember') }),
      el(
        'div',
        { class: 'panel factlist' },
        facts.slice(0, 12).map((f) =>
          el(
            'button',
            { type: 'button', class: 'factline', onclick: () => openThread(f.t.id, { back: person.id, conv: f.ts }) },
            el('span', { class: `ftype fact-${f.type}`, text: FACT_TYPES.find(([k]) => k === f.type)?.[3] || f.type }),
            el('span', { text: f.text }),
            f.when && el('span', { class: 'muted', text: ` · ${f.when}` }),
            el('span', { class: 'grow' }),
            platformBadge(f.t.platform),
          ),
        ),
      ),
    ],
    mentions.length > 0 && [
      el('h3', { class: 'group', text: t('citedElsewhere') }),
      el('div', { class: 'panel factlist' }, mentions.map((m) => el('button', { type: 'button', class: 'factline', onclick: () => openThread(m.thread.id, { back: person.id, conv: m.ts, find: person.name }) }, el('b', { text: titleOf(m.thread) }), el('span', { class: 'muted', text: ` · ${m.about || t('cited')} · ${plural(m.count, 'nConv')}` }), el('span', { class: 'grow' }), platformBadge(m.thread.platform)))),
    ],
  ];
}

function duoCard(thread, person) {
  const h = homeOf(thread.id);
  return el(
    'button',
    { type: 'button', class: 'homecard', onclick: () => openThread(thread.id, { back: person.id }) },
    el('div', { class: 'hc-top' }, platformBadge(thread.platform, true)),
    el('p', { class: 'muted small', text: `${plural(thread.count, 'nMessage')} · ${t('exFromTo', thread.first ? fmt.date.format(thread.first) : '?', thread.last ? fmt.date.format(thread.last) : '?')}` }),
    el('p', { class: 'muted small', text: `${plural(h.notes, 'nSummary')}${h.facts.length ? ` · ${t('toRememberN', num(h.facts.length))}` : ''}` }),
    moodBar(h.moods),
  );
}

// Where this person is talked about: people named like them in the memory of other threads.
function mentionsOf(person) {
  const keys = new Set([tagKey(person.name), ...person.ids.map((id) => tagKey(identityName(id)))]);
  const own = new Set([...threadsOf(person).duos].map((t) => t.id));
  const out = new Map();
  for (const t of state.threads) {
    if (own.has(t.id)) continue;
    for (const e of homeOf(t.id).entities) {
      if (e.kind !== 'personne' || !keys.has(tagKey(e.name))) continue;
      const item = out.get(t.id) || { thread: t, about: e.about, count: 0, ts: e.ts?.[0] ?? t.last };
      item.count += e.ts?.length || 1;
      out.set(t.id, item);
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}
