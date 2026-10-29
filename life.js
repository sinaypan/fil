'use strict';
// Fil: "Ma vie". One page per month across every conversation, written by the
// LLM from what is already summarised: the month chapter of a conversation
// when there is one, its summaries otherwise. Nothing else is sent.

function lifeMonths() {
  const months = new Map();
  const chapters = state.home.chapters || [];
  for (const n of state.home.notes) {
    const t = state.threads.find((x) => x.id === n.thread);
    if (!t) continue;
    const m = periodOf('month', n.from);
    if (!months.has(m.from)) months.set(m.from, { ...m, key: `life|${m.from}`, threads: new Map() });
    const month = months.get(m.from);
    if (!month.threads.has(t.id)) month.threads.set(t.id, { thread: t, notes: [], chapter: null });
    month.threads.get(t.id).notes.push(n);
  }
  for (const c of chapters) {
    if (c.kind !== 'month') continue;
    const month = months.get(c.from);
    const item = month?.threads.get(c.thread);
    if (item) item.chapter = c;
  }
  return [...months.values()].sort((a, b) => b.from - a.from);
}

function lifeInput(month) {
  const blocks = [];
  for (const { thread, notes, chapter } of [...month.threads.values()].sort((a, b) => b.notes.length - a.notes.length)) {
    const who = `${t(thread.kind === 'group' ? 'lfGroup' : 'lfWith', titleOf(thread))} (${platformOf(thread.platform).name})`;
    if (chapter) {
      blocks.push(`### ${who}\n${chapter.title}${chapter.mood ? ` · ${chapter.mood}` : ''}\n${chapter.text}`);
    } else {
      // Summaries made with another cut overlap: keep the largest ones that do not.
      const parts = pickParts(notes).slice(0, 25);
      blocks.push(`### ${who}\n${parts.map((n) => `${fmt.dayMonth.format(n.from)}${n.title ? ` · ${n.title}` : ''}\n${n.text.trim()}`).join('\n')}`);
    }
  }
  return blocks.join('\n\n');
}

async function writeLife(month, signal) {
  const input = lifeInput(month);
  const me = state.people.get('me')?.name || t('meName');
  const text = await chat(
    [
      {
        role: 'system',
        content: [
          t('lfPrompt1', firstName(me)),
          t('lfLanguages', LANG_NAME),
          t('lfFormat'),
          t('lfTitle'),
          t('lfMood'),
          '- <point>',
          t('lfPoints'),
        ].join('\n'),
      },
      { role: 'user', content: t('mUser', month.label, input) },
    ],
    signal,
  );
  const lines = text.trim().split('\n');
  const take = (word) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s*[#*]*\\s*${word}\\s*[*]*\\s*:`, 'i').test(l));
    if (i === -1) return '';
    const value = lines[i].replace(new RegExp(`^\\s*[#*]*\\s*${word}\\s*[*]*\\s*:\\s*`, 'i'), '').replace(/\*+/g, '').trim();
    lines.splice(i, 1);
    return value;
  };
  const record = { k: month.key, month: month.from, title: take('titre'), mood: take('ambiance'), text: lines.join('\n').trim(), sig: hash(input), threads: [...month.threads.keys()], by: state.llm.model, at: Date.now() };
  await put('prefs', record);
  state.life.set(month.key, record);
}

function lifeStatus(month) {
  const rec = state.life.get(month.key);
  if (!rec) return 'none';
  return rec.sig === hash(lifeInput(month)) ? 'ok' : 'stale';
}

function lifeView() {
  if (!state.home) return el('p', { class: 'edge', text: t('loading') });
  const months = lifeMonths();
  const todo = months.filter((m) => lifeStatus(m) !== 'ok');
  const written = months.filter((m) => state.life.has(m.key)).length;
  const chars = todo.reduce((s, m) => s + lifeInput(m).length, 0);
  const out = [
    el(
      'div',
      { class: 'toolbar' },
      el('p', { class: 'muted', text: t('lfNote', num(written), num(months.length)) }),
      el('span', { class: 'grow' }),
      state.llm?.url && todo.length > 0 && !state.batch && el('button', { type: 'button', class: 'pill accent small', title: t('aboutTokensSent', num(Math.round(chars / 3.2 / 1000) * 1000)), onclick: () => runJobs(todo, writeLife, t('htLife'), 'nMonthWritten') }, icon('spark'), t('writeN', plural(todo.length, 'nMonth'))),
    ),
  ];
  if (!months.length) {
    out.push(el('p', { class: 'edge', text: t('lfNeedSummaries') }));
    return out;
  }
  if (!state.llm?.url) out.push(el('p', { class: 'hint', text: t('lfNeedLlm') }));
  for (const month of months) {
    const rec = state.life.get(month.key);
    const status = lifeStatus(month);
    const threads = [...month.threads.values()].map((x) => x.thread);
    out.push(
      el(
        'section',
        { class: `summary chapter life${status === 'stale' ? ' stale' : ''}` },
        el('div', { class: 'chead' }, el('b', { class: 'when', text: month.label }), el('span', { class: 'muted', text: ` · ${plural(threads.length, 'nConv')}${status === 'stale' ? t('lfStale') : ''}` }), el('span', { class: 'grow' }), state.llm?.url && !state.batch && el('button', { type: 'button', class: 'pill small', text: t(rec ? 'redo' : 'lfWriteMonth'), onclick: (e) => lifeOne(month, e.currentTarget) })),
        rec?.title && el('h4', { text: rec.title }),
        rec?.mood && el('p', { class: 'mood', text: rec.mood }),
        rec ? el('p', { dir: 'auto', text: rec.text }) : el('p', { class: 'muted', text: t('notWrittenYet') }),
        el(
          'div',
          { class: 'tagrow' },
          threads
            .sort((a, b) => (month.threads.get(b.id).notes.length || 0) - (month.threads.get(a.id).notes.length || 0))
            .slice(0, 10)
            .map((t) => el('button', { type: 'button', class: 'chip lifechip', onclick: () => openThread(t.id, { back: 'home', conv: month.from }) }, platformBadge(t.platform), ` ${titleOf(t)}`)),
        ),
      ),
    );
  }
  return out;
}

async function lifeOne(month, button) {
  if (button) button.disabled = true;
  try {
    await writeLife(month);
    render();
  } catch (e) {
    if (button) button.disabled = false;
    showNotice(t('lfFailed', e.message), 'error');
  }
}
