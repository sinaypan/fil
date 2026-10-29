'use strict';
// Fil: Constants, icons, formats, the shared state and small helpers.

// Fil: reads a Messenger export (end-to-end encrypted chats, JSON), keeps it
// in IndexedDB, merges later exports into it, cuts it into conversations
// (a silence longer than the chosen gap starts a new one) and summarises
// each conversation with any OpenAI-compatible service.

const GAP_TIME = 30 * 60e3; // a time separator inside a conversation after 30 minutes of silence
const GAP_GROUP = 5 * 60e3; // bubbles closer than 5 minutes stick together
const GAP_CHOICES = [30, 60, 120, 180]; // minutes of silence that end a conversation
const DEFAULT_GAP = 60;
const RANGE_JOIN = 24 * 3600e3; // two exports less than a day apart are one stretch: the gap is just silence
const MIN_TEXTS = 4; // shorter conversations are skipped by "summarise all"
const PARALLEL = 3;
const CONTEXT_BEFORE = 3; // summaries of the previous conversations sent as context
const TIMEOUT = 120e3;

const ICONS = {
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z M16 16l4.5 4.5',
  close: 'M7 7l10 10 M17 7L7 17',
  bubble: 'M7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6.5l-4 3.5V16H7a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 7 4z',
  star: 'M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z',
  doc: 'M7.5 3.5h9a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z M9.5 8h5 M9.5 11.5h5 M9.5 15h3',
  import: 'M12 4v10 M8 10l4 4 4-4 M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15',
  save: 'M12 14V4 M8 8l4-4 4 4 M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15',
  prev: 'M14.5 6l-6 6 6 6',
  next: 'M9.5 6l6 6-6 6',
  copy: 'M9.5 9h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z M15 9V6.5a1 1 0 0 0-1-1H6.5a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1H8.5',
  check: 'M5.5 12.5l4 4 9-9',
  photo: 'M5.5 6h13a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M4.5 15l4-4 3.5 3.5 2.5-2.5 5 5 M15 9.5h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  undo: 'M9 7L5 11l4 4 M5 11h9a5 5 0 0 1 0 10h-2',
  funnel: 'M4.5 5.5h15l-5.75 7v5.25l-3.5 1.75v-7z',
  chart: 'M5 19v-7 M10 19V5 M15 19v-5 M20 19V9 M3.5 19.5h17',
  person: 'M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5z M5 20a7 7 0 0 1 14 0',
  scissors: 'M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M8.6 8.2L19 17 M8.6 15.8L19 7',
  merge: 'M7 4v4a5 5 0 0 0 5 5 5 5 0 0 1 5 5v2 M17 4v4a5 5 0 0 1-3 4.6 M4 17l3 3 3-3',
  graph: 'M12 12m-2.2 0a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0 M5.5 6.5m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0 M18.5 7m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0 M17 18.5m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0 M7 8l3.4 2.6 M16.9 8.2l-3.2 2.6 M13.6 13.6l2.2 3.2',
  sliders: 'M4 7h9 M17 7h3 M15 5v4 M4 17h3 M11 17h9 M9 15v4',
  frise: 'M3.5 12h17 M7 8.5v7 M11 6v12 M15 9v6 M18.5 10.5v3',
  spark: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
};

// La langue de Chrome : dates, nombres et textes (i18n.js fournit t, tp et plurals).
const LANG = chrome.i18n.getUILanguage();
// Le nom de cette langue, dans cette langue, pour demander au LLM de répondre ainsi.
const LANG_NAME = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(LANG) || 'English';
  } catch {
    return 'English';
  }
})();

// "09:05" where hours go to 23, "9:05 AM" where they go to 12.
const HOUR = new Intl.DateTimeFormat(LANG, { hour: 'numeric' }).resolvedOptions().hour12 ? 'numeric' : '2-digit';
const fmt = {
  time: new Intl.DateTimeFormat(LANG, { hour: HOUR, minute: '2-digit' }),
  dayMid: new Intl.DateTimeFormat(LANG, { weekday: 'short', day: 'numeric', month: 'short' }),
  dayLong: new Intl.DateTimeFormat(LANG, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  month: new Intl.DateTimeFormat(LANG, { month: 'long', year: 'numeric' }),
  date: new Intl.DateTimeFormat(LANG, { day: 'numeric', month: 'short', year: 'numeric' }),
  dayMonth: new Intl.DateTimeFormat(LANG, { day: 'numeric', month: 'short' }),
  monthShort: new Intl.DateTimeFormat(LANG, { month: 'short' }),
  full: new Intl.DateTimeFormat(LANG, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: HOUR, minute: '2-digit' }),
  hour: new Intl.DateTimeFormat(LANG, { hour: 'numeric' }),
};
// Day names from Monday, in the interface language ('narrow' = one letter, 'short').
const weekdays = (style) => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(LANG, { weekday: style }).format(new Date(2024, 0, 1 + i)));
const hourText = (h) => fmt.hour.format(new Date(2024, 0, 1, h));

