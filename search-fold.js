'use strict';
// Fil: Text folding for search (darja written in Latin letters).

/* ---------- Search ---------- */

const LETTER = /\p{L}/u;
const MARK = /\p{M}/gu;
const SYMBOL = /[^\p{L}\p{N}]/u;
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
const DIGIT_SOUND = { 2: '', 3: '', 5: 'kh', 7: 'h', 8: 'gh', 9: 'k' };

// Turns a text into a search form and keeps, for each output character, the
// index of the original one (to highlight what matched).
// Exact form: lower case, no accents.
// Loose form, for darja written in latin letters: vowels dropped (khedma = khdma),
// letters doubled for emphasis count once (wesh = weshhh), sh = ch, dj = j,
// q = k, and the digits used as letters read as sounds (3, 7, 9, 5, 8, 2).
function fold(text, loose) {
  const out = [];
  const map = [];
  const push = (ch, i) => {
    const last = out[out.length - 1];
    if (loose) {
      if (ch === last && map[map.length - 1] === i - 1 && ch !== ' ') {
        map[map.length - 1] = i;
        return;
      }
      if (ch === 'h' && last === 's') out[out.length - 1] = 'c';
      if (ch === 'j' && last === 'd') {
        out[out.length - 1] = 'j';
        map[map.length - 1] = i;
        return;
      }
    }
    out.push(ch);
    map.push(i);
  };
  for (let i = 0; i < text.length; i++) {
    for (const ch of text[i].toLowerCase().normalize('NFD').replace(MARK, '')) {
      if (loose) {
        if (ch in DIGIT_SOUND && (LETTER.test(text[i - 1] || '') || LETTER.test(text[i + 1] || ''))) {
          for (const s of DIGIT_SOUND[ch]) push(s, i);
          continue;
        }
        if (VOWELS.has(ch)) continue;
        if (ch === 'q') {
          push('k', i);
          continue;
        }
        if (/\s/.test(ch)) {
          if (out.length && out[out.length - 1] !== ' ') push(' ', i);
          continue;
        }
        if (SYMBOL.test(ch)) continue;
      }
      push(ch, i);
    }
  }
  return { s: out.join(''), map };
}

function folded() {
  if (!state.folded) {
    const messages = state.thread.messages;
    state.folded = {
      exact: messages.map((m) => fold(m.text, false).s),
      loose: messages.map((m) => fold(m.text, true).s),
    };
  }
  return state.folded;
}

