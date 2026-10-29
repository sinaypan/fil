'use strict';
// Fil: Calls to the LLM: summaries, batches.

/* ---------- LLM ---------- */

function endpoint(url) {
  const clean = url.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(clean) ? clean : `${clean}/chat/completions`;
}

function originPattern(url) {
  const u = new URL(url.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(t('badUrl'));
  return `${u.protocol}//${u.hostname}/*`;
}

async function chat(messages, signal) {
  const { url, model, key } = state.llm || {};
  if (!url || !model) throw new Error(t('noLlm'));
  if (!(await chrome.permissions.contains({ origins: [originPattern(url)] }))) {
    throw new Error(t('noLlmPermission'));
  }
  const timeout = AbortSignal.timeout(TIMEOUT);
  let response;
  try {
    response = await fetch(endpoint(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timeout.aborted) throw new Error(t('llmTimeout'));
    throw new Error(t('llmUnreachable', new URL(endpoint(url)).host));
  }
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  if (!response.ok) {
    const detail = json?.error?.message || json?.detail || json?.message || raw.slice(0, 200);
    const hint = response.status === 401 || response.status === 403 ? t('llmKeyRefused') : response.status === 404 ? t('llmCheckModel') : '';
    throw new Error(`${t('llmStatus', response.status, hint)}${detail ? `\n${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error(t('llmNoText'));
  return text;
}

function systemPrompt() {
  const thread = state.thread;
  const me = shortName(thread.me);
  const others = thread.participants.filter((p) => p !== thread.me).map(shortName).join(', ');
  const where = platformOf(thread.platform).name;
  return [
    thread.kind === 'group'
      ? t('pGroup', where, titleOf(thread), me, others)
      : t('pPair', where, me, others),
    t('pLanguages'),
    t('pMemory', me),
    t('pAnswerIn', LANG_NAME),
    t('pTitleLine'),
    t('pTagsLine'),
    '- <point>',
    '- <point>',
    t('pKeep'),
    t('pLength'),
    tagRules(),
  ].join('\n');
}

function userPrompt(conv) {
  const parts = [];
  const before = [];
  for (let i = conv.index - 1; i >= 0 && before.length < CONTEXT_BEFORE; i--) {
    const c = state.convs[i];
    if (isSummarized(c)) before.unshift(c);
  }
  if (before.length) {
    parts.push(t('pContext'));
    for (const c of before) {
      const sum = state.summary.get(c.index);
      parts.push(`${convLabel(c)}${sum.title ? ` : ${sum.title}` : ''}\n${sum.text.trim()}`);
    }
    parts.push('');
  }
  parts.push(tagList(), '');
  parts.push(t('pToSummarize', convLabel(conv), plural(convCount(conv), 'nMessage')), '---', transcriptLines(conv).join('\n'));
  return parts.join('\n');
}

function parseSummary(text) {
  const lines = text.trim().split('\n');
  let title = '';
  const index = lines.findIndex((l) => /^\s*[#*]*\s*titre\s*[*]*\s*:/i.test(l));
  if (index !== -1) {
    title = lines[index].replace(/^\s*[#*]*\s*titre\s*[*]*\s*:\s*/i, '').replace(/\*+/g, '').trim();
    lines.splice(index, 1);
  }
  const tags = parseTagsLine(lines);
  return { title, tags, text: lines.join('\n').trim() };
}

async function summarize(conv, signal) {
  const thread = state.thread;
  state.working.add(conv.id);
  refreshConv(conv);
  try {
    const answer = await chat([{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPrompt(conv) }], signal);
    if (state.thread !== thread) return;
    const now = state.convs[conv.index];
    if (!now || now.id !== conv.id) return; // the cut changed meanwhile
    const parsed = parseSummary(answer);
    const { names, added, renames } = resolveTags(parsed.tags);
    if (added) await saveTags();
    if (renames.size) await retag(renames);
    await saveConvNote(conv, { title: parsed.title, text: parsed.text, tags: names, by: state.llm.model });
  } finally {
    state.working.delete(conv.id);
    refreshConv(conv);
  }
}

async function summarizeOne(conv, button) {
  if (!state.llm?.url) return showView('reglages');
  if (button) button.disabled = true;
  try {
    await summarize(conv);
  } catch (e) {
    if (button) button.disabled = false;
    showNotice(t('summaryFailed', e.message), 'error');
  }
}

// Conversations that would be sent: no summary yet and long enough. Saved
// summaries are never asked again, only "Refaire le résumé" does that.
const toSummarize = (convs) => convs.filter((c) => noteStatus(c) === 'none' && textCount(c) >= MIN_TEXTS);

// Runs a job on each item, a few at a time, with progress in the sidebar and a Stop button.
async function runJobs(items, job, label, doneKey) {
  if (state.batch) return;
  if (!state.llm?.url) return showView('reglages');
  if (!items.length) return;
  const controller = new AbortController();
  state.batch = { done: 0, total: items.length, failed: 0, controller, lastError: '', label };
  const refresh = () => (state.screen !== 'thread' || (['resumes', 'frise', 'tags', 'reglages'].includes(state.view) && !state.query)) && renderMain();
  renderBatch();
  refresh();
  let next = 0;
  let streak = 0;
  const worker = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const item = items[next++];
      try {
        await job(item, controller.signal);
        streak = 0;
      } catch (e) {
        if (controller.signal.aborted) break;
        state.batch.failed++;
        state.batch.lastError = e.message;
        if (++streak >= 3) controller.abort();
      }
      state.batch.done++;
      renderBatch();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const { done, failed, lastError } = state.batch;
  const stopped = controller.signal.aborted;
  state.batch = null;
  renderBatch();
  refresh();
  if (failed) showNotice(`${stopped && failed >= 3 ? t('stoppedAfter3') : t('nFailed', num(failed))}\n${lastError}`, 'error');
  else showNotice(`${plural(done, doneKey)}${stopped ? t('stopped') : ''}.`);
}

function runBatch(convs = state.convs, kind = 'summary') {
  const tags = kind === 'tags';
  const todo = tags ? toTag(convs) : toSummarize(convs);
  if (!todo.length) return showNotice(t(tags ? 'allTagged' : 'allSummarized'));
  return runJobs(todo, tags ? tagConv : summarize, t(tags ? 'batchTags' : 'batchSummaries'), tags ? 'nConvTagged' : 'nConvSummarized');
}

// Progress of a batch: in the sidebar of a thread, and at the top of the home screen.
function renderBatch() {
  const b = state.batch;
  for (const box of [$('#batch'), $('#home-batch')]) {
    if (!box) continue;
    box.hidden = !b;
    if (!b) continue;
    const stop = el('button', { type: 'button', class: 'pill small', text: t('stop'), onclick: () => b.controller.abort() });
    box.replaceChildren(
      el('div', { class: 'batch-line' }, el('span', { text: `${b.label} : ${num(b.done)} / ${num(b.total)}${b.failed ? ` · ${plural(b.failed, 'nError')}` : ''}` }), stop),
      el('div', { class: 'bar' }, el('span', { style: `width:${Math.round((b.done / b.total) * 100)}%` })),
      el('p', { class: 'muted', text: t('keepTabOpen') }),
    );
  }
}

// After a summary changes: the sidebar row, and the main view if it shows it.
function refreshConv(conv) {
  renderTimeline();
  if (state.query) return;
  if (state.view === 'fil' && state.conv === conv.index && !document.activeElement?.closest?.('.card')) {
    if (state.mode === 'resume') return renderMain();
    const top = document.querySelector('.head');
    if (top) top.replaceWith(convHead(conv));
  }
  if ((state.view === 'resumes' || state.view === 'tags') && !state.batch) renderMain();
  if (state.view === 'frise' && !state.dragging) renderMain();
}

