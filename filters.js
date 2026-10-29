'use strict';
// Fil: Filters, sorting and the filter card.

/* ---------- Filters and sorting ---------- */

const NO_FILTER = { from: null, to: null, tags: [], any: false, status: 'all', min: 0, sort: 'old' };
const STATUSES = [
  ['all', t('fAll')],
  ['ok', t('fSummarized')],
  ['none', t('fNotSummarized')],
  ['stale', t('fToRedo')],
  ['untagged', t('fNoTags')],
  ['star', t('fWithFavorites')],
];
const SIZES = [
  [0, t('fAll')],
  [10, '10+'],
  [50, '50+'],
  [200, '200+'],
];
const SORTS = [
  ['old', t('fOldest')],
  ['new', t('fNewest')],
  ['messages', t('fMostMessages')],
  ['duration', t('fLongest')],
  ['silence', t('fLongestSilence')],
  ['stars', t('fMostFavorites')],
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
  if (f.tags.length) parts.push(f.tags.join(f.any ? t('fOr') : ' + '));
  if (f.status !== 'all') parts.push(STATUSES.find(([k]) => k === f.status)[1].toLowerCase());
  if (f.min) parts.push(t('fMinMessages', f.min));
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
      t(active ? 'fFiltered' : 'fFilterSort'),
    ),
    el('span', { class: 'fsum', text: [active ? filterSummary() : '', sortName].filter(Boolean).join(' · ') || plural(count, 'nConv') }),
    active &&
      el('button', { type: 'button', class: 'reset', title: t('fRemove'), 'aria-label': t('fRemove'), onclick: () => setFilter({ ...NO_FILTER, sort: state.filter.sort }) }, icon('close')),
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
    [t('fEverything'), null, null],
    [t('fLast7'), startOfDay(now) - 6 * day, null],
    [t('fLast30'), startOfDay(now) - 29 * day, null],
    [t('fThisMonth'), new Date(now.getFullYear(), now.getMonth(), 1).getTime(), null],
    [t('fLastMonth'), new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1],
  ];
  if (state.sel) quick.push([t('fTimelineSelection'), state.sel.from, state.sel.to]);
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
      el('span', { text: value != null ? fmt.date.format(value) : t('fNotChosen') }),
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
    el('div', { class: 'fhead' }, el('b', { text: plural(count, 'nConv') }), el('button', { type: 'button', class: 'pill small', text: t('fResetAll'), onclick: () => setFilter({ ...NO_FILTER }) }), el('button', { type: 'button', class: 'reset', 'aria-label': t('close'), onclick: toggleFilterCard }, icon('close'))),
    el('h4', { text: t('fPeriod') }),
    el('div', { class: 'chips' }, quick.map(([label, from, to]) => el('button', { type: 'button', class: `chip${f.from === from && f.to === to ? ' on' : ''}`, text: label, onclick: () => setFilter({ from, to }) }))),
    el('div', { class: 'dates' }, dateButton('from', t('fFrom'), f.from), dateButton('to', t('fTo'), f.to)),
    state.calendar && calendar(state.calendar === 'from' ? f.from : f.to),
    el('h4', {}, t('fTags'), el('button', { type: 'button', class: 'inline small', text: t('fManageTags'), onclick: () => { toggleFilterCard(); showView('tags'); } })),
    tagGroups.length
      ? [
          f.tags.length > 1 && chipRow([[false, t('fAllTags')], [true, t('fAnyTag')]], f.any, (any) => setFilter({ any })),
          tagGroups,
        ]
      : el('p', { class: 'muted small', text: t('fNoTagsYet') }),
    el('h4', { text: t('fStatus') }),
    chipRow(STATUSES, f.status, (status) => setFilter({ status })),
    el('h4', { text: t('fSize') }),
    chipRow(SIZES, f.min, (min) => setFilter({ min })),
    el('h4', { text: t('fSort') }),
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
  const grid = el('div', { class: 'calgrid' }, weekdays('narrow').map((d) => el('span', { class: 'wd', text: d })));
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
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': t('prevMonth'), onclick: () => step(-1) }, icon('prev')),
      el('b', { text: cap(fmt.month.format(month)) }),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': t('nextMonth'), onclick: () => step(1) }, icon('next')),
    ),
    grid,
    el('button', {
      type: 'button',
      class: 'inline small',
      text: t(which === 'from' ? 'fNoStart' : 'fNoEnd'),
      onclick: () => {
        state.calendar = null;
        setFilter({ [which]: null });
      },
    }),
  );
}

