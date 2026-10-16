import { describe, expect, it } from 'vitest';
import { checklist, descriptionWithoutChecklist, firstLine, initials, timeAgo } from './format.ts';

describe('format', () => {
  it('firstLine pega a primeira linha não vazia', () => {
    expect(firstLine('\n  oi  \nmundo')).toBe('oi');
    expect(firstLine('')).toBe('(nota vazia)');
  });
  it('initials', () => {
    expect(initials('ana.ribeiro')).toBe('AR');
    expect(initials('joao')).toBe('J');
  });
  it('checklist e descrição sem checklist', () => {
    const d = 'Texto.\n\n## Critérios de aceite\n- [ ] Um\n- [x] Dois';
    expect(checklist(d)).toEqual([
      { text: 'Um', done: false },
      { text: 'Dois', done: true },
    ]);
    expect(descriptionWithoutChecklist(d)).toBe('Texto.');
  });
  it('timeAgo em português', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(timeAgo('2026-10-14T12:00:00Z', now)).toBe('ontem');
    expect(timeAgo('2026-10-15T11:58:00Z', now)).toBe('há 2 minutos');
  });
});
