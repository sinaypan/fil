'use strict';
// Fil: The timeline.

/* ---------- Timeline (frise) ---------- */

const SPANS = [
  [182, t('span6m')],
  [365, t('span1y')],
  [730, t('span2y')],
  [0, t('spanAll')],
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
    ? t('friseHintZoom')
    : t('friseHint');
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
        text: t('zoomChip', fmt.dayMonth.format(start), fmt.dayMonth.format(end)),
        title: t('backFullView'),
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
    el('span', {}, el('i', { class: 'k ok' }), t('kSummarized')),
    el('span', {}, el('i', { class: 'k grouped' }), t('kGrouped')),
    el('span', {}, el('i', { class: 'k none' }), t('kNotSummarized')),
    el('span', {}, el('i', { class: 'k stale' }), t('kToRedo')),
    el('span', {}, el('i', { class: 'k missing' }), t('kNotImported')),
  );
  const add = el('button', { type: 'button', class: 'pill accent small', onclick: () => $('#file').click() }, icon('import'), t('addExport'));

  return [
    head(
      t('timeline'),
      t('friseSub', spanText(thread), plural(Math.round(coveredDays), 'nDay'), num(summarized), num(state.convs.length)),
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
      marks.push([d.getTime(), d.getHours() === 0 ? fmt.dayMid.format(d) : t('hourMark', d.getHours())]);
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
      el('span', { class: 'muted', text: ` · ${plural(convCount(conv), 'nMessage')}` }),
      sum?.title ? el('span', { text: ` · ${sum.title}` }) : el('span', { class: 'muted', text: t('notSummarizedYet') }),
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
    actions.push(el('button', { type: 'button', class: 'pill accent', onclick: () => runBatch(convs) }, icon('spark'), todo.length > 1 ? t('summarizeTheseConvs', num(todo.length)) : t('summarizeThisConv')));
  } else if (todo.length && !state.llm?.url) {
    actions.push(el('button', { type: 'button', class: 'pill accent', text: t('setUpLlmToSummarize'), onclick: () => showView('reglages') }));
  }
  actions.push(
    el('button', {
      type: 'button',
      class: 'pill',
      text: t('filterPeriod'),
      title: t('filterPeriodTitle'),
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
      text: t('zoomPeriod'),
      onclick: () => {
        const margin = (to - from) * 0.05;
        state.zoom = { from: from - margin, to: to + margin };
        renderMain();
      },
    }),
  );
  if (convs.length) actions.push(el('button', { type: 'button', class: 'pill', text: t('openFirst'), onclick: () => openConv(convs[0].index) }));
  actions.push(
    el('button', {
      type: 'button',
      class: 'pill',
      text: t('clearSelection'),
      onclick: () => {
        state.sel = null;
        renderMain();
      },
    }),
  );
  const details = convs.length
    ? t('selDetails', plural(convs.length, 'nConv'), num(done), num(todo.length), other > 0 ? `, ${plural(other, 'nTooShortOrRedo')}` : '')
    : t('noConvPeriod');
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
        el('span', { class: `what${sum?.title ? '' : ' muted'}`, text: sum?.title || t(textCount(c) < MIN_TEXTS ? 'veryShortWord' : 'notSummarizedWord') }),
        el('span', { class: 'count', text: num(convCount(c)) }),
      );
    }),
  );
  return el(
    'div',
    { class: 'panel' },
    el('p', { class: 'flabel', text: t('fromToFull', fmt.full.format(from), fmt.full.format(to)) }),
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
  const where = [before && t('wBefore', num(before)), after && t('wAfter', num(after)), between && t('wGap', num(between))].filter(Boolean);
  const lines = [
    t('fileSpans', fmt.full.format(plan.from), fmt.full.format(plan.to), plural(plan.messages.length, 'nMessage')),
    plan.fresh.length
      ? t('toAdd', plural(plan.fresh.length, 'nMessage'), where.length ? ` (${where.join(', ')})` : '')
      : t('nothingNew'),
    plan.dup ? t('alreadyThere', num(plan.dup)) : '',
    plan.conflict
      ? t('ignoredDiff', plural(plan.conflict, 'nMessage'))
      : '',
  ].filter(Boolean);
  const cancel = el('button', {
    type: 'button',
    class: 'pill',
    text: t(plan.fresh.length ? 'cancel' : 'close'),
    onclick: () => {
      state.pending = null;
      renderMain();
    },
  });
  return el(
    'div',
    { class: 'panel pending-card' },
    el('p', { class: 'flabel', text: t('newExport', plan.file) }),
    lines.map((t) => el('p', { text: t })),
    el(
      'div',
      { class: 'actions' },
      plan.fresh.length > 0 && el('button', { type: 'button', class: 'pill accent', onclick: confirmImport }, icon('check'), t('addN', plural(plan.fresh.length, 'nMessage'))),
      cancel,
    ),
  );
}

function importsList(thread) {
  if (!thread.imports?.length) return null;
  return el(
    'div',
    {},
    el('h3', { class: 'group', text: t('importedExports') }),
    el(
      'div',
      { class: 'panel imports' },
      [...thread.imports].reverse().map((i) =>
        el(
          'div',
          { class: 'import' },
          el('span', { class: 'iname', text: i.file || t('exportWord') }),
          el('span', {
            class: 'muted',
            text: t('importLine', fmt.date.format(i.from), fmt.date.format(i.to), plural(i.added, 'nMessageAdded'), i.ignored ? t('ignoredTail', num(i.ignored)) : '', fmt.date.format(i.at)),
          }),
        ),
      ),
    ),
  );
}