const state = {
  db: null,
  threads: [],
  thread: null,
  gap: DEFAULT_GAP,
  llm: null, // { url, model, key }
  convs: [],
  notes: [], // summary records of the thread
  noteLinks: new Map(), // conversation index -> overlapping summary records
  summary: new Map(), // conversation index -> what to show: { status, kind, own, parts, title, text }
  stars: new Map(), // message id -> star record
  view: 'fil', // fil | favoris | resumes | reglages
  conv: 0,
  query: '',
  exact: false,
  who: null,
  folded: null, // { exact: string[], loose: string[] }, built on the first search
  nodes: new Map(), // message id -> rendered row of the open conversation
  working: new Set(), // conversation ids being summarised
  batch: null,
  mode: 'resume', // what a conversation shows first: resume | messages
  writing: null, // conversation whose empty summary is being written by hand
  span: 365, // days shown on the timeline (0: only what is imported)
  sel: null, // { from, to } chosen on the timeline
  zoom: null, // { from, to } shown by the timeline when zoomed in
  searchSort: 'score',
  searchLimit: 60,
  answer: null, // last answer of "Demander à Fil": { query, thread, text }
  asking: false,
  pending: null, // an export waiting for confirmation
  dragging: false,
  cuts: { merge: [], split: [], llm: {} }, // corrections of the cut, see cuts.js
  chapters: new Map(), // key -> chapter of a week or a month
  memory: new Map(), // key -> what a month left to remember (facts, people, places)
  factsDone: new Map(), // fact id -> when it was ticked
  asks: new Map(), // key -> question asked and its answer
  resView: 'convs',
  exportOpen: false,
  factType: 'all',
  showDone: false,
  portrait: null, // last portrait of both people, see stats.js
  portraitBusy: false,
  tags: [], // { name, kind: sujet | ambiance } of the open conversation thread
  filter: { from: null, to: null, tags: [], any: false, status: 'all', min: 0, sort: 'old' },
  calendar: null, // which date of the filter is being picked: from | to
  calMonth: null,
  calFor: null,
  // Several people and platforms (people.js, home.js)
  screen: 'home', // home | person | thread
  homeTab: 'people',
  person: null, // id of the person whose page is open
  back: 'home', // where the back button of a thread goes: home, or a person id
  people: new Map(),
  owner: new Map(), // identity -> person id
  meIds: new Set(), // identities that are you
  pendingImports: [], // exports waiting for "which name is yours" or "which platform"
  home: null, // what the home screen knows about each thread, without messages
  life: new Map(), // month key -> page of "Ma vie"
  moodSlots: null,
  suggestionList: null,
  suggestionsOff: null,
  linking: false,
};

const $ = (selector) => document.querySelector(selector);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (n) => n.toLocaleString(LANG);
const percent = (share) => new Intl.NumberFormat(LANG, { style: 'percent', maximumFractionDigits: 0 }).format(share);
const NOT_FIRST = new Set(['le', 'la', 'les', "l'", 'el', 'al', 'the', 'mr', 'mme', 'mrs', 'ms', 'dr', 'de', 'du', 'my', 'ma', 'mon']);
const firstName = (name) => {
  const words = String(name || '?').split(' ');
  return words.length > 1 && (NOT_FIRST.has(words[0].toLowerCase()) || words[0].length < 2) ? `${words[0]} ${words[1]}` : words[0];
};
// "3 messages" dans la langue de Chrome : clés <clé>_one, _other…, le nombre formaté en $1.
const plural = (n, key, ...subs) =>
  chrome.i18n.getMessage(`${key}_${plurals.select(n)}`, [num(n), ...subs].map(String)) || chrome.i18n.getMessage(`${key}_other`, [num(n), ...subs].map(String));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function duration(ms) {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 60) return t('durMin', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return t('durDays', Math.round(hours / 24));
  const rest = minutes % 60;
  return rest && hours < 10 ? t('durHoursMin', hours, String(rest).padStart(2, '0')) : t('durHours', hours);
}

