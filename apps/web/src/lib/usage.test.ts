import { describe, expect, it } from 'vitest';
import { resetsIn, usageLevel } from './usage.ts';

const NOW = Date.parse('2026-10-17T15:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

describe('uso do plano', () => {
  it('cores por faixa', () => {
    expect(usageLevel(10)).toBe('ok');
    expect(usageLevel(75)).toBe('warn');
    expect(usageLevel(90)).toBe('bad');
  });

  it('quanto falta para zerar', () => {
    expect(resetsIn(null, NOW)).toBe('');
    expect(resetsIn(at(-3), NOW)).toBe('zera agora');
    expect(resetsIn(at(5), NOW)).toBe('zera em 5 min');
    expect(resetsIn(at(120), NOW)).toBe('zera em 2 h');
    expect(resetsIn(at(130), NOW)).toBe('zera em 2 h 10 min');
    expect(resetsIn(at(3 * 24 * 60), NOW)).toMatch(/^zera \S+ \d\d:\d\d$/);
  });
});
