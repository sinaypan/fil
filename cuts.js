'use strict';
// Fil: corrections of the cut between conversations. The silence threshold
// decides by default; a decision of the LLM on a doubtful silence comes over
// it, and a correction made by hand comes over everything.
// state.cuts = { merge: [message id], split: [message id], llm: { [gap minutes]: { [message id]: 'same' | 'new' } } }

const DOUBT_LOW = 0.5; // silences between half and 2.5 times the threshold are doubtful
const DOUBT_HIGH = 2.5;
const DOUBT_CONTEXT = 8; // messages shown to the LLM on each side

const emptyCuts = () => ({ merge: [], split: [], llm: {} });

function cleanCuts(raw) {
  const ids = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  const llm = {};
  for (const [gap, decisions] of Object.entries(raw?.llm || {})) {
    if (!decisions || typeof decisions !== 'object') continue;
    llm[gap] = {};
    for (const [id, v] of Object.entries(decisions)) if (v === 'same' || v === 'new') llm[gap][id] = v;
  }
  return { merge: ids(raw?.merge), split: ids(raw?.split), llm };
}

async function saveCuts() {
  await put('prefs', { k: `cuts|${state.thread.id}`, ...state.cuts });
}

// How the boundary before message i is decided: 'split' | 'merge' (by hand), 'new' | 'same' (LLM), or null (threshold).
function cutDecision(id) {
  if (state.cuts.split.includes(id)) return 'split';
  if (state.cuts.merge.includes(id)) return 'merge';
  return state.cuts.llm[state.gap]?.[id] || null;
}

function rebuildConvs() {
  const at = state.convs[state.conv]?.from;
  state.convs = buildConvs(state.thread.messages, state.gap);
  linkNotes();
  state.conv = at != null && state.convs.length ? convAt(at).index : state.convs.length - 1;
}

async function setCut(id, decision) {
  if (state.batch) return showNotice(t('waitWork'), 'error');
  state.cuts.merge = state.cuts.merge.filter((x) => x !== id);
  state.cuts.split = state.cuts.split.filter((x) => x !== id);
  if (decision === 'merge') state.cuts.merge.push(id);
  if (decision === 'split') state.cuts.split.push(id);
  await saveCuts();
  rebuildConvs();
  render();
}

// Silences close to the threshold that neither the LLM nor a correction has settled yet.
function doubtfulCuts() {
  const messages = state.thread.messages;
  const gap = state.gap * 60e3;
  const decided = state.cuts.llm[state.gap] || {};
  const out = [];
  for (let i = 1; i < messages.length; i++) {
    const silence = messages[i].ts - messages[i - 1].ts;
    if (silence < gap * DOUBT_LOW || silence > gap * DOUBT_HIGH) continue;
    const id = messages[i].id;
    if (decided[id] || state.cuts.merge.includes(id) || state.cuts.split.includes(id)) continue;
    out.push({ i, id, silence });
  }
  return out;
}

function doubtLines(from, to) {
  const messages = state.thread.messages.slice(Math.max(0, from), Math.max(0, to));
  return messages.map((m) => t('trLine', fmt.time.format(m.ts), shortName(m.from), messageText(m).replace(/\s*\n\s*/g, ' / ')));
}

async function decideCut(doubt, signal) {
  const thread = state.thread;
  const gap = state.gap;
  const before = doubtLines(doubt.i - DOUBT_CONTEXT, doubt.i);
  const after = doubtLines(doubt.i, doubt.i + DOUBT_CONTEXT);
  const answer = await chat(
    [
      {
        role: 'system',
        content: [
          systemPrompt().split('\n').slice(0, 2).join('\n'),
          t('cPrompt1'),
          t('cPrompt2'),
          t('cPrompt3'),
        ].join('\n'),
      },
      { role: 'user', content: t('cUser', before.join('\n'), duration(doubt.silence), after.join('\n')) },
    ],
    signal,
  );
  if (state.thread !== thread || state.gap !== gap) return;
  const word = answer.trim().toUpperCase().normalize('NFD').replace(/\p{M}/gu, '');
  const decision = /NOUVEL|\bNEW\b/.test(word) ? 'new' : /MEME|SAME/.test(word) ? 'same' : null;
  if (!decision) throw new Error(t('cBadAnswer', answer.trim().slice(0, 60)));
  state.cuts.llm[gap] ||= {};
  state.cuts.llm[gap][doubt.id] = decision;
  await saveCuts();
}

