'use strict';

const EMERGENCY = {
  RU: {
    title: 'Россия',
    primary: ['112'],
    extra: [
      { label: 'Скорая', number: '103' },
      { label: 'Полиция', number: '102' },
      { label: 'Пожарные/спасатели', number: '101' }
    ]
  },
  UA: {
    title: 'Украина',
    primary: ['112'],
    extra: [
      { label: 'Скорая', number: '103' },
      { label: 'Полиция', number: '102' },
      { label: 'Пожарные/спасатели', number: '101' }
    ]
  },
  KZ: {
    title: 'Казахстан',
    primary: ['112'],
    extra: [
      { label: 'Скорая', number: '103' },
      { label: 'Полиция', number: '102' },
      { label: 'Пожарные/спасатели', number: '101' }
    ]
  },
  BY: {
    title: 'Беларусь',
    primary: ['112'],
    extra: [
      { label: 'Скорая', number: '103' },
      { label: 'Полиция', number: '102' },
      { label: 'Пожарные/спасатели', number: '101' }
    ]
  },
  EU: {
    title: 'Европа / ЕС',
    primary: ['112'],
    extra: []
  },
  UK: {
    title: 'Великобритания',
    primary: ['999', '112'],
    extra: []
  },
  US_CA: {
    title: 'США / Канада',
    primary: ['911'],
    extra: []
  },
  AU: {
    title: 'Австралия',
    primary: ['000', '112'],
    extra: []
  },
  NZ: {
    title: 'Новая Зеландия',
    primary: ['111'],
    extra: []
  }
};

function formatEmergencyText(countryCode) {
  const c = EMERGENCY[countryCode] || null;

  const lines = [];
  lines.push('Если состояние тяжёлое — лучше обратиться к живому человеку.');
  lines.push('');
  lines.push('Экстренная помощь:');

  if (c) {
    lines.push(`— ${c.title}: ${c.primary.join(' / ')}`);
    for (const x of c.extra) lines.push(`— ${x.label}: ${x.number}`);
  } else {
    lines.push('— Если ты в Европе: 112');
    lines.push('— Если ты в США/Канаде: 911');
    lines.push('— Если не уверена: набери местный номер экстренных служб или 112/911 (в зависимости от страны)');
  }

  lines.push('');
  lines.push('Если скажешь страну — я покажу точные номера для твоего региона.');

  return lines.join('\n');
}

module.exports = {
  EMERGENCY,
  formatEmergencyText
};
