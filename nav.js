'use strict';
// Fil: Opening threads and conversations, views, notices.

/* ---------- Navigation ---------- */

async function selectThread(threadOrMeta, at, view = 'fil') {
  const thread = Array.isArray(threadOrMeta.messages) ? threadOrMeta : await loadThread(threadOrMeta);
  const switching = state.thread?.id !== thread.id;
  state.screen = 'thread';
  if (state.batch && switching) state.batch.controller.abort();
  state.thread = thread;
  state.cuts = cleanCuts(await getOne('prefs', `cuts|${thread.id}`));
  state.convs = buildConvs(thread.messages, state.gap);
  state.folded = null;
  const known = new Set([thread.id]);
  state.notes = (await getByThread('notes', thread.id))
    .map((n) => cleanNote(n, known))
    .filter(Boolean)
    .sort((a, b) => a.from - b.from);
  linkNotes();
  state.stars = new Map((await getByThread('stars', thread.id)).map((s) => [s.msg, s]));
  state.tags = ((await getOne('prefs', `tags|${thread.id}`))?.list || []).filter((t) => t && typeof t.name === 'string');
  state.chapters = new Map((await getByThread('chapters', thread.id)).map((r) => [r.key, r]));
  state.memory = new Map((await getByThread('memory', thread.id)).map((r) => [r.key, r]));
  state.asks = new Map((await getByThread('asks', thread.id)).map((r) => [r.key, r]));
  state.factsDone = new Map(Object.entries((await getOne('prefs', `facts|${thread.id}`))?.done || {}));
  state.portrait = (await getOne('prefs', `portrait|${thread.id}`)) || null;
  if (switching) state.filter = { ...NO_FILTER };
  state.conv = Number.isFinite(at) && state.convs.length ? convAt(at).index : state.convs.length - 1;
  state.view = view;
  state.sel = null;
  state.who = null;
  setQuery('');
  render();
  scrollTimelineToConv();
  $('#main').scrollTop = 0;
  savePrefs();
}

function openConv(index, focusId) {
  if (!state.convs[index]) return;
  state.conv = index;
  state.view = 'fil';
  state.writing = null;
  if (focusId) state.mode = 'messages';
  setQuery('');
  renderSide();
  renderMain();
  savePrefs();
  const row = focusId && state.nodes.get(focusId);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1900);
  } else {
    $('#main').scrollTop = 0;
  }
  scrollTimelineToConv('nearest');
}

function setQuery(value) {
  state.query = value;
  $('#q').value = value;
  $('#clear').hidden = !value;
}

function showView(view) {
  state.view = view;
  setQuery('');
  renderSide();
  renderMain();
  $('#main').scrollTop = 0;
}

function showNotice(text, kind = 'info') {
  $('#notice-text').textContent = text;
  $('#notice').className = kind;
  $('#notice').hidden = false;
}

