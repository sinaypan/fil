'use strict';
// Fil: people. A name on a platform is an identity ("whatsapp|Bestie"); a person
// gathers one or several identities (the same friend on Messenger and WhatsApp).
// The person "me" gathers the names of the owner of the exports.

const identity = (platform, name) => `${platform}|${name}`;
const identityName = (id) => id.slice(id.indexOf('|') + 1);
const identityPlatform = (id) => id.slice(0, id.indexOf('|'));

async function syncPeople() {
  const stored = await getAll('people');
  state.people = new Map(stored.map((p) => [p.id, p]));
  const me = state.people.get('me') || { id: 'me', name: '', ids: [], me: true };
  const saved = (await getOne('prefs', 'me'))?.ids || [];
  for (const id of [...saved, ...state.meIds]) if (!me.ids.includes(id)) me.ids.push(id);
  state.people.set('me', me);
  const owner = new Map();
  for (const p of state.people.values()) for (const id of p.ids) owner.set(id, p.id);
  const changed = new Set();
  for (const t of state.threads) {
    if (t.me) {
      const id = identity(t.platform, t.me);
      if (owner.get(id) !== 'me') {
        // A name first taken for someone else, now known to be yours.
        const other = owner.get(id) && state.people.get(owner.get(id));
        if (other) {
          other.ids = other.ids.filter((x) => x !== id);
          if (other.ids.length) changed.add(other.id);
          else {
            state.people.delete(other.id);
            await remove('people', other.id);
          }
        }
        me.ids.push(id);
        owner.set(id, 'me');
        changed.add('me');
      }
      if (!me.name) {
        me.name = t.me;
        changed.add('me');
      }
    }
    for (const name of t.participants) {
      const id = identity(t.platform, name);
      if (owner.has(id)) continue;
      let pid = `p${hash(id)}`;
      while (state.people.has(pid)) pid += 'x';
      state.people.set(pid, { id: pid, name, ids: [id] });
      owner.set(id, pid);
      changed.add(pid);
    }
  }
  state.owner = owner;
  state.meIds = new Set(me.ids);
  for (const id of changed) if (state.people.has(id)) await put('people', state.people.get(id));
  await put('prefs', { k: 'me', ids: me.ids });
  state.suggestionList = null; // new people: "same person?" is worked out again
}

const personOf = (platform, name) => state.people.get(state.owner.get(identity(platform, name)));
const displayName = (platform, name) => (state.owner?.size ? personOf(platform, name)?.name || name : name);

// The threads a person is in: duos with you, and groups.
function threadsOf(person) {
  const ids = new Set(person.ids);
  const duos = [];
  const groups = [];
  for (const t of state.threads) {
    const inside = t.participants.some((n) => n !== t.me && ids.has(identity(t.platform, n)));
    if (!inside) continue;
    (t.kind === 'group' ? groups : duos).push(t);
  }
  return { duos, groups };
}

// Messages this person wrote, in duos and in groups.
function messagesOf(person, threads) {
  const ids = new Set(person.ids);
  let n = 0;
  for (const t of threads) for (const [name, count] of Object.entries(t.per || {})) if (ids.has(identity(t.platform, name))) n += count;
  return n;
}

async function renamePerson(person, name) {
  const clean = name.trim();
  if (!clean || clean === person.name) return;
  person.name = clean;
  await put('people', person);
  render();
}

// Merges b into a: one person, all the identities of both.
async function linkPeople(a, b) {
  if (a.id === b.id || b.me) return;
  a.ids = [...new Set([...a.ids, ...b.ids])];
  state.people.delete(b.id);
  await remove('people', b.id);
  await put('people', a);
  for (const id of b.ids) state.owner.set(id, a.id);
  state.suggestionsOff = null;
  render();
  showNotice(t('nowLinked', b.name, a.name));
}

async function unlinkIdentity(person, id) {
  if (person.ids.length < 2) return;
  person.ids = person.ids.filter((x) => x !== id);
  let pid = `p${hash(id)}`;
  while (state.people.has(pid)) pid += 'x';
  const other = { id: pid, name: identityName(id), ids: [id] };
  state.people.set(pid, other);
  state.owner.set(id, pid);
  await put('people', person);
  await put('people', other);
  render();
}

// "Same person?": same name on two identities, or the same first name on two platforms.
async function suggestions() {
  const off = state.suggestionsOff || new Set((await getOne('prefs', 'nolink'))?.pairs || []);
  state.suggestionsOff = off;
  const people = [...state.people.values()].filter((p) => !p.me);
  const out = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i];
      const b = people[j];
      const pair = [a.id, b.id].sort().join('|');
      if (off.has(pair)) continue;
      const pa = new Set(a.ids.map(identityPlatform));
      const pb = new Set(b.ids.map(identityPlatform));
      const samePlatformOnly = [...pa].every((x) => pb.has(x)) && [...pb].every((x) => pa.has(x));
      const full = tagKey(a.name) === tagKey(b.name);
      const first = tagKey(firstName(a.name)) === tagKey(firstName(b.name)) && tagKey(firstName(a.name)).length > 2;
      if (full || (first && !samePlatformOnly)) out.push({ a, b, pair, strong: full });
    }
  }
  return out.sort((x, y) => Number(y.strong) - Number(x.strong));
}

async function dismissSuggestion(pair) {
  state.suggestionsOff.add(pair);
  await put('prefs', { k: 'nolink', pairs: [...state.suggestionsOff] });
  render();
}

// Two people sharing a first name in a thread are told apart by their full name.
function shortName(name) {
  const first = firstName(name);
  const list = state.thread?.participants || [];
  return list.some((p) => p !== name && firstName(p) === first) ? name : first;
}
