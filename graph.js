'use strict';
// Fil: the graph of your people. You in the middle; the people you talk with;
// the groups they are in; and the people and places mentioned in your
// conversations (from "À retenir"), tied to the conversations they come from.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v);
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function graphData() {
  const opts = state.graphOpts || (state.graphOpts = { groups: true, mentions: true });
  const nodes = new Map();
  const edges = [];
  const add = (id, data) => {
    if (!nodes.has(id)) nodes.set(id, { id, weight: 0, ...data });
    return nodes.get(id);
  };
  const me = state.people.get('me');
  add('me', { kind: 'me', label: me?.name ? firstName(me.name) : t('meName'), weight: 1 });
  const nameKey = new Map();
  for (const p of state.people.values()) {
    if (p.me) continue;
    const s = personStats(p);
    if (!s.duos.length && !s.groups.length) continue;
    if (!s.duos.length && !opts.groups) continue;
    const n = add(p.id, { kind: 'person', label: p.name, person: p, stats: s });
    n.weight = s.exchanged + s.written;
    if (s.duos.length) edges.push({ a: 'me', b: p.id, w: s.exchanged, kind: 'duo' });
    nameKey.set(tagKey(p.name), p.id);
    for (const id of p.ids) nameKey.set(tagKey(identityName(id)), p.id);
  }
  if (opts.groups) {
    for (const t of state.threads.filter((x) => x.kind === 'group')) {
      const g = add(`g:${t.id}`, { kind: 'group', label: titleOf(t), thread: t, weight: t.count });
      edges.push({ a: 'me', b: g.id, w: t.per?.[t.me] || 1, kind: 'member' });
      for (const name of t.participants) {
        if (name === t.me) continue;
        const pid = state.owner.get(identity(t.platform, name));
        if (pid && nodes.has(pid)) edges.push({ a: pid, b: g.id, w: t.per?.[name] || 1, kind: 'member' });
      }
    }
  }
  if (opts.mentions && state.home) {
    // A mentioned name is tied to the person (duo) or the group whose conversations mention it.
    const mentions = new Map();
    for (const t of state.threads) {
      const target = t.kind === 'group' ? `g:${t.id}` : state.owner.get(identity(t.platform, t.participants.find((n) => n !== t.me) || ''));
      for (const e of homeOf(t.id).entities) {
        const key = tagKey(e.name);
        const person = nameKey.get(key);
        const id = person || `e:${key}`;
        const item = mentions.get(id) || { id, name: e.name, kind: e.kind, about: e.about, person, links: new Map(), where: [] };
        if (e.about) item.about = e.about;
        item.links.set(target, (item.links.get(target) || 0) + (e.ts?.length || 1));
        item.where.push({ thread: t, ts: e.ts?.[0] ?? t.last, about: e.about });
        mentions.set(id, item);
      }
    }
    const ranked = [...mentions.values()].sort((a, b) => sumOf(b.links) - sumOf(a.links)).slice(0, 60);
    for (const m of ranked) {
      if (!m.person) add(m.id, { kind: m.kind === 'lieu' ? 'place' : 'mention', label: m.name, mention: m, weight: sumOf(m.links) });
      else if (nodes.has(m.person)) nodes.get(m.person).mention = m;
      for (const [target, w] of m.links) if (target && nodes.has(target) && target !== (m.person || m.id)) edges.push({ a: target, b: m.person || m.id, w, kind: 'mention' });
    }
  }
  return { nodes: [...nodes.values()], edges: edges.filter((e) => nodes.has(e.a) && nodes.has(e.b)) };
}

const sumOf = (map) => [...map.values()].reduce((a, b) => a + b, 0);

// A small force layout: nodes push each other away, links pull, you stay in the middle.
function layout(nodes, edges, w, h) {
  const key = nodes.map((n) => n.id).join(',') + '|' + edges.length;
  if (state.graphLayout?.key === key) return state.graphLayout.pos;
  const pos = new Map();
  const old = state.graphLayout?.pos;
  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2;
    const r = n.kind === 'person' ? 180 : n.kind === 'group' ? 260 : 330;
    pos.set(n.id, old?.get(n.id) ? { ...old.get(n.id) } : n.id === 'me' ? { x: w / 2, y: h / 2 } : { x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r * 0.7 });
  });
  const list = nodes.map((n) => pos.get(n.id));
  const maxW = Math.max(1, ...edges.map((e) => e.w));
  for (let step = 0; step < 260; step++) {
    const cool = 1 - step / 260;
    const force = list.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        let dx = list[i].x - list[j].x;
        let dy = list[i].y - list[j].y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const f = 9000 / d2;
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        force[i].x += dx * f;
        force[i].y += dy * f;
        force[j].x -= dx * f;
        force[j].y -= dy * f;
      }
    }
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    for (const e of edges) {
      const i = index.get(e.a);
      const j = index.get(e.b);
      const dx = list[j].x - list[i].x;
      const dy = list[j].y - list[i].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = e.kind === 'duo' ? 190 - 70 * Math.sqrt(e.w / maxW) : e.kind === 'member' ? 150 : 120;
      const f = (d - rest) * 0.02;
      force[i].x += (dx / d) * f;
      force[i].y += (dy / d) * f;
      force[j].x -= (dx / d) * f;
      force[j].y -= (dy / d) * f;
    }
    list.forEach((p, i) => {
      if (nodes[i].id === 'me') return;
      force[i].x += (w / 2 - p.x) * 0.002;
      force[i].y += (h / 2 - p.y) * 0.004;
      const cap = 14 * cool + 0.5;
      p.x += Math.max(-cap, Math.min(cap, force[i].x));
      p.y += Math.max(-cap, Math.min(cap, force[i].y));
    });
  }
  state.graphLayout = { key, pos };
  return pos;
}

