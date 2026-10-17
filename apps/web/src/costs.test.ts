import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '@agent-canvas/shared';
import { dailyBudget, dayKey, lastDays, setDailyBudget } from './costs.ts';
import { applyTheme, effectiveTheme, setThemePref, themePref } from './theme.ts';

const at = (iso: string, costUsd: number) =>
  ({ createdAt: iso, costUsd, inputTokens: 100, outputTokens: 50 }) as Agent;

describe('lastDays', () => {
  it('soma o gasto no dia em que o agente começou e zera os dias vazios', () => {
    const now = new Date(2026, 9, 17, 15).getTime();
    const days = lastDays(
      [
        at(new Date(2026, 9, 17, 9).toISOString(), 0.5),
        at(new Date(2026, 9, 17, 11).toISOString(), 0.25),
        at(new Date(2026, 9, 15, 23).toISOString(), 1),
        at(new Date(2026, 8, 1).toISOString(), 9), // fora da janela
      ],
      30,
      now,
    );
    expect(days).toHaveLength(30);
    expect(days.at(-1)!.key).toBe(dayKey(now));
    expect(days.at(-1)).toMatchObject({ cost: 0.75, tokens: 300, agents: 2 });
    expect(days.at(-3)).toMatchObject({ cost: 1, agents: 1 });
    expect(days.at(-2)!.cost).toBe(0);
    expect(days.reduce((s, d) => s + d.cost, 0)).toBe(1.75);
  });
});

describe('limite diário e tema', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('guarda o limite e ignora valores inválidos', () => {
    setDailyBudget(5);
    expect(dailyBudget()).toBe(5);
    setDailyBudget(0);
    expect(dailyBudget()).toBeNull();
  });

  it('a escolha manual vira data-theme; "do sistema" tira o atributo', () => {
    setThemePref('dark');
    expect(themePref()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(effectiveTheme()).toBe('dark');
    setThemePref('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    localStorage.setItem('ac-theme', 'light');
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
