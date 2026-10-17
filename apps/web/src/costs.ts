import { useEffect } from 'react';
import type { Agent } from '@agent-canvas/shared';
import { fmtUsd } from './agents/agent-ui.ts';
import { useStore } from './state/store.ts';

/**
 * Gastos por dia e o limite diário (aviso, não trava nada). O gasto de um agente conta no dia
 * em que ele foi criado. O limite fica neste navegador.
 */
const KEY = 'ac-daily-budget';
const ALERTED = 'ac-budget-alerted';
const listeners = new Set<(v: number | null) => void>();

export function dailyBudget(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setDailyBudget(v: number | null): void {
  try {
    if (v && v > 0) localStorage.setItem(KEY, String(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* sem armazenamento: vale só nesta aba */
  }
  for (const l of listeners) l(v && v > 0 ? v : null);
}

export function onBudgetChange(l: (v: number | null) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Dia local no formato AAAA-MM-DD. */
export function dayKey(t: number | Date): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface Day {
  key: string;
  date: Date;
  cost: number;
  tokens: number;
  agents: number;
}

/** Os últimos `n` dias, do mais antigo até hoje, com os dias sem gasto zerados. */
export function lastDays(agents: Agent[], n: number, now = Date.now()): Day[] {
  const days: Day[] = [];
  const index = new Map<string, Day>();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const d = { key: dayKey(date), date, cost: 0, tokens: 0, agents: 0 };
    days.push(d);
    index.set(d.key, d);
  }
  for (const a of agents) {
    const d = index.get(dayKey(Date.parse(a.createdAt)));
    if (!d) continue;
    d.cost += a.costUsd;
    d.tokens += a.inputTokens + a.outputTokens;
    d.agents += 1;
  }
  return days;
}

/** Avisa uma vez por dia quando o gasto de hoje passa do limite. */
export function useBudgetWatch(): void {
  const today = useStore((s) => {
    const k = dayKey(Date.now());
    let c = 0;
    for (const a of Object.values(s.agents)) if (dayKey(Date.parse(a.createdAt)) === k) c += a.costUsd;
    return c;
  });
  useEffect(() => {
    const limit = dailyBudget();
    if (!limit || today <= limit) return;
    const k = dayKey(Date.now());
    try {
      if (localStorage.getItem(ALERTED) === k) return;
      localStorage.setItem(ALERTED, k);
    } catch {
      /* sem armazenamento: avisa de novo na próxima vez */
    }
    const st = useStore.getState();
    st.showToast(`Os agentes já gastaram ${fmtUsd(today)} hoje, acima do limite de ${fmtUsd(limit)}.`, {
      label: 'Ver gastos',
      run: () => useStore.getState().showSection('feed'),
    });
  }, [today]);
}
