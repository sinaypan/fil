'use strict';
// Fil: export of what was written (chapters, summaries, À retenir, index) as a
// Word file built here (a .docx is a zip of a few XML files) or as a PDF through
// Chrome's print preview. Nothing leaves the PC.

const EXPORT_PARTS = [
  ['months', t('months')],
  ['weeks', t('weeks')],
  ['convs', t('conversations')],
  ['facts', t('toRemember')],
  ['index', t('peoplePlaces')],
];

const exportRange = (f, key) => t(key, f.from != null ? fmt.date.format(f.from) : t('exStart'), f.to != null ? fmt.date.format(f.to) : t('exToday'));

function exportPanel() {
  state.exportParts ||= new Set(['months', 'convs', 'facts']);
  state.exportFormat ||= 'docx';
  const parts = state.exportParts;
  const f = state.filter;
  const scope = f.from != null || f.to != null ? exportRange(f, 'exFromTo') : t('exWhole');
  return el(
    'div',
    { class: 'panel exportpanel' },
    el('p', {}, el('b', { text: t('exTitle') }), el('span', { class: 'muted', text: ` · ${scope}${filterActive() ? t('exFilterOn') : ''}` })),
    el(
      'div',
      { class: 'chips' },
      EXPORT_PARTS.map(([k, label]) =>
        el('button', {
          type: 'button',
          class: `chip${parts.has(k) ? ' on' : ''}`,
          text: label,
          onclick: () => {
            if (parts.has(k)) parts.delete(k);
            else parts.add(k);
            renderMain();
          },
        }),
      ),
    ),
    el(
      'div',
      { class: 'actions' },
      el('nav', { class: 'segmented mini' }, [
        el('button', { type: 'button', class: state.exportFormat === 'docx' ? 'on' : null, text: 'Word', onclick: () => ((state.exportFormat = 'docx'), renderMain()) }),
        el('button', { type: 'button', class: state.exportFormat === 'pdf' ? 'on' : null, text: 'PDF', onclick: () => ((state.exportFormat = 'pdf'), renderMain()) }),
      ]),
      el('button', { type: 'button', class: 'pill accent small', disabled: !parts.size, onclick: runExport }, icon('save'), t(state.exportFormat === 'pdf' ? 'exOpenPdf' : 'exDownloadWord')),
    ),
    state.exportFormat === 'pdf' && el('p', { class: 'hint', text: t('exPdfHint') }),
  );
}

