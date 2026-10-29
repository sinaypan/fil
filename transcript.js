'use strict';
// Fil: Transcripts and copies for a LLM.

/* ---------- Texts for a LLM ---------- */

function transcriptLines(conv) {
  const messages = convMessages(conv);
  const lines = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let count = 1;
    if (isMedia(m)) {
      while (i + 1 < messages.length && isMedia(messages[i + 1]) && messages[i + 1].ts === m.ts && messages[i + 1].from === m.from) {
        i++;
        count++;
      }
    }
    let content;
    if (m.unsent || m.type === 'placeholder') content = t('trRemoved');
    else if (isMedia(m)) content = count > 1 ? t('trMedias', count) : t('trMedia');
    else if (m.type === 'link' && !m.text) content = t('trLink');
    else content = m.text.replace(/\s*\n\s*/g, ' / ');
    lines.push(t('trLine', fmt.time.format(m.ts), shortName(m.from), content));
  }
  return lines;
}

function allNotes(convs) {
  return convs
    .map((c) => {
      const sum = state.summary.get(c.index);
      return `## ${convLabel(c)}${sum.title ? ` — ${sum.title}` : ''}${sum.tags.length ? `\n${t('trTags', sum.tags.join(', '))}` : ''}\n${sum.text.trim()}`;
    })
    .join('\n\n');
}

async function copyText(text, button, done) {
  const label = [...button.childNodes];
  try {
    await navigator.clipboard.writeText(text);
    button.replaceChildren(icon('check'), done);
    setTimeout(() => button.replaceChildren(...label), 1600);
  } catch (e) {
    showNotice(t('copyFailed', e.message), 'error');
  }
}