function nodeRadius(n, max) {
  if (n.kind === 'me') return 18;
  const base = n.kind === 'person' ? 7 : n.kind === 'group' ? 6 : 4;
  return base + 14 * Math.sqrt(n.weight / Math.max(1, max));
}

function graphView() {
  if (!state.home) return el('p', { class: 'edge', text: 'Chargement…' });
  const opts = state.graphOpts || (state.graphOpts = { groups: true, mentions: true });
  const { nodes, edges } = graphData();
  const W = 900;
  const H = 560;
  const pos = layout(nodes, edges, W, H);
  const maxBy = (kind) => Math.max(1, ...nodes.filter((n) => n.kind === kind).map((n) => n.weight));
  const neighbours = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    neighbours.get(e.a).add(e.b);
    neighbours.get(e.b).add(e.a);
  }
  const view = state.graphView || (state.graphView = { x: 0, y: 0, k: 1 });
  const world = svgEl('g', { transform: `translate(${view.x} ${view.y}) scale(${view.k})` });
  const lines = svgEl('g', { class: 'g-edges' });
  const dots = svgEl('g', { class: 'g-nodes' });
  const maxEdge = Math.max(1, ...edges.map((e) => e.w));
  const edgeEls = edges.map((e) => {
    const a = pos.get(e.a);
    const b = pos.get(e.b);
    const line = svgEl('line', { x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1), class: `g-edge ${e.kind}`, 'stroke-width': (0.8 + 3 * Math.sqrt(e.w / maxEdge)).toFixed(2) });
    line.dataset.a = e.a;
    line.dataset.b = e.b;
    lines.append(line);
    return line;
  });
  const nodeEls = new Map();
  const placed = [];
  const labelled = new Set();
  for (const n of [...nodes].sort((a, b) => (a.kind === 'me' ? -1 : b.kind === 'me' ? 1 : b.weight / maxBy(b.kind) - a.weight / maxBy(a.kind)))) {
    const p = pos.get(n.id);
    const r = nodeRadius(n, maxBy(n.kind));
    const name = n.kind === 'person' ? firstName(n.label) : n.label;
    const box = { x1: p.x - name.length * 3.4, x2: p.x + name.length * 3.4, y1: p.y + r + 1, y2: p.y + r + 15 };
    if (placed.some((q) => box.x1 < q.x2 && box.x2 > q.x1 && box.y1 < q.y2 && box.y2 > q.y1)) continue;
    placed.push(box);
    labelled.add(n.id);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const r = nodeRadius(n, maxBy(n.kind));
    const shape =
      n.kind === 'group'
        ? svgEl('rect', { x: (p.x - r).toFixed(1), y: (p.y - r).toFixed(1), width: (2 * r).toFixed(1), height: (2 * r).toFixed(1), rx: 4 })
        : svgEl('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: r.toFixed(1) });
    const big = labelled.has(n.id);
    const label = svgEl('text', { x: p.x.toFixed(1), y: (p.y + r + 12).toFixed(1), class: `g-label${big ? '' : ' small'}` });
    label.textContent = n.kind === 'person' ? firstName(n.label) : n.label;
    const g = svgEl('g', { class: `g-node ${n.kind}${n.mention && n.kind === 'person' ? ' cited' : ''}`, tabindex: 0 }, shape, label);
    g.dataset.id = n.id;
    dots.append(g);
    nodeEls.set(n.id, g);
  }
  world.append(lines, dots);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'graph' }, world);
  const readout = el('p', { class: 'readout muted', text: t('grHint') });
  const panel = el('div', { class: 'graphpanel' });

  const describe = (n) => {
    if (n.kind === 'me') return t('grYou', plural(neighbours.get('me').size, 'nLink'));
    if (n.kind === 'person') return `${n.label} · ${n.stats.duos.length ? plural(n.stats.exchanged, 'nMsgDuo') : t('grNoDuo')}${n.stats.groups.length ? t('grInCommon', plural(n.stats.groups.length, 'nGroup')) : ''}${n.mention ? `${t('grCited')}${n.mention.about ? ` (${n.mention.about})` : ''}` : ''}`;
    if (n.kind === 'group') return t('grGroup', n.label, plural(n.thread.count, 'nMessage'), plural(n.thread.participants.length, 'nMember'));
    return `${n.label}${n.mention.about ? ` · ${n.mention.about}` : ''}${t('grCitedTimes', plural(n.weight, 'nTimes'), plural(n.mention.where.length, 'nMonth'))}`;
  };
  const focus = (id) => {
    const near = id ? neighbours.get(id) : null;
    svg.classList.toggle('focused', !!id);
    for (const [nid, g] of nodeEls) g.classList.toggle('on', !!id && (nid === id || near.has(nid)));
    for (const line of edgeEls) line.classList.toggle('on', !!id && (line.dataset.a === id || line.dataset.b === id));
    if (!id) {
      readout.textContent = t('grHint');
      readout.classList.add('muted');
    } else {
      readout.textContent = describe(nodes.find((n) => n.id === id));
      readout.classList.remove('muted');
    }
  };
  svg.addEventListener('pointerover', (e) => focus(e.target.closest('.g-node')?.dataset.id || null));
  svg.addEventListener('pointerleave', () => focus(null));
  const open = (id) => {
    const n = nodes.find((x) => x.id === id);
    if (!n || n.kind === 'me') return;
    if (n.kind === 'person') return openPerson(n.person.id, { direct: false });
    if (n.kind === 'group') return openThread(n.thread.id, { back: 'home' });
    // A mentioned name: where it comes from.
    panel.replaceChildren(
      el('p', {}, el('b', { text: n.label }), n.mention.about && el('span', { class: 'muted', text: ` · ${n.mention.about}` })),
      el(
        'div',
        { class: 'factlist' },
        n.mention.where.slice(0, 12).map((w) => el('button', { type: 'button', class: 'factline', onclick: () => openThread(w.thread.id, { back: 'home', conv: w.ts, find: n.label }) }, el('span', { text: t('grCitedWith', titleOf(w.thread)) }), w.about && el('span', { class: 'muted', text: ` · ${w.about}` }), el('span', { class: 'grow' }), platformBadge(w.thread.platform))),
      ),
    );
  };
  // Pan by dragging, zoom with the wheel; a click without moving opens.
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, target: e.target.closest('.g-node')?.dataset.id };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const scale = W / svg.getBoundingClientRect().width;
    const dx = (e.clientX - drag.x) * scale;
    const dy = (e.clientY - drag.y) * scale;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    world.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  });
  svg.addEventListener('pointerup', () => {
    if (drag && !drag.moved && drag.target) open(drag.target);
    drag = null;
  });
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * W;
      const my = ((e.clientY - r.top) / r.height) * H;
      const k = Math.max(0.4, Math.min(4, view.k * Math.exp(-e.deltaY / 400)));
      view.x = mx - ((mx - view.x) * k) / view.k;
      view.y = my - ((my - view.y) * k) / view.k;
      view.k = k;
      world.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    },
    { passive: false },
  );
  const counts = {
    person: nodes.filter((n) => n.kind === 'person').length,
    group: nodes.filter((n) => n.kind === 'group').length,
    mention: nodes.filter((n) => n.kind === 'mention' || n.kind === 'place').length,
  };
  return [
    el(
      'div',
      { class: 'toolbar' },
      switchControl(t('htGroups'), opts.groups, () => ((opts.groups = !opts.groups), (state.graphLayout = null), render())),
      switchControl(t('grMentions'), opts.mentions, () => ((opts.mentions = !opts.mentions), (state.graphLayout = null), render())),
      el('button', { type: 'button', class: 'pill small', text: t('grRecenter'), onclick: () => ((state.graphView = { x: 0, y: 0, k: 1 }), render()) }),
      el('span', { class: 'grow' }),
      el(
        'div',
        { class: 'legend' },
        el('span', {}, el('i', { class: 'k g-me' }), t('grLegendYou')),
        el('span', {}, el('i', { class: 'k g-person' }), t('grLegendPeople', num(counts.person))),
        opts.groups && el('span', {}, el('i', { class: 'k g-group' }), t('grLegendGroups', num(counts.group))),
        opts.mentions && el('span', {}, el('i', { class: 'k g-mention' }), t('grLegendCited', num(counts.mention))),
      ),
    ),
    el('div', { class: 'graphbox' }, svg),
    readout,
    panel,
    !state.home.memory.length && el('p', { class: 'hint', text: t('grNoMentions') }),
  ];
}
