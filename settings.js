'use strict';
// Fil: Settings view.

/* ---------- Settings ---------- */

function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'flabel', text: label }), input, hint && el('span', { class: 'hint', text: hint }));
}

function settingsView() {
  const llm = state.llm || {};
  const url = el('input', { id: 'llm-url', type: 'text', placeholder: 'https://…/v1', spellcheck: 'false', autocomplete: 'off' });
  const model = el('input', { id: 'llm-model', type: 'text', placeholder: 'gpt-4.1', spellcheck: 'false', autocomplete: 'off' });
  const key = el('input', { id: 'llm-key', type: 'password', placeholder: 'sk-…', spellcheck: 'false', autocomplete: 'off' });
  url.value = llm.url || '';
  model.value = llm.model || '';
  key.value = llm.key || '';
  const result = el('p', { class: 'result' });
  const save = el('button', { type: 'button', class: 'pill accent' }, icon('check'), t('saveTest'));
  save.addEventListener('click', () => saveLlm({ url: url.value.trim(), model: model.value.trim(), key: key.value.trim() }, result, save));
  const forget = el('button', { type: 'button', class: 'pill', disabled: !state.llm, text: t('forgetLlm') });
  forget.addEventListener('click', async () => {
    await remove('prefs', 'llm');
    state.llm = null;
    showNotice(t('llmForgotten'));
    renderMain();
  });

  const gapChips = el(
    'div',
    { class: 'chips' },
    GAP_CHOICES.map((minutes) =>
      el('button', {
        type: 'button',
        class: `chip${state.gap === minutes ? ' on' : ''}`,
        text: minutes < 60 ? t('durMin', minutes) : t('durHours', minutes / 60),
        onclick: () => setGap(minutes),
      }),
    ),
  );
  const gapCount = state.thread ? t('gapCount', state.gap < 60 ? t('durMin', state.gap) : t('durHours', state.gap / 60), plural(state.convs.length, 'nConv')) : '';

  return [
    head(t('settings')),
    el('h3', { class: 'group', text: t('cutting') }),
    el(
      'div',
      { class: 'panel' },
      field(t('gapLabel'), gapChips, `${gapCount} ${t('gapHint')}`),
      cutsPanel(),
    ),
    el('h3', { class: 'group', text: t('llmForSummaries') }),
    el(
      'div',
      { class: 'panel' },
      field(t('apiUrl'), url, t('apiUrlHint')),
      field(t('model'), model),
      field(t('apiKey'), key, t('apiKeyHint')),
      el('div', { class: 'actions' }, save, forget),
      result,
      el('p', { class: 'hint', text: t('llmPrivacy') }),
    ),
  ];
}

async function saveLlm(config, result, button) {
  result.className = 'result';
  let pattern;
  try {
    if (!config.url || !config.model) throw new Error(t('needUrlModel'));
    pattern = originPattern(config.url);
  } catch (e) {
    result.className = 'result error';
    result.textContent = e.message;
    return;
  }
  // Asked straight from the click, as Chrome requires: the right to contact this one site only.
  const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  if (!granted) {
    result.className = 'result error';
    result.textContent = t('llmNeedConsent');
    return;
  }
  await put('prefs', { k: 'llm', ...config });
  state.llm = config;
  button.disabled = true;
  result.textContent = t('savedTesting');
  try {
    const answer = await chat([{ role: 'user', content: t('testPrompt') }]);
    result.className = 'result ok';
    result.textContent = t('testOk', config.model, answer.trim().slice(0, 80));
  } catch (e) {
    result.className = 'result error';
    result.textContent = t('testFailed', e.message);
  } finally {
    button.disabled = false;
  }
}

async function setGap(minutes) {
  if (state.batch) return showNotice(t('waitSummaries'), 'error');
  const at = state.convs[state.conv]?.from;
  state.gap = minutes;
  await put('prefs', { k: 'gap', minutes });
  if (state.thread) {
    state.convs = buildConvs(state.thread.messages, state.gap);
    linkNotes();
    state.conv = at != null ? convAt(at).index : state.convs.length - 1;
  }
  render();
}

