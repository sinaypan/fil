'use strict';
// Fil: Tags and their list.

/* ---------- Tags ---------- */

const MAX_TAGS = 40;
const TAG_KINDS = [
  ['sujet', t('kindTopics'), t('kindTopicsWhat')],
  ['ambiance', t('kindMood'), t('kindMoodWhat')],
];

// Same tag whatever the accents, case or a final s/x: "Tristesse" = "tristesses".
const tagKey = (name) =>
  String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(MARK, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/(\S\S)[sx]\b/g, '$1');

const cleanTagName = (raw) =>
  String(raw)
    .replace(/^[\s#*_"'«-]+|[\s*_.,"'»]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 30);

const findTag = (name) => state.tags.find((t) => tagKey(t.name) === tagKey(name));
const kindOf = (name) => findTag(name)?.kind || 'sujet';

async function saveTags() {
  await put('prefs', { k: `tags|${state.thread.id}`, list: state.tags });
}

// What the LLM answered, matched against the list: an existing tag is reused,
// a new one is added while the list has room, anything else is dropped.
function resolveTags(raw) {
  const names = [];
  const renames = new Map();
  let added = false;
  for (const item of raw) {
    const slash = item.indexOf('/');
    const family = tagKey(slash === -1 ? '' : item.slice(0, slash));
    const name = cleanTagName(slash === -1 ? item : item.slice(slash + 1));
    if (!name || !tagKey(name)) continue;
    let tag = findTag(name);
    if (!tag) {
      if (state.tags.length >= MAX_TAGS) continue;
      tag = { name, kind: family.startsWith('amb') ? 'ambiance' : 'sujet', at: Date.now() };
      state.tags.push(tag);
      added = true;
    } else if (name.length < tag.name.length) {
      // Same tag written shorter (singular): that form wins everywhere.
      renames.set(tag.name, name);
      tag.name = name;
      added = true;
    }
    if (!names.includes(tag.name)) names.push(tag.name);
  }
  return { names: names.slice(0, 6), added, renames };
}

function parseTagsLine(lines) {
  const index = lines.findIndex((l) => /^\s*[#*]*\s*tags?\s*[*]*\s*:/i.test(l));
  if (index === -1) return [];
  const raw = lines[index].replace(/^\s*[#*]*\s*tags?\s*[*]*\s*:\s*/i, '').replace(/\*+/g, '');
  lines.splice(index, 1);
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tagRules() {
  return [
    t('tRules1'),
    t('tRules2'),
    t('tRules3'),
    t('tRules4'),
    t('tRules5'),
    t('tRules6', LANG_NAME),
  ].join('\n');
}

function tagList() {
  if (!state.tags.length) return t('tNone');
  const of = (kind) =>
    state.tags
      .filter((t) => t.kind === kind)
      .map((t) => t.name)
      .join(', ') || t('tNoneOfKind');
  const full = state.tags.length >= MAX_TAGS ? t('tFull') : '';
  return `${t('tExisting')}\nsujet : ${of('sujet')}\nambiance : ${of('ambiance')}${full}`;
}

const convTags = (conv) => state.summary.get(conv.index)?.tags || [];
const toTag = (convs) => convs.filter((c) => noteStatus(c) === 'ok' && !convTags(c).length);

async function tagConv(conv, signal) {
  const thread = state.thread;
  state.working.add(conv.id);
  refreshConv(conv);
  try {
    const intro = systemPrompt().split('\n').slice(0, 2).join('\n');
    const answer = await chat(
      [
        { role: 'system', content: `${intro}\n${t('tOnlyTags')}\n${tagRules()}\n${t('tOneLine')}` },
        { role: 'user', content: `${tagList()}\n\n${t('tConversation', convLabel(conv))}\n---\n${transcriptLines(conv).join('\n')}` },
      ],
      signal,
    );
    if (state.thread !== thread || state.convs[conv.index]?.id !== conv.id) return;
    const raw = parseTagsLine(answer.trim().split('\n'));
    if (!raw.length) throw new Error(t('tNoLine'));
    const { names, added, renames } = resolveTags(raw);
    if (added) await saveTags();
    if (renames.size) await retag(renames);
    await setConvTags(conv, names);
  } finally {
    state.working.delete(conv.id);
    refreshConv(conv);
  }
}

async function setConvTags(conv, names) {
  const sum = state.summary.get(conv.index);
  if (!sum) return;
  await saveConvNote(conv, { title: sum.title, text: sum.text, by: sum.own?.by || '', tags: names });
}

// Renames, merges or removes tags in every summary of the conversation, in one write.
async function retag(map) {
  const changed = [];
  for (const n of state.notes) {
    if (!n.tags?.length) continue;
    const next = [...new Set(n.tags.map((t) => (map.has(t) ? map.get(t) : t)).filter(Boolean))];
    if (next.join('\u0001') !== n.tags.join('\u0001')) {
      n.tags = next;
      changed.push(n);
    }
  }
  if (changed.length) await write('notes', (s) => changed.forEach((n) => s.put(n)));
  state.filter.tags = [...new Set(state.filter.tags.map((t) => (map.has(t) ? map.get(t) : t)).filter(Boolean))];
  linkNotes();
  return changed.length;
}

async function renameTag(tag, raw) {
  const name = cleanTagName(raw);
  if (!name || name === tag.name) return;
  const other = state.tags.find((t) => t !== tag && tagKey(t.name) === tagKey(name));
  if (other) return mergeTag(tag, other);
  const old = tag.name;
  tag.name = name;
  await saveTags();
  await retag(new Map([[old, name]]));
  render();
}

async function mergeTag(tag, into) {
  state.tags = state.tags.filter((t) => t !== tag);
  await saveTags();
  const n = await retag(new Map([[tag.name, into.name]]));
  render();
  showNotice(t('tMerged', tag.name, into.name, plural(n, 'nSummaryUpdated')));
}

async function deleteTag(tag) {
  state.tags = state.tags.filter((t) => t !== tag);
  await saveTags();
  const n = await retag(new Map([[tag.name, null]]));
  render();
  showNotice(t('tDeleted', tag.name, plural(n, 'nSummary')));
}

async function addTag(raw, kind) {
  const name = cleanTagName(raw);
  if (!name) return null;
  const existing = findTag(name);
  if (existing) return existing;
  if (state.tags.length >= MAX_TAGS) {
    showNotice(t('tListFull', MAX_TAGS), 'error');
    return null;
  }
  const tag = { name, kind, at: Date.now() };
  state.tags.push(tag);
  await saveTags();
  return tag;
}

function tagChip(name, conv) {
  const chip = el(
    'span',
    { class: `tag ${kindOf(name)}${state.filter.tags.includes(name) ? ' on' : ''}` },
    el('button', { type: 'button', class: 'tname', text: name, title: t('tSeeAll'), onclick: () => filterByTag(name) }),
  );
  if (conv) {
    chip.append(
      el(
        'button',
        { type: 'button', class: 'x', title: t('tRemoveHere'), 'aria-label': t('tRemoveName', name), onclick: () => setConvTags(conv, convTags(conv).filter((t) => t !== name)).then(() => renderMain()) },
        icon('close'),
      ),
    );
  }
  return chip;
}

function tagRow(conv) {
  const sum = state.summary.get(conv.index);
  if (!sum) return null;
  const tags = sum.tags;
  const row = el('div', { class: 'tagrow' }, tags.map((name) => tagChip(name, conv)));
  if (!tags.length && state.llm?.url && sum.own) {
    const find = el('button', { type: 'button', class: 'tag add', disabled: state.working.has(conv.id) }, icon('spark'), t('tFind'));
    find.addEventListener('click', () => tagConv(conv).catch((e) => showNotice(t('tFindFailed', e.message), 'error')));
    row.append(find);
  }
  const add = el('button', { type: 'button', class: 'tag add', title: t('tAddByHand') }, t('tAddButton'));
  add.addEventListener('click', () => {
    add.replaceWith(tagPicker(conv));
    row.querySelector('.picker input')?.focus();
  });
  row.append(add);
  return row;
}

function tagPicker(conv) {
  const current = convTags(conv);
  const input = el('input', { type: 'text', placeholder: t('tNewPlaceholder'), spellcheck: 'false' });
  let kind = 'sujet';
  const kinds = el(
    'span',
    { class: 'segmented mini' },
    TAG_KINDS.map(([k, label]) =>
      el('button', {
        type: 'button',
        class: k === kind ? 'on' : null,
        text: label,
        onclick: (event) => {
          kind = k;
          for (const b of kinds.children) b.classList.toggle('on', b === event.currentTarget);
        },
      }),
    ),
  );
  const pick = async (name) => {
    await setConvTags(conv, [...current, name]);
    renderMain();
  };
  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape') return renderMain();
    if (event.key !== 'Enter' || !input.value.trim()) return;
    const tag = await addTag(input.value, kind);
    if (tag && !current.includes(tag.name)) await pick(tag.name);
  });
  const free = state.tags.filter((t) => !current.includes(t.name));
  return el(
    'div',
    { class: 'picker' },
    free.length > 0 && el('div', { class: 'chips' }, free.map((t) => el('button', { type: 'button', class: `tag ${t.kind}`, text: t.name, onclick: () => pick(t.name) }))),
    el('div', { class: 'picker-new' }, input, kinds),
  );
}

function tagsView() {
  const counts = new Map();
  for (const conv of state.convs) for (const t of convTags(conv)) counts.set(t, (counts.get(t) || 0) + 1);
  const summarized = state.convs.filter((c) => state.summary.has(c.index));
  const tagged = summarized.filter((c) => convTags(c).length).length;
  const todo = toTag(state.convs);
  const actions = [];
  if (state.llm?.url && todo.length && !state.batch) {
    actions.push(el('button', { type: 'button', class: 'pill accent small', onclick: () => runBatch(state.convs, 'tags') }, icon('spark'), t('tFindFor', num(todo.length))));
  }
  const out = [head(t('tHeadTitle'), t('tHeadSub', num(state.tags.length), MAX_TAGS, num(tagged), num(summarized.length)), ...actions)];
  out.push(
    el('p', {
      class: 'hint',
      text: t('tHint'),
    }),
  );
  for (const [kind, label, what] of TAG_KINDS) {
    const tags = state.tags.filter((t) => t.kind === kind).sort((a, b) => (counts.get(b.name) || 0) - (counts.get(a.name) || 0) || a.name.localeCompare(b.name, LANG));
    const input = el('input', { type: 'text', placeholder: t('tAddOfKind', label.toLowerCase()), spellcheck: 'false' });
    input.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      await addTag(input.value, kind);
      renderMain();
    });
    out.push(
      el('h3', { class: 'group', text: `${label} · ${what}` }),
      el(
        'div',
        { class: 'panel taglist' },
        tags.length ? tags.map((t) => tagLine(t, counts.get(t.name) || 0)) : el('p', { class: 'muted', text: t('tNoneYet') }),
        el('div', { class: 'field' }, input),
      ),
    );
  }
  return out;
}

function tagLine(tag, count) {
  const line = el('div', { class: 'tagline' });
  const show = () => {
    const rename = el('button', { type: 'button', class: 'pill small', text: t('rename') });
    const merge = el('button', { type: 'button', class: 'pill small', text: t('tMergeInto') });
    const move = el('button', { type: 'button', class: 'pill small', text: t(tag.kind === 'sujet' ? 'tToMood' : 'tToTopic') });
    const del = el('button', { type: 'button', class: 'pill small danger', text: t('delete') });
    rename.addEventListener('click', () => {
      const input = el('input', { type: 'text', spellcheck: 'false' });
      input.value = tag.name;
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') renameTag(tag, input.value);
        if (event.key === 'Escape') show();
      });
      line.replaceChildren(input, el('button', { type: 'button', class: 'pill small accent', text: t('save'), onclick: () => renameTag(tag, input.value) }), el('button', { type: 'button', class: 'pill small', text: t('cancel'), onclick: show }));
      input.focus();
      input.select();
    });
    merge.addEventListener('click', () => {
      const others = state.tags.filter((t) => t !== tag);
      line.replaceChildren(
        el('span', { class: 'flabel', text: t('tBecomes', tag.name) }),
        el('div', { class: 'chips' }, others.map((t) => el('button', { type: 'button', class: `tag ${t.kind}`, text: t.name, onclick: () => mergeTag(tag, t) }))),
        el('button', { type: 'button', class: 'pill small', text: t('cancel'), onclick: show }),
      );
    });
    move.addEventListener('click', async () => {
      tag.kind = tag.kind === 'sujet' ? 'ambiance' : 'sujet';
      await saveTags();
      renderMain();
    });
    del.addEventListener('click', () => {
      if (del.dataset.sure) return deleteTag(tag);
      del.dataset.sure = '1';
      del.textContent = count ? t('tYesRemove', num(count)) : t('tYesDelete');
    });
    line.replaceChildren(
      el('button', { type: 'button', class: `tag ${tag.kind}`, text: tag.name, title: t('tSeeThese'), onclick: () => filterByTag(tag.name) }),
      el('span', { class: 'muted tcount', text: plural(count, 'nConv') }),
      el('span', { class: 'grow' }),
      rename,
      merge,
      move,
      del,
    );
  };
  show();
  return line;
}