// The document as a list of blocks: { style: title | h1 | h2 | h3 | p | muted | bullet, text }.
function exportBlocks() {
  const parts = state.exportParts;
  const thread = state.thread;
  const blocks = [];
  const add = (style, text) => text && blocks.push({ style, text: String(text) });
  const addText = (text) => {
    for (const line of String(text).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^[-•*]\s+/.test(t)) add('bullet', t.replace(/^[-•*]\s+/, ''));
      else add('p', t);
    }
  };
  const f = state.filter;
  add('title', `Fil · ${titleOf(thread)}`);
  add('muted', `${f.from != null || f.to != null ? exportRange(f, 'exFromToCap') : t('exAll', spanText(thread))}${t('exExportedOn', fmt.date.format(Date.now()))}`);
  for (const [kind, label] of [
    ['months', t('months')],
    ['weeks', t('weeks')],
  ]) {
    if (!parts.has(kind)) continue;
    const list = periods(kind === 'months' ? 'month' : 'week').filter((p) => state.chapters.has(p.key));
    if (!list.length) continue;
    add('h1', label);
    for (const p of list) {
      const rec = state.chapters.get(p.key);
      add('h2', `${p.label}${rec.title ? ` — ${rec.title}` : ''}`);
      add('muted', rec.mood);
      addText(rec.text);
    }
  }
  if (parts.has('facts')) {
    const months = periods('month');
    const facts = months.flatMap((p) => state.memory.get(p.key)?.facts || []).filter((x) => (f.from == null || x.ts >= f.from) && (f.to == null || x.ts <= f.to));
    if (facts.length) {
      add('h1', t('toRemember'));
      for (const [type, label] of FACT_TYPES) {
        const list = facts.filter((x) => x.type === type).sort((a, b) => a.ts - b.ts);
        if (!list.length) continue;
        add('h2', label);
        for (const x of list) add('bullet', `${state.factsDone.has(x.id) ? t('exSettled') : ''}${x.text}${x.when ? ` (${x.when})` : ''} — ${cap(fmt.dayMid.format(x.ts))} ${new Date(x.ts).getFullYear()}`);
      }
    }
  }
  if (parts.has('index')) {
    const items = entityIndex();
    if (items.length) {
      add('h1', t('peoplePlaces'));
      for (const [kind, label] of ENTITY_KINDS) {
        const list = items.filter((i) => i.kind === kind).sort((a, b) => b.ts.size - a.ts.size);
        if (!list.length) continue;
        add('h2', label);
        for (const i of list) add('bullet', `${i.about ? t('exAbout', i.name, i.about) : i.name} (${plural(i.ts.size, 'nConv')})`);
      }
    }
  }
  if (parts.has('convs')) {
    const convs = visibleConvs()
      .filter((c) => state.summary.has(c.index))
      .sort((a, b) => a.from - b.from);
    if (convs.length) {
      add('h1', t('conversations'));
      let month = '';
      for (const c of convs) {
        const m = cap(fmt.month.format(c.from));
        if (m !== month) {
          month = m;
          add('h2', m);
        }
        const s = state.summary.get(c.index);
        add('h3', `${convLabel(c)}${s.title ? ` — ${s.title}` : ''}`);
        if (s.tags.length) add('muted', t('trTags', s.tags.join(', ')));
        addText(s.text);
      }
    }
  }
  return blocks;
}

function runExport() {
  const blocks = exportBlocks();
  if (blocks.length <= 2) return showNotice(t('exNothing'), 'error');
  const name = `fil-${tagKey(titleOf(state.thread)).replace(/ /g, '-')}-${new Date().toISOString().slice(0, 10)}`;
  if (state.exportFormat === 'pdf') return printBlocks(blocks);
  const link = el('a', { href: URL.createObjectURL(docx(blocks)), download: `${name}.docx` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  showNotice(t('exSaved', `${name}.docx`));
}

/* ---------- PDF: Chrome's print preview on a page made for paper ---------- */

function printBlocks(blocks) {
  const tags = { title: 'h1', h1: 'h2', h2: 'h3', h3: 'h4', p: 'p', muted: 'p', bullet: 'li' };
  const page = $('#print');
  page.replaceChildren();
  let list = null;
  for (const b of blocks) {
    if (b.style === 'bullet') {
      if (!list) page.append((list = el('ul')));
      list.append(el('li', { dir: 'auto', text: b.text }));
      continue;
    }
    list = null;
    page.append(el(tags[b.style], { class: `pr-${b.style}`, dir: 'auto', text: b.text }));
  }
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    page.replaceChildren();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/* ---------- Word: a minimal .docx ---------- */

const xmlEscape = (text) => text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function docx(blocks) {
  const style = { title: 'Title', h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', p: 'Normal', muted: 'Muted', bullet: 'Bullet' };
  const body = blocks
    .map((b) => `<w:p><w:pPr><w:pStyle w:val="${style[b.style]}"/><w:bidi w:val="0"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(b.style === 'bullet' ? `•\t${b.text}` : b.text)}</w:t></w:r></w:p>`)
    .join('');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="${LANG}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="5856D6"/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="5856D6"/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Muted"><w:name w:val="Muted"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="8E8E93"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:spacing w:after="40"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>
</w:styles>`,
  };
  const enc = new TextEncoder();
  return zip(Object.entries(files).map(([name, text]) => ({ name, data: enc.encode(text) })), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A zip without compression: enough for Word, which reads stored entries.
function zip(files, type) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, file.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + size;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type });
}
