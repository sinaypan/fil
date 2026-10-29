'use strict';
// Fil: the "Analyse" tab. Numbers worked out here from the messages (who
// writes what, when, how fast, in which language), the mood over time from
// the ambiance tags, and a descriptive portrait of both people written by the
// LLM from the summaries: habits that can be observed, never a diagnosis.

const REPLY_MAX = 6 * 3600e3; // a reply later than this is not counted as a reply time
const SAMPLE_PER_PERSON = 40; // messages of each person sent with the summaries for the portrait

const LANGS = [
  ['darja', t('lgDarja')],
  ['fr', t('lgFrench')],
  ['en', t('lgEnglish')],
  ['mix', t('lgMixed')],
  ['short', t('lgShort')],
  ['other', t('lgOther')],
];
const words = (list) => new Set(list.split(' '));
const FR_WORDS = words(
  "je tu il elle on nous vous ils elles pas est c'est cest que qui le la les un une des du de et mais oui non ça ca moi toi bien trop très tres pour avec dans sur ce cette quoi comment pourquoi quand aussi encore déjà deja fait faire suis es sont ai as vais va merci bonne bon demain soir rien tout peux veux sais alors donc parce mdr jsp t'es tes ton ta mon ma mes d'accord daccord accord t'as fais faut combien attention envoie parfait trop vraiment juste après apres avant toujours jamais peut-être peut être était etait aujourd'hui maintenant",
);
const EN_WORDS = words("the you i and is to what are it my your so but yes love good night really just know think don't dont im i'm its it's this that with for have too wanna gonna miss sorry thanks thank sure maybe please why how when where we they me no not here same worries all see get got go did do can will would could there then now call later exactly i'll i'm you're don't can't what's");
const DZ_WORDS = words(
  'rani rak raki rah raha rahi raho wesh wech wsh kifach kifah wach bezzaf bzaf hadi hada hadik hadak ana nta nti ntia ntiya mazal khlas khalas kayen kayn makach makanch chwiya chouia ghodwa ghadwa lyoum lyom wallah inchallah nchallah hamdoullah hamdolah dok dorka drk bghit nheb nhabek habibi habibti sahbi saha sahit yaatik walou walo yaani nroh nrouh nji tji ndir dir kima mlih yak yek hna temma tema rabi khoya khti kho bark berk sma3 smahli smahlili nchouf chouf kach chi bach besah bessah goul gouli nkra dar mouchkil ghir kifkif sahbti hbibti yallah zid ndiro nsit wlh ki',
);