async function runDoubts() {
  const doubts = doubtfulCuts();
  if (!doubts.length) return showNotice(t('noDoubtful'));
  await runJobs(doubts, decideCut, t('batchCuts'), 'nCutChecked');
  rebuildConvs();
  render();
}

async function forgetLlmCuts() {
  delete state.cuts.llm[state.gap];
  await saveCuts();
  rebuildConvs();
  render();
}

async function forgetHandCuts() {
  state.cuts.merge = [];
  state.cuts.split = [];
  await saveCuts();
  rebuildConvs();
  render();
}

// The part of the Settings about the cut.
function cutsPanel() {
  if (!state.thread || state.screen !== 'thread') return null;
  const doubts = doubtfulCuts();
  const decided = Object.values(state.cuts.llm[state.gap] || {});
  const same = decided.filter((d) => d === 'same').length;
  const fresh = decided.length - same;
  const hand = state.cuts.merge.length + state.cuts.split.length;
  const low = state.gap * DOUBT_LOW;
  const high = state.gap * DOUBT_HIGH;
  const chars = doubts.length * DOUBT_CONTEXT * 2 * 40;
  const rows = [];
  rows.push(
    el(
      'div',
      { class: 'cutrow' },
      el('p', {}, el('b', { text: t('doubtfulTitle') }), el('span', { class: 'muted', text: t('doubtfulInfo', plural(doubts.length, 'nSilence'), duration(low * 60e3), duration(high * 60e3)) })),
      state.llm?.url && doubts.length > 0 && !state.batch && el('button', { type: 'button', class: 'pill accent small', title: t('aboutTokensSent', num(Math.round(chars / 3.2 / 1000) * 1000)), onclick: runDoubts }, icon('spark'), t('checkN', num(doubts.length))),
    ),
  );
  if (decided.length) {
    rows.push(
      el(
        'div',
        { class: 'cutrow' },
        el('p', {}, el('b', { text: t('llmDecisions') }), el('span', { class: 'muted', text: t('llmDecisionsInfo', plural(same, 'nConvRejoined'), plural(fresh, 'nNewCut')) })),
        el('button', { type: 'button', class: 'pill small', text: t('forget'), onclick: forgetLlmCuts }),
      ),
    );
  }
  rows.push(
    el(
      'div',
      { class: 'cutrow' },
      el('p', {}, el('b', { text: t('yourFixes') }), el('span', { class: 'muted', text: hand ? t('yourFixesInfo', plural(state.cuts.merge.length, 'nMerge'), plural(state.cuts.split.length, 'nCut')) : t('yourFixesNone') })),
      hand > 0 && el('button', { type: 'button', class: 'pill small', text: t('undoAll'), onclick: forgetHandCuts }),
    ),
  );
  return rows;
}

// Inside a conversation: where two pieces were joined, with a way back.
function joinedSeparator(m, prev) {
  const decision = cutDecision(m.id);
  const who = decision === 'merge' ? t('joinedByYou') : decision === 'same' ? t('joinedByLlm') : '';
  return el(
    'p',
    { class: 'sep joined' },
    t('joinedSep', fmt.time.format(m.ts), duration(m.ts - prev.ts), who),
    el('button', { type: 'button', class: 'inline small', text: t('cutHereShort'), onclick: () => setCut(m.id, 'split') }),
  );
}

// At the top of a conversation that starts because of a correction or the LLM.
function cutNotice(conv) {
  const decision = cutDecision(conv.id);
  if (!conv.index || (decision !== 'split' && decision !== 'new')) return null;
  return el(
    'p',
    { class: 'edge cutnote' },
    t(decision === 'split' ? 'youCutHere' : 'llmCutHere') + ' ',
    el('button', { type: 'button', class: 'inline small', text: t('rejoinPrev'), onclick: () => setCut(conv.id, 'merge') }),
  );
}
