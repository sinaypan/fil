'use strict';
// Fil: Questions answered from the summaries.

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
    return el('p', { class: 'hint', text: t(state.llm?.url ? 'askNeedSummaries' : 'askNeedLlm') });
  }
  const chars = scope.reduce((sum, c) => {
    const s = state.summary.get(c.index);
    return sum + s.text.length + s.title.length + 60;
  }, 0);
  const card = el('section', { class: 'ask' });
  const button = el(
    'button',
    { type: 'button', class: 'pill accent small', disabled: state.asking, title: t('aboutTokens', num(Math.round(chars / 3.2 / 1000) * 1000)) },
    state.asking ? el('span', { class: 'spinner light' }) : icon('spark'),
    t(state.asking ? 'filSearching' : answer ? 'askAgain' : 'askFil'),
  );
  button.addEventListener('click', () => askFil(q));
  card.append(
    el(
      'div',
      { class: 'askhead' },
      el('div', {}, el('b', { text: t('askFil') }), el('p', { class: 'muted', text: t('askExplain', q, plural(scope.length, 'nSummary'), filterActive() ? t('filteredParen') : '') })),
      button,
    ),
  );
  if (answer) {
    card.append(el('div', { class: 'answer', dir: 'auto' }, renderAnswer(answer)));
    if (answer.at) card.append(el('p', { class: 'muted small', text: t('answerKept', fmt.full.format(answer.at)) }));
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
          t('qHelp', me, others),
          t('qOnly'),
          t('qAnswer', LANG_NAME),
          t('qNotFound'),
        ].join('\n'),
      },
      { role: 'user', content: t('qUser', list, question) },
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
    showNotice(t('askFailed', e.message), 'error');
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
      head(t('favorites')),
      el('p', { class: 'edge', text: t('noFavorites') }),
    ];
  }
  return [head(t('favorites'), plural(list.length, 'nMessageKept')), ...grouped(list, (m) => hit(m, messageContent(m)))];
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
          { type: 'button', class: 'pill accent small', title: t('aboutTokensTotal', num(Math.round(chars / 3.2 / 1000) * 1000)), onclick: () => runBatch(scope) },
          icon('spark'),
          t(filtered ? 'summarizeTheseLeft' : 'summarizeTheLeft', num(todo.length)),
        ),
      );
    }
    if (untagged.length) {
      actions.push(el('button', { type: 'button', class: 'pill small', onclick: () => runBatch(scope, 'tags') }, icon('spark'), t('tagN', num(untagged.length))));
    }
  }
  const copyAll = el('button', { type: 'button', class: 'pill small', disabled: !summarized.length }, icon('copy'), t('copyAll'));
  copyAll.addEventListener('click', () => copyText(allNotes(summarized), copyAll, t('copied')));
  actions.push(copyAll);

  const meta =
    t('summarizedOf', plural(summarized.length, 'nConvSummarized'), num(scope.length)) +
    (filtered ? t('filteredWith', filterSummary()) : '') +
    (stale ? ` · ${plural(stale, 'nToRedo')}` : '') +
    t('savedNeverAsked');
  const out = [head(t('summaries'), meta, ...actions)];
  if (!state.llm?.url) {
    out.push(
      el(
        'p',
        { class: 'edge' },
        t('toSummarizeAll'),
        el('button', { type: 'button', class: 'inline', text: t('setUpLlm'), onclick: () => showView('reglages') }),
        '.',
      ),
    );
  }
  if (!summarized.length) {
    out.push(el('p', { class: 'edge', text: t(filtered ? 'noSummaryFiltered' : 'noSummaryYetAll') }));
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
          el('span', { class: 'muted', text: ` · ${plural(convCount(conv), 'nMessage')}` }),
          stale && el('span', { class: 'muted', text: t('toRedoTail') }),
          sum.kind === 'parts' && el('span', { class: 'muted', text: t('groupedTail', sum.parts.length) }),
        ),
        sum.title && el('h4', { text: sum.title }),
        sum.tags.length > 0 && el('div', { class: 'tagrow' }, sum.tags.map((t) => tagChip(t))),
        el('p', { dir: 'auto', text: sum.text.trim() }),
      ),
    );
  }
  return out;
}