function langOf(text) {
  const tokens = text.toLowerCase().match(/[\p{L}\d']+/gu) || [];
  let fr = 0;
  let en = 0;
  let dz = 0;
  for (const t of tokens) {
    if (DZ_WORDS.has(t) || (/\p{L}/u.test(t) && /[235789]/.test(t) && /^[\p{L}\d]+$/u.test(t))) dz++;
    else if (FR_WORDS.has(t) || /[éèêàùçœâîôû]/.test(t)) fr++;
    else if (EN_WORDS.has(t)) en++;
  }
  const found = [dz && 'darja', fr && 'fr', en && 'en'].filter(Boolean);
  if (found.length > 1) return 'mix';
  if (found.length) return found[0];
  // Nothing recognised: a laugh, an "ok", an emoji... or a sentence in words the lists do not know.
  return tokens.filter((t) => !/^(h+|x+d*|a*h+a+h*|ok+|okay|mdr+|lol+|wa+|ah+|oh+|eh+|mm+|ya+)$/.test(t)).length <= 2 ? 'short' : 'other';
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const median = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function analyse(convs) {
  const thread = state.thread;
  const people = [thread.me, ...thread.participants.filter((p) => p !== thread.me)];
  const blank = () => ({ messages: 0, words: 0, media: 0, links: 0, unsent: 0, questions: 0, night: 0, starts: 0, relaunch: 0, reactsGiven: 0, replies: [], emojis: new Map(), langs: new Map() });
  const by = new Map(people.map((p) => [p, blank()]));
  const hours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => new Map()));
  const weeks = new Map();
  const messages = thread.messages;
  for (const conv of convs) {
    const starter = by.get(messages[conv.start].from);
    if (starter) {
      starter.starts++;
      if (conv.index && conv.from - state.convs[conv.index - 1].to > 24 * 3600e3) starter.relaunch++;
    }
    for (let i = conv.start; i < conv.end; i++) {
      const m = messages[i];
      const s = by.get(m.from);
      if (!s) continue;
      s.messages++;
      const d = new Date(m.ts);
      const cell = hours[(d.getDay() + 6) % 7][d.getHours()];
      cell.set(m.from, (cell.get(m.from) || 0) + 1);
      const week = periodOf('week', m.ts).from;
      if (!weeks.has(week)) weeks.set(week, new Map());
      weeks.get(week).set(m.from, (weeks.get(week).get(m.from) || 0) + 1);
      if (d.getHours() < 5) s.night++;
      if (m.unsent || m.type === 'placeholder') s.unsent++;
      else if (isMedia(m)) s.media++;
      else if (m.type === 'link' || /https?:\/\//.test(m.text)) s.links++;
      if (m.text && m.type === 'text' && !m.unsent) {
        s.words += (m.text.match(/[\p{L}\d']+/gu) || []).length;
        if (/\?\s*$/.test(m.text)) s.questions++;
        for (const e of m.text.match(EMOJI) || []) s.emojis.set(e, (s.emojis.get(e) || 0) + 1);
        const lang = langOf(m.text);
        s.langs.set(lang, (s.langs.get(lang) || 0) + 1);
      }
      for (const [actor] of m.react) by.get(actor) && by.get(actor).reactsGiven++;
      const prev = i > conv.start ? messages[i - 1] : null;
      if (prev && prev.from !== m.from && m.ts - prev.ts < REPLY_MAX) s.replies.push(m.ts - prev.ts);
    }
  }
  return { people, by, hours, weeks, convs };
}

/* ---------- Charts (plain HTML, a readout line under each one for the hover) ---------- */

function withReadout(chart, hint) {
  const readout = el('p', { class: 'readout muted', text: hint });
  chart.addEventListener('pointerover', (event) => {
    const tip = event.target.closest('[data-tip]')?.dataset.tip;
    readout.textContent = tip || hint;
    readout.classList.toggle('muted', !tip);
  });
  chart.addEventListener('pointerleave', () => {
    readout.textContent = hint;
    readout.classList.add('muted');
  });
  return [chart, readout];
}

// You keep the accent colour; in a duo the other person is teal; in a group each member
// gets a categorical slot in the order of the participants (after five, grey).
const GROUP_SLOTS = ['m2', 'm1', 'm3', 'm5', 'm6'];
function personClass(p) {
  const thread = state.thread;
  if (p === thread.me) return 'p-me';
  if (thread.kind !== 'group') return 'p-other';
  const i = thread.participants.filter((x) => x !== thread.me).indexOf(p);
  return i >= 0 && i < GROUP_SLOTS.length ? `p-${GROUP_SLOTS[i]}` : 'p-rest';
}

function legend(items) {
  return el(
    'div',
    { class: 'legend' },
    items.map(([cls, label]) => el('span', {}, el('i', { class: `k ${cls}` }), label)),
  );
}

function shareBar(parts, total) {
  // Horizontal stacked bar, 2 px gaps, a label in each part that is wide enough.
  return el(
    'div',
    { class: 'sharebar' },
    parts
      .filter(([, n]) => n > 0)
      .map(([cls, n, label]) => {
        const pct = (n / total) * 100;
        return el('span', { class: `seg ${cls}`, style: `flex:${n}`, 'data-tip': t('kv', label, `${num(n)} (${percent(pct / 100)})`) }, pct >= 12 ? percent(pct / 100) : '');
      }),
  );
}

function tile(value, label, tip) {
  return el('div', { class: 'tile', title: tip || null }, el('b', { text: value }), el('span', { text: label }));
}

function figures(stats) {
  const total = stats.people.reduce((sum, p) => sum + stats.by.get(p).messages, 0) || 1;
  const convs = stats.convs.length || 1;
  const cards = stats.people.map((p) => {
    const s = stats.by.get(p);
    const reply = median(s.replies);
    const emojis = [...s.emojis].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const texts = [...s.langs.values()].reduce((a, b) => a + b, 0) || 1;
    return el(
      'section',
      { class: `pcard ${personClass(p)}` },
      el('h4', {}, el('i', { class: `k ${personClass(p)}` }), firstName(p)),
      el(
        'div',
        { class: 'tiles' },
        tile(percent(s.messages / total), t('stOfMessages', num(s.messages))),
        tile(num(Math.round(s.words / Math.max(1, texts))), t('stWordsPerMsg')),
        tile(reply == null ? '–' : reply < 30e3 ? t('stUnderMin') : duration(reply), t('stToReply'), t('stToReplyTip')),
        tile(percent(s.starts / convs), t('stStarted')),
        tile(num(s.relaunch), t('stRelaunch')),
        tile(num(s.questions), t('stQuestions')),
        tile(percent(s.night / Math.max(1, s.messages)), t('stNight')),
        tile(num(s.media), t('stMedia')),
        tile(num(s.reactsGiven), t('stReacts')),
        tile(num(s.unsent), t('stUnsent')),
      ),
      emojis.length > 0 && el('p', { class: 'emojis' }, el('span', { class: 'muted', text: t('stEmojis') }), emojis.map(([e, n]) => el('span', { class: 'emo', title: plural(n, 'nTimes'), text: e }))),
    );
  });
  const share = withReadout(
    shareBar(stats.people.map((p) => [personClass(p), stats.by.get(p).messages, firstName(p)]), total),
    t('stShare'),
  );
  return [el('div', { class: 'chartbox' }, share), el('div', { class: 'pcards' }, cards)];
}

function languages(stats) {
  const rows = stats.people.map((p) => {
    const s = stats.by.get(p);
    const total = [...s.langs.values()].reduce((a, b) => a + b, 0) || 1;
    return el(
      'div',
      { class: 'langrow' },
      el('span', { class: 'rlabel', text: firstName(p) }),
      shareBar(LANGS.map(([k, label], i) => [`c${i + 1}`, s.langs.get(k) || 0, label]), total),
    );
  });
  const box = el('div', { class: 'chartbox' }, rows);
  return [
    legend(LANGS.map(([, label], i) => [`c${i + 1}`, label])),
    ...withReadout(box, t('stLangHint')),
  ];
}

function rhythm(stats) {
  const days = weekdays('short');
  let max = 1;
  for (const row of stats.hours) for (const cell of row) max = Math.max(max, [...cell.values()].reduce((a, b) => a + b, 0));
  const grid = el('div', { class: 'heat' });
  grid.append(el('span'));
  for (let h = 0; h < 24; h++) grid.append(el('span', { class: 'hh', text: h % 3 === 0 ? hourText(h) : '' }));
  stats.hours.forEach((row, d) => {
    grid.append(el('span', { class: 'dd', text: days[d] }));
    row.forEach((cell, h) => {
      const n = [...cell.values()].reduce((a, b) => a + b, 0);
      const detail = stats.people.map((p) => `${firstName(p)} ${num(cell.get(p) || 0)}`).join(', ');
      grid.append(el('span', { class: 'hc', style: `--v:${(n / max).toFixed(3)}`, 'data-tip': t('kv', `${days[d]} ${hourText(h)}–${hourText((h + 1) % 24)}`, `${plural(n, 'nMessage')}${n ? ` (${detail})` : ''}`) }));
    });
  });
  // Messages per week, one bar per week, each person stacked.
  const weeks = [...stats.weeks].sort((a, b) => a[0] - b[0]);
  const top = Math.max(1, ...weeks.map(([, m]) => [...m.values()].reduce((a, b) => a + b, 0)));
  const bars = el(
    'div',
    { class: 'wbars' },
    weeks.map(([from, m]) => {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      return el(
        'div',
        { class: 'wbar', 'data-tip': t('kv', periodOf('week', from).label, `${plural(total, 'nMessage')} (${stats.people.map((p) => `${firstName(p)} ${num(m.get(p) || 0)}`).join(', ')})`) },
        [...stats.people].reverse().map((p) => el('span', { class: `seg ${personClass(p)}`, style: `height:${(((m.get(p) || 0) / top) * 100).toFixed(2)}%` })),
      );
    }),
  );
  const firstWeek = weeks[0]?.[0];
  const lastWeek = weeks[weeks.length - 1]?.[0];
  return [
    ...withReadout(el('div', { class: 'chartbox' }, grid), t('stHeatHint')),
    legend(stats.people.map((p) => [personClass(p), firstName(p)])),
    ...withReadout(
      el('div', { class: 'chartbox' }, bars, firstWeek && el('div', { class: 'wlabels' }, el('span', { text: fmt.dayMonth.format(firstWeek) }), el('span', { text: fmt.dayMonth.format(lastWeek) }))),
      t('stWeeksHint'),
    ),
  ];
}

function moodStudy(stats) {
  const summarized = stats.convs.filter(isSummarized);
  const ambiance = new Set(state.tags.filter((t) => t.kind === 'ambiance').map((t) => t.name));
  const totals = new Map();
  for (const c of summarized) for (const t of convTags(c)) if (ambiance.has(t)) totals.set(t, (totals.get(t) || 0) + 1);
  const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  if (!top.length) return [el('p', { class: 'edge', text: t('stNoMood') })];
  const months = new Map();
  for (const c of summarized) {
    const m = periodOf('month', c.from);
    if (!months.has(m.from)) months.set(m.from, { label: m.label, total: 0, tags: new Map() });
    const month = months.get(m.from);
    month.total++;
    for (const t of convTags(c)) if (top.includes(t)) month.tags.set(t, (month.tags.get(t) || 0) + 1);
  }
  const rows = [...months]
    .sort((a, b) => a[0] - b[0])
    .map(([, m]) => {
      const tagged = top.reduce((sum, t) => sum + (m.tags.get(t) || 0), 0) || 1;
      return el(
        'div',
        { class: 'langrow' },
        el('span', { class: 'rlabel', text: m.label.replace(/ \d{4}$/, '') }),
        shareBar(top.map((tag) => [`m${moodSlot(tag)}`, m.tags.get(tag) || 0, t('stMoodCell', m.label, tag, num(m.tags.get(tag) || 0), num(m.total))]), tagged),
      );
    });
  // A few plain observations: when and how long each mood happens, compared with the rest.
  const nightOf = (c) => {
    const h = new Date(c.from).getHours();
    return h >= 23 || h < 5;
  };
  const baseNight = summarized.filter(nightOf).length / Math.max(1, summarized.length);
  const baseLength = summarized.reduce((s, c) => s + convCount(c), 0) / Math.max(1, summarized.length);
  const notes = top.slice(0, 4).map((tag) => {
    const list = summarized.filter((c) => convTags(c).includes(tag));
    const night = list.filter(nightOf).length / list.length;
    const length = list.reduce((s, c) => s + convCount(c), 0) / list.length;
    const starters = new Map();
    for (const c of list) starters.set(state.thread.messages[c.start].from, (starters.get(state.thread.messages[c.start].from) || 0) + 1);
    const lead = [...starters].sort((a, b) => b[1] - a[1])[0];
    const parts = [`${plural(list.length, 'nConv')}`];
    if (Math.abs(night - baseNight) > 0.08) parts.push(t(night > baseNight ? 'stMoreNight' : 'stLessNight', percent(night), percent(baseNight)));
    if (Math.abs(length - baseLength) / baseLength > 0.2) parts.push(t(length > baseLength ? 'stLonger' : 'stShorter', num(Math.round(length)), num(Math.round(baseLength))));
    if (lead && list.length >= 4) parts.push(t('stLedBy', firstName(lead[0]), percent(lead[1] / list.length)));
    return el('li', {}, el('button', { type: 'button', class: `tag ambiance`, text: tag, onclick: () => filterByTag(tag) }), ` ${parts.join(' · ')}.`);
  });
  return [
    legend(top.map((t) => [`m${moodSlot(t)}`, t])),
    ...withReadout(el('div', { class: 'chartbox' }, rows), t('stMoodHint')),
    el('ul', { class: 'notes' }, notes),
  ];
}

/* ---------- Portraits (LLM, descriptive) ---------- */

function sampleMessages(person, convs, n) {
  const pool = [];
  for (const c of convs) for (let i = c.start; i < c.end; i++) {
    const m = state.thread.messages[i];
    if (m.from === person && m.type === 'text' && !m.unsent && (m.text.match(/[\p{L}\d']+/gu) || []).length >= 4) pool.push(m);
  }
  // The same sample every time for the same messages (seeded by position).
  const step = Math.max(1, Math.floor(pool.length / n));
  return pool.filter((_, i) => i % step === 0).slice(0, n);
}

function statsText(stats) {
  return stats.people
    .map((p) => {
      const s = stats.by.get(p);
      const reply = median(s.replies);
      const texts = [...s.langs.values()].reduce((a, b) => a + b, 0) || 1;
      const langs = LANGS.map(([k, label]) => `${label} ${percent((s.langs.get(k) || 0) / texts)}`).join(', ');
      return t('stLine', firstName(p), num(s.messages), Math.round(s.words / texts), reply == null ? t('stUnknown') : duration(reply), num(s.starts), num(stats.convs.length), num(s.questions), num(s.night), langs);
    })
    .join('\n');
}

async function writePortraits(button) {
  if (!state.llm?.url) return showView('reglages');
  const stats = analyse(visibleConvs());
  const convs = stats.convs.filter(isSummarized).sort((a, b) => a.from - b.from);
  if (!convs.length) return showNotice(t('stNeedSummaries'), 'error');
  const thread = state.thread;
  if (button) button.disabled = true;
  state.portraitBusy = true;
  renderMain();
  try {
    const samples = stats.people.map((p) => `${t('prSamples', firstName(p))}\n${sampleMessages(p, stats.convs, SAMPLE_PER_PERSON).map((m) => `- ${m.text.replace(/\s*\n\s*/g, ' / ')}`).join('\n')}`).join('\n\n');
    const group = thread.kind === 'group';
    const active = [...stats.people].sort((a, b) => stats.by.get(b).messages - stats.by.get(a).messages);
    const shown = group ? [thread.me, ...active.filter((p) => p !== thread.me).slice(0, 5)] : stats.people;
    const [me, other] = stats.people.map(shortName);
    const sections = group
      ? [...shown.map((p) => `## ${shortName(p)}`), t('prSameFour'), t('prGroup'), t('prGroupHow'), t('prWhoReacts'), t('prTensions'), t('prGroupWorks')]
      : [`## ${me}`, t('prFour'), `## ${other}`, t('prSameFourOne'), t('prRelation'), t('prHowYou'), t('prTensions'), t('prWorksYou')];
    const text = await chat([
      {
        role: 'system',
        content: [
          llmIntro(),
          group
            ? t('prIntroGroup', titleOf(thread))
            : t('prIntroPair', me, other),
          t('prRules'),
          t('prHeadings', LANG_NAME),
          ...sections,
          t('prPoints'),
        ].join('\n'),
      },
      {
        role: 'user',
        content: t('prUser', statsText(stats), samples, summaryList(convs, true)),
      },
    ]);
    const refs = {};
    for (const match of text.matchAll(/\d+/g)) {
      const conv = state.convs[Number(match[0]) - 1];
      if (conv) refs[match[0]] = conv.from;
    }
    if (state.thread !== thread) return;
    const record = { k: `portrait|${thread.id}`, text, refs, sig: sigOf(stats.convs), scope: stats.convs.length, filtered: filterActive() ? filterSummary() : '', by: state.llm.model, at: Date.now() };
    await put('prefs', record);
    state.portrait = record;
  } catch (e) {
    showNotice(t('prFailed', e.message), 'error');
  } finally {
    state.portraitBusy = false;
    renderMain();
  }
}

// Markdown-lite: ## and ### headings, "- " points, [n] links to conversations.
function renderPortrait(record) {
  const out = [];
  let list = null;
  for (const raw of record.text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('### ')) {
      list = null;
      out.push(el('h5', { text: line.slice(4) }));
    } else if (line.startsWith('## ')) {
      list = null;
      out.push(el('h4', { text: line.slice(3) }));
    } else {
      if (!list) out.push((list = el('ul')));
      list.append(el('li', { dir: 'auto' }, renderAnswer({ text: line.replace(/^[-•*]\s*/, ''), refs: record.refs })));
    }
  }
  return out;
}

function portraitCard(stats) {
  const record = state.portrait;
  const summarized = stats.convs.filter(isSummarized).length;
  const stale = record && record.sig !== sigOf(stats.convs);
  const chars = stats.convs.filter(isSummarized).reduce((s, c) => s + state.summary.get(c.index).text.length + 80, 0) + SAMPLE_PER_PERSON * 2 * 60;
  const button = el(
    'button',
    { type: 'button', class: 'pill accent small', disabled: state.portraitBusy || !summarized || !state.llm?.url, title: t('aboutTokensSent', num(Math.round(chars / 3.2 / 1000) * 1000)) },
    state.portraitBusy ? el('span', { class: 'spinner light' }) : icon('spark'),
    t(state.portraitBusy ? 'prWriting' : record ? 'prRedo' : 'prWrite'),
  );
  button.addEventListener('click', () => writePortraits(button));
  return el(
    'section',
    { class: 'portrait' },
    el(
      'div',
      { class: 'askhead' },
      el(
        'div',
        {},
        el('b', { text: t('prTitle') }),
        el('p', {
          class: 'muted',
          text: t('prDesc', plural(summarized, 'nSummary'), filterActive() ? t('prFilteredParen') : '', SAMPLE_PER_PERSON),
        }),
      ),
      button,
    ),
    record && el('p', { class: 'muted small', text: `${t('prWrittenOn', fmt.full.format(record.at), record.by, plural(record.scope, 'nConv'))}${record.filtered ? ` (${record.filtered})` : ''}${stale ? t('prStale') : ''}.` }),
    record && el('div', { class: 'portrait-text' }, renderPortrait(record)),
    !state.llm?.url && el('p', { class: 'hint', text: t('prNeedLlm') }),
  );
}

/* ---------- The view ---------- */

function analyseView() {
  const convs = visibleConvs();
  const stats = analyse(convs);
  const first = convs.reduce((a, c) => Math.min(a, c.from), Infinity);
  const last = convs.reduce((a, c) => Math.max(a, c.to), -Infinity);
  const scope = convs.length ? `${t('anScope', plural(convs.length, 'nConv'), fmt.date.format(first), fmt.date.format(last))}${filterActive() ? t('anFiltered', filterSummary()) : ''}` : t('anNoConv');
  if (!convs.length) return [head(t('anTitle'), scope)];
  return [
    head(t('anTitle'), scope + t('anLocal')),
    el('h3', { class: 'group', text: t('anFigures') }),
    ...figures(stats),
    el('h3', { class: 'group', text: t('anLanguages') }),
    ...languages(stats),
    el('h3', { class: 'group', text: t('anWhen') }),
    ...rhythm(stats),
    el('h3', { class: 'group', text: t('anMood') }),
    ...moodStudy(stats),
    el('h3', { class: 'group', text: t('anPortrait') }),
    portraitCard(stats),
  ];
}
