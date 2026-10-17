import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '@agent-canvas/shared';
import { fmtK, fmtUsd } from '../agents/agent-ui.ts';
import { dailyBudget, type Day, lastDays, onBudgetChange, setDailyBudget } from '../costs.ts';
import { useStore } from '../state/store.ts';

const DAY = 86_400_000;
type Row = { key: string; label: string; cost: number; tokens: number; agents: number };

function group(agents: Agent[], key: (a: Agent) => [string, string]): Row[] {
  const m = new Map<string, Row>();
  for (const a of agents) {
    const [k, label] = key(a);
    const r = m.get(k) ?? { key: k, label, cost: 0, tokens: 0, agents: 0 };
    r.cost += a.costUsd;
    r.tokens += a.inputTokens + a.outputTokens;
    r.agents += 1;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/**
 * Gastos dos agentes (custo que o Claude Code informa e tokens): hoje, 7 dias e total, mais os
 * maiores por issue e por projeto. O gasto de um agente conta no dia em que ele foi criado.
 */
export function CostPanel() {
  const agents = useStore((s) => s.agents);
  const issues = useStore((s) => s.issues);
  const projects = useStore((s) => s.settings?.projects);
  const [by, setBy] = useState<'issue' | 'project'>('issue');
  const [open, setOpen] = useState(true);
  const [budget, setBudget] = useState(dailyBudget);
  useEffect(() => onBudgetChange(setBudget), []);

  const data = useMemo(() => {
    const list = Object.values(agents);
    const now = Date.now();
    const since = (ms: number) => list.filter((a) => now - Date.parse(a.createdAt) < ms);
    const sum = (l: Agent[]) => ({
      cost: l.reduce((s, a) => s + a.costUsd, 0),
      tokens: l.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0),
    });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return {
      days: lastDays(list, 30, now),
      today: sum(list.filter((a) => Date.parse(a.createdAt) >= startOfDay.getTime())),
      week: sum(since(7 * DAY)),
      total: sum(list),
      byIssue: group(list, (a) => {
        const i = a.issueRef ? issues[a.issueRef] : undefined;
        return a.issueRef
          ? [a.issueRef, i ? `#${i.iid} ${i.title}` : `Issue ${a.issueRef}`]
          : ['-', 'Sem issue'];
      }),
      byProject: group(list, (a) => {
        const p = projects?.find((x) => x.id === a.repos[0]);
        return a.repos.length > 1
          ? ['multi', 'Orquestradores (vários projetos)']
          : [String(a.repos[0] ?? '-'), p?.pathWithNamespace ?? 'Sem projeto'];
      }),
    };
  }, [agents, issues, projects]);

  if (!Object.keys(agents).length) return null;
  const rows = (by === 'issue' ? data.byIssue : data.byProject).slice(0, 6);
  const max = Math.max(...rows.map((r) => r.cost), 0) || 1;
  const over = !!budget && data.today.cost > budget;
  const tile = (label: string, v: { cost: number; tokens: number }, warn = false) => (
    <div className={`cost-tile${warn ? ' over' : ''}`}>
      <b>{fmtUsd(v.cost)}</b>
      <span>{label}</span>
      <small>{warn ? `acima de ${fmtUsd(budget!)}` : `${fmtK(v.tokens)} tokens`}</small>
    </div>
  );
  return (
    <section className="cost">
      <button className="grp-h grp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Gastos dos agentes</span>
        <span className="caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <>
          <div className="cost-tiles">
            {tile('Hoje', data.today, over)}
            {tile('7 dias', data.week)}
            {tile('Total', data.total)}
          </div>
          <DayChart days={data.days} budget={budget} />
          <BudgetField budget={budget} />
          <div className="chips" role="group" aria-label="Agrupar gastos">
            <button className="chip" aria-pressed={by === 'issue'} onClick={() => setBy('issue')}>
              Por issue
            </button>
            <button className="chip" aria-pressed={by === 'project'} onClick={() => setBy('project')}>
              Por projeto
            </button>
          </div>
          <ul className="cost-bars">
            {rows.map((r) => (
              <li
                key={r.key}
                title={`${r.label}\n${fmtUsd(r.cost)} · ${fmtK(r.tokens)} tokens · ${r.agents} agente${r.agents === 1 ? '' : 's'}`}
              >
                <span className="cb-l">{r.label}</span>
                <span className="cb-v">{fmtUsd(r.cost)}</span>
                <span className="cb-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (r.cost / max) * 100)}%` }} />
                </span>
              </li>
            ))}
          </ul>
          <p className="tip">
            Custo informado pelo Claude Code; o gasto de cada agente conta no dia em que ele começou.
          </p>
        </>
      )}
    </section>
  );
}

const W = 300;
const H = 64;
const GAP = 2;
const dayLabel = (d: Date) =>
  d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');

/** Gasto por dia nos últimos 30 dias, com a linha do limite diário quando há um. */
function DayChart({ days, budget }: { days: Day[]; budget: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(...days.map((d) => d.cost), budget ?? 0) || 1;
  const bw = (W - GAP * (days.length - 1)) / days.length;
  const y = (v: number) => H - (v / top) * (H - 4);
  const h = hover !== null ? days[hover] : undefined;
  return (
    <figure className="cost-chart">
      <figcaption>
        <span>Últimos 30 dias</span>
        <span className="cc-tip" aria-live="polite">
          {h
            ? `${dayLabel(h.date)} · ${fmtUsd(h.cost)} · ${h.agents} agente${h.agents === 1 ? '' : 's'}`
            : `${fmtUsd(days.reduce((s, d) => s + d.cost, 0))} no período`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Gasto por dia nos últimos 30 dias"
        onPointerLeave={() => setHover(null)}
      >
        <line className="cc-base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
        {budget && budget <= top && <line className="cc-limit" x1="0" x2={W} y1={y(budget)} y2={y(budget)} />}
        {days.map((d, i) => {
          const x = i * (bw + GAP);
          const bh = d.cost > 0 ? Math.max(2, H - y(d.cost)) : 0;
          return (
            <g key={d.key} onPointerEnter={() => setHover(i)}>
              <rect className="cc-hit" x={x - GAP / 2} y="0" width={bw + GAP} height={H} />
              {bh > 0 && (
                <path
                  className={`cc-bar${budget && d.cost > budget ? ' over' : ''}${hover === i ? ' on' : ''}`}
                  d={barPath(x, H - bh, bw, bh)}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="cc-axis" aria-hidden="true">
        <span>{dayLabel(days[0]!.date)}</span>
        <span>{dayLabel(days[15]!.date)}</span>
        <span>hoje</span>
      </div>
    </figure>
  );
}

/** Barra com o topo arredondado e a base reta, presa na linha de base. */
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(2, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Limite diário: só avisa (no painel e com um aviso por dia), não para os agentes. */
function BudgetField({ budget }: { budget: number | null }) {
  const [v, setV] = useState(budget ? String(budget) : '');
  useEffect(() => setV(budget ? String(budget) : ''), [budget]);
  const save = () => {
    const n = Number(v.replace(',', '.'));
    setDailyBudget(Number.isFinite(n) && n > 0 ? n : null);
  };
  return (
    <label className="cost-budget">
      <span>Avisar acima de US$</span>
      <input
        className="field"
        inputMode="decimal"
        placeholder="sem limite"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        aria-label="Limite diário de gasto em dólares"
      />
      <span>por dia</span>
    </label>
  );
}
