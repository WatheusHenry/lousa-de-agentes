import { useMemo, useState } from 'react';
import type { Agent } from '@agent-canvas/shared';
import { fmtK, fmtUsd } from '../agents/agent-ui.ts';
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
  const tile = (label: string, v: { cost: number; tokens: number }) => (
    <div className="cost-tile">
      <b>{fmtUsd(v.cost)}</b>
      <span>{label}</span>
      <small>{fmtK(v.tokens)} tokens</small>
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
            {tile('Hoje', data.today)}
            {tile('7 dias', data.week)}
            {tile('Total', data.total)}
          </div>
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
