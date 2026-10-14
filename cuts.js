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
  if (state.batch) return showNotice('Attends la fin du travail en cours (ou arrête-le) avant de changer le découpage.', 'error');
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
  return messages.map((m) => `[${fmt.time.format(m.ts)}] ${firstName(m.from)} : ${messageText(m).replace(/\s*\n\s*/g, ' / ')}`);
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
          'On te montre la fin d’un échange et le début du suivant, séparés par un silence.',
          'Dis si c’est la MÊME conversation qui continue (on répond à ce qui précède, même sujet, on reprend là où on en était) ou une NOUVELLE conversation (nouveau sujet, salutations, autre moment de la journée).',
          'Réponds par un seul mot : MEME ou NOUVELLE.',
        ].join('\n'),
      },
      { role: 'user', content: `Avant :\n${before.join('\n')}\n\n--- silence de ${duration(doubt.silence)} ---\n\nAprès :\n${after.join('\n')}` },
    ],
    signal,
  );
  if (state.thread !== thread || state.gap !== gap) return;
  const word = answer.trim().toUpperCase().normalize('NFD').replace(/\p{M}/gu, '');
  const decision = /NOUVEL/.test(word) ? 'new' : /MEME|SAME/.test(word) ? 'same' : null;
  if (!decision) throw new Error(`Réponse incomprise : « ${answer.trim().slice(0, 60)} »`);
  state.cuts.llm[gap] ||= {};
  state.cuts.llm[gap][doubt.id] = decision;
  await saveCuts();
}

async function runDoubts() {
  const doubts = doubtfulCuts();
  if (!doubts.length) return showNotice('Aucune coupure douteuse à vérifier.');
  await runJobs(doubts, decideCut, 'Coupures', ['coupure vérifiée', 'coupures vérifiées']);
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
  if (!state.thread) return null;
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
      el('p', {}, el('b', { text: 'Coupures douteuses' }), el('span', { class: 'muted', text: ` · ${plural(doubts.length, 'silence', 'silences')} entre ${duration(low * 60e3)} et ${duration(high * 60e3)} pas encore vérifiés. Le LLM lit les messages autour et dit si la conversation continue ou s’il en commence une nouvelle.` })),
      state.llm?.url && doubts.length > 0 && !state.batch && el('button', { type: 'button', class: 'pill accent small', title: `Environ ${num(Math.round(chars / 3.2 / 1000) * 1000)} tokens envoyés`, onclick: runDoubts }, icon('spark'), `Vérifier les ${num(doubts.length)}`),
    ),
  );
  if (decided.length) {
    rows.push(
      el(
        'div',
        { class: 'cutrow' },
        el('p', {}, el('b', { text: 'Décisions du LLM' }), el('span', { class: 'muted', text: ` · ${plural(same, 'conversation recollée', 'conversations recollées')}, ${plural(fresh, 'nouvelle coupure', 'nouvelles coupures')} (pour l’écart actuel).` })),
        el('button', { type: 'button', class: 'pill small', text: 'Oublier', onclick: forgetLlmCuts }),
      ),
    );
  }
  rows.push(
    el(
      'div',
      { class: 'cutrow' },
      el('p', {}, el('b', { text: 'Tes corrections' }), el('span', { class: 'muted', text: hand ? ` · ${plural(state.cuts.merge.length, 'fusion', 'fusions')}, ${plural(state.cuts.split.length, 'coupure', 'coupures')}. Elles passent avant tout le reste, quel que soit l’écart.` : ' · aucune. Dans une conversation : « Fusionner avec la précédente » en haut, ou les ciseaux au survol d’un message pour couper avant lui.' })),
      hand > 0 && el('button', { type: 'button', class: 'pill small', text: 'Tout annuler', onclick: forgetHandCuts }),
    ),
  );
  return rows;
}

// Inside a conversation: where two pieces were joined, with a way back.
function joinedSeparator(m, prev) {
  const decision = cutDecision(m.id);
  const who = decision === 'merge' ? 'par toi' : decision === 'same' ? 'par le LLM' : '';
  return el(
    'p',
    { class: 'sep joined' },
    `${fmt.time.format(m.ts)} · ${duration(m.ts - prev.ts)} plus tard · recollée ${who}`,
    el('button', { type: 'button', class: 'inline small', text: 'Couper ici', onclick: () => setCut(m.id, 'split') }),
  );
}

// At the top of a conversation that starts because of a correction or the LLM.
function cutNotice(conv) {
  const decision = cutDecision(conv.id);
  if (!conv.index || (decision !== 'split' && decision !== 'new')) return null;
  return el(
    'p',
    { class: 'edge cutnote' },
    decision === 'split' ? 'Tu as coupé ici. ' : 'Le LLM a coupé ici. ',
    el('button', { type: 'button', class: 'inline small', text: 'Recoller à la précédente', onclick: () => setCut(conv.id, 'merge') }),
  );
}
