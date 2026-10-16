import { memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Agent, AgentEvent } from '@agent-canvas/shared';
import { useStore } from '../state/store.ts';
import { fmtUsd } from './agent-ui.ts';

const firstLines = (s: string, n = 3) => {
  const lines = s.split('\n').filter((l) => l.trim());
  const head = lines.slice(0, n).join('\n');
  return lines.length > n ? `${head}\n… +${lines.length - n} linhas` : head;
};

/**
 * Terminal estruturado do agente, como no protótipo: cada evento vira uma linha (texto,
 * ferramenta, resultado, pedido de permissão), não um terminal ANSI.
 */
function AgentLinesView({ agent, events }: { agent: Agent; events: AgentEvent[] }) {
  const approvals = useStore((s) => s.approvals);
  const decide = useStore((s) => s.decideApproval);
  const out: ReactNode[] = [];
  let inits = 0;
  for (const e of events) {
    const b = e.body;
    const k = e.id;
    switch (b.kind) {
      case 'init':
        out.push(
          <div key={k} className={`l ${inits++ ? 'dim' : 'sys'}`}>
            {inits === 1
              ? `${agent.name} · ${agent.branch ?? 'sem branch'} · ${b.model}`
              : '↻ sessão retomada'}
          </div>,
        );
        break;
      case 'user_message':
        out.push(
          <div key={k} className="l user">
            <small>Você</small>
            {b.text}
          </div>,
        );
        break;
      case 'text':
        out.push(
          <div key={k} className="l txt">
            <span className="g">●</span> {b.text}
          </div>,
        );
        break;
      case 'tool_use':
        out.push(
          <div key={k} className="l tool">
            <span className="g">●</span> <b>{b.name}</b>({b.summary})
          </div>,
        );
        break;
      case 'tool_result':
        out.push(
          <div key={k} className={`l out${b.isError ? ' err' : ''}`}>
            ⎿{' '}
            {b.content.startsWith("The user doesn't want to proceed with this tool use")
              ? 'interrompido'
              : firstLines(b.content) || '(sem saída)'}
          </div>,
        );
        break;
      case 'permission': {
        const pending = b.status === 'pending' && approvals[b.approvalId];
        if (b.status === 'pending' && !pending) break; // já decidido: a linha de decisão vem depois
        out.push(
          pending ? (
            <div key={k} className="l ask">
              <div>
                Posso usar <b>{b.toolName}</b>
                {b.summary ? (
                  <>
                    {' '}
                    com <code>{b.summary}</code>
                  </>
                ) : null}
                ?
              </div>
              <div className="acts">
                <button className="btn sm primary nodrag" onClick={() => decide(b.approvalId, 'allow')}>
                  Permitir
                </button>
                <button className="btn sm nodrag" onClick={() => decide(b.approvalId, 'deny')}>
                  Negar
                </button>
                <button
                  className="btn sm plain nodrag"
                  title={`Grava a regra ${pending.suggestedRule}`}
                  onClick={() => decide(b.approvalId, 'allow', true)}
                >
                  Sempre permitir
                </button>
              </div>
            </div>
          ) : (
            <div key={k} className={`l out${b.status === 'denied' ? ' err' : ''}`}>
              ⎿ {b.status === 'allowed' ? 'permitido' : 'negado'}
            </div>
          ),
        );
        break;
      }
      case 'status':
        if (b.status === 'paused')
          out.push(
            <div key={k} className="l dim">
              — pausado{b.note ? `: ${b.note}` : ''} —
            </div>,
          );
        else if (b.status === 'stopped')
          out.push(
            <div key={k} className="l dim">
              — parado{b.note ? `: ${b.note}` : ''} —
            </div>,
          );
        else if (b.note)
          out.push(
            <div key={k} className="l dim">
              {b.note}
            </div>,
          );
        break;
      case 'result':
        out.push(
          b.isError ? (
            b.terminalReason === 'aborted_tools' || b.subtype === 'error_during_execution' ? (
              <div key={k} className="l dim">
                — turno interrompido —
              </div>
            ) : (
              <div key={k} className="l out err">
                ⎿ o turno terminou com erro ({b.subtype})
              </div>
            )
          ) : (
            <div key={k} className="l done">
              ✓ Turno concluído · {fmtUsd(b.costUsd)}
            </div>
          ),
        );
        break;
      case 'error':
        out.push(
          <div key={k} className="l out err">
            ⚠ {b.message}
          </div>,
        );
        break;
    }
  }
  return <>{out}</>;
}

export const AgentLines = memo(AgentLinesView);

/** Rola para o fim quando chegam linhas novas, se o usuário já estava no fim. */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };
  return { ref, onScroll };
}
