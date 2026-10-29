'use strict';
// Fil: the platforms Fil can read, and how to get an export out of each one.

const PLATFORMS = [
  {
    id: 'messenger',
    name: 'Messenger',
    letter: 'M',
    colour: '#5b5bf0',
    ready: true,
    steps: [
      t('plMsg1'),
      t('plMsg2'),
      t('plMsg3'),
    ],
    note: t('plMsgNote'),
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    letter: 'W',
    colour: '#1f9d55',
    ready: true,
    steps: [
      t('plWa1'),
      t('plWa2'),
    ],
    note: t('plWaNote'),
  },
  {
    id: 'telegram',
    name: 'Telegram',
    letter: 'T',
    colour: '#1e8fcb',
    ready: true,
    steps: [
      t('plTg1'),
      t('plTg2'),
      t('plTg3'),
    ],
    note: t('plTgNote'),
  },
  {
    id: 'instagram',
    name: 'Instagram',
    letter: 'I',
    colour: '#d6458c',
    ready: true,
    steps: [
      t('plIg1'),
      t('plIg2'),
      t('plIg3'),
    ],
    note: t('plIgNote'),
  },
  {
    id: 'discord',
    name: 'Discord',
    letter: 'D',
    colour: '#5865c8',
    ready: true,
    steps: [t('plDc1'), t('plDc2')],
    note: t('plDcNote'),
  },
  { id: 'snapchat', name: 'Snapchat', letter: 'S', colour: '#c9a400', ready: false, note: t('plSnapNote') },
  { id: 'sms', name: t('plSms'), letter: 'A', colour: '#4b8b3b', ready: false, note: t('plSmsNote') },
  { id: 'signal', name: 'Signal', letter: 'S', colour: '#3a76f0', ready: false, note: t('plNoExport') },
  { id: 'imessage', name: 'iMessage', letter: 'i', colour: '#34a853', ready: false, note: t('plNoExport') },
];

const platformOf = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];

function platformBadge(id, withName = false) {
  const p = platformOf(id);
  return el('span', { class: 'pbadge', style: `--pc:${p.colour}`, title: p.name }, el('b', { text: p.letter }), withName && p.name);
}
