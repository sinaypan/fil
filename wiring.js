'use strict';
// Fil: Event wiring and start.

/* ---------- Wiring ---------- */

function wire() {
  for (const slot of document.querySelectorAll('[data-icon]')) slot.replaceWith(icon(slot.dataset.icon));

  $('#import').addEventListener('click', () => $('#file').click());
  $('#home-btn').addEventListener('click', goBack);
  $('#folder').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#backup').addEventListener('click', backup);
  $('#settings').addEventListener('click', () => showView('reglages'));
  $('#file').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#notice-close').addEventListener('click', () => ($('#notice').hidden = true));
  for (const tab of document.querySelectorAll('#tabs button')) tab.addEventListener('click', () => showView(tab.dataset.view));

  let timer = 0;
  $('#q').addEventListener('input', (event) => {
    $('#clear').hidden = !event.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = event.target.value;
      state.searchLimit = 60;
      renderSide();
      renderMain();
      $('#main').scrollTop = 0;
    }, 160);
  });
  $('#q').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setQuery('');
      render();
    }
  });
  $('#clear').addEventListener('click', () => {
    setQuery('');
    render();
    $('#q').focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      $('#q').focus();
      return;
    }
    if (state.screen !== 'thread' || !state.thread || state.view !== 'fil' || state.query) return;
    const [prev, next] = neighbours(state.convs[state.conv]);
    const target = event.key === 'ArrowLeft' ? prev : event.key === 'ArrowRight' ? next : null;
    if (target) {
      event.preventDefault();
      openConv(target.index);
    }
  });

  const drop = $('#drop');
  window.addEventListener('dragenter', (event) => {
    if (event.dataTransfer?.types.includes('Files')) drop.hidden = false;
  });
  drop.addEventListener('dragover', (event) => event.preventDefault());
  drop.addEventListener('dragleave', () => (drop.hidden = true));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.hidden = true;
    const files = [...event.dataTransfer.files];
    if (files.length) importFiles(files);
  });

  document.addEventListener('pointerdown', (event) => {
    const card = $('#filtercard');
    if (!card.hidden && !event.target.closest('#filtercard, #filter-open')) toggleFilterCard();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#filtercard').hidden) toggleFilterCard();
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.batch) event.preventDefault();
  });
  window.addEventListener('error', (event) => showNotice(t('errorMsg', event.message), 'error'));
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.name === 'AbortError') return;
    showNotice(t('errorMsg', event.reason?.message || event.reason), 'error');
  });
}

async function start() {
  wire();
  try {
    state.db = await openDb();
    state.threads = await getAll('threads');
    const [gap, llm, moods, prefs] = await Promise.all([getOne('prefs', 'gap'), getOne('prefs', 'llm'), getOne('prefs', 'moods'), getAll('prefs')]);
    if (GAP_CHOICES.includes(gap?.minutes)) state.gap = gap.minutes;
    if (llm?.url) state.llm = { url: llm.url, model: llm.model, key: llm.key || '' };
    state.moodSlots = new Map(Object.entries(moods?.slots || {}));
    state.life = new Map(prefs.filter((r) => typeof r.k === 'string' && r.k.startsWith('life|')).map((r) => [r.k, r]));
    await syncPeople();
    await goHome();
  } catch (e) {
    render();
    showNotice(t('cantOpenData', e.message), 'error');
  }
}
