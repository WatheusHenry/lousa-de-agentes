import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { needsClaudeLogin, type Agent, type AgentEvent } from '@agent-canvas/shared';
import { ClaudeLoginBox } from './ClaudeLoginBox.tsx';
import { useStore } from '../state/store.ts';
import { fmtUsd } from './agent-ui.ts';
import { groupLabel, segments, splitShell, type ReadKind } from './terminal.ts';

const firstLines = (s: string, n = 3) => {
  const lines = s.split('\n').filter((l) => l.trim());
  const head = lines.slice(0, n).join('\n');
  return lines.length > n ? `${head}\n… +${lines.length - n} linhas` : head;
};

/** Markdown das respostas, memorizado: o parse não se repete a cada evento novo. */
const Md = memo(function Md({ text }: { text: string }) {
  return <Markdown compact>{text}</Markdown>;
});

/** Comando do Bash: encadeado e longo, cada etapa numa linha (como o CLI quebra). */
function ToolCall({ b }: { b: Extract<AgentEvent['body'], { kind: 'tool_use' }> }) {
  const full = b.name === 'Bash' ? String((b.input as { command?: unknown })?.command ?? b.summary) : '';
  const parts = full ? splitShell(full.split('\n<<')[0]!) : [];
  if (b.name === 'Bash' && parts.length > 1 && full.length > 60)
    return (
      <div className="l tool">
        <span className="g">●</span> <b>Bash</b>
        <div className="cmd-parts">
          {parts.map((p, i) => (
            <div key={i}>
              {p.sep && <span className="sep">{p.sep} </span>}
              {p.part.length > 160 ? `${p.part.slice(0, 159)}…` : p.part}
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div className="l tool">
      <span className="g">●</span> <b>{b.name.replace(/^mcp__canvas__/, '')}</b>({b.summary})
    </div>
  );
}

/** Saída de ferramenta: 3 linhas; o resto abre com um clique. */
function ToolOutput({ b }: { b: Extract<AgentEvent['body'], { kind: 'tool_result' }> }) {
  const [open, setOpen] = useState(false);
  if (b.content.startsWith("The user doesn't want to proceed with this tool use"))
    return <div className="l out">⎿ interrompido</div>;
  const lines = b.content.split('\n').filter((l) => l.trim());
  if (!lines.length) return <div className={`l out${b.isError ? ' err' : ''}`}>⎿ (sem saída)</div>;
  const more = lines.length - 3;
  return (
    <div className={`l out out-row${b.isError ? ' err' : ''}`}>
      <span className="out-g">⎿</span>
      <span className={`out-txt${open ? ' full' : ''}`}>
        {(open ? lines.slice(0, 400) : lines.slice(0, 3)).join('\n')}
        {more > 0 && (
          <button className="out-more nodrag" onClick={() => setOpen(!open)}>
            {open ? 'recolher' : `+${more} linha${more === 1 ? '' : 's'}`}
          </button>
        )}
      </span>
    </div>
  );
}

/** Leituras seguidas (Read, buscas, ls, cat…) numa linha só, que abre para mostrar cada uma. */
function ReadGroup({ events, kinds }: { events: AgentEvent[]; kinds: ReadKind[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="l tool read-group nodrag" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="g">●</span> {groupLabel(kinds)}
        <span className="caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="read-items">
          {events.map((e) =>
            e.body.kind === 'tool_use' ? (
              <ToolCall key={e.id} b={e.body} />
            ) : e.body.kind === 'tool_result' ? (
              <ToolOutput key={e.id} b={e.body} />
            ) : null,
          )}
        </div>
      )}
    </>
  );
}

/** Texto que o agente está escrevendo agora (streaming), com cursor; some quando a mensagem fecha. */
function LiveText({ agentId }: { agentId: string }) {
  const text = useStore((s) => s.liveText[agentId]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // segue o texto se o terminal já estava no fim
    let el = ref.current?.parentElement;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <div className="l txt md-line live" ref={ref}>
      <span className="g">●</span>
      <span className="live-t">
        {text}
        <span className="cursor" aria-hidden="true" />
      </span>
    </div>
  );
}

/**
 * Terminal estruturado do agente, como no protótipo: cada evento vira uma linha (texto,
 * ferramenta, resultado, pedido de permissão), não um terminal ANSI.
 */
function AgentLinesView({ agent, events }: { agent: Agent; events: AgentEvent[] }) {
  const approvals = useStore((s) => s.approvals);
  const decide = useStore((s) => s.decideApproval);
  const out: ReactNode[] = [];
  let inits = 0;
  let lastUser: string | null = null;
  // a caixa de login só aparece no último resultado (os antigos já foram resolvidos)
  const lastResult = events.findLast((e) => e.body.kind === 'result')?.id;
  for (const seg of segments(events)) {
    if (seg.type === 'reads') {
      out.push(<ReadGroup key={`g${seg.events[0]!.id}`} events={seg.events} kinds={seg.kinds} />);
      continue;
    }
    const e = seg.e;
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
        lastUser = b.text;
        out.push(
          <div key={k} className="l user">
            <small>{b.from ?? 'Você'}</small>
            <Markdown compact>{b.text}</Markdown>
          </div>,
        );
        break;
      case 'text':
        out.push(
          <div key={k} className="l txt md-line">
            <span className="g">●</span>
            <Md text={b.text} />
          </div>,
        );
        break;
      case 'plan':
        out.push(
          <div key={k} className="plan">
            <b>Plano</b>
            {b.items.map((it, j) => (
              <span key={j} className={`it${it.done ? ' ok' : it.agentId ? ' wip' : ''}`}>
                <span className="ck">{it.done ? '✓' : ''}</span>
                <Markdown inline className="tx">
                  {it.text}
                </Markdown>
              </span>
            ))}
          </div>,
        );
        break;
      case 'spawn':
        // a chamada de spawn_agent e o resultado dela já aparecem como ferramenta
        break;
      case 'wait':
        out.push(
          <div key={k} className="l dim">
            {b.state === 'start'
              ? `⏳ esperando ${b.names.join(', ')}`
              : `✓ ${b.names.join(', ')} terminaram`}
          </div>,
        );
        break;
      case 'question':
        out.push(
          b.answer === null ? (
            <div key={k} className="l ask">
              <div>
                <b>Pergunta para você</b>
                <span className="lab"> (responda na seção Ações)</span>
              </div>
              <Markdown compact>{b.text}</Markdown>
            </div>
          ) : (
            <div key={k} className="l out">
              ⎿ você respondeu: {b.answer}
            </div>
          ),
        );
        break;
      case 'context':
        out.push(
          <div key={k} className="l dim">
            ↻ contexto atualizado: {b.labels.join(' · ')}
            {b.notified ? ' · pedi para reler o context.md' : ''}
          </div>,
        );
        break;
      case 'tool_use':
        out.push(<ToolCall key={k} b={b} />);
        break;
      case 'tool_result':
        out.push(<ToolOutput key={k} b={b} />);
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
                {!agent.autoMode && (
                  <button
                    className="btn sm plain nodrag"
                    title="Libera este pedido e os próximos deste agente (menos push, sudo, merge e arquivos fora do worktree)"
                    onClick={() => useStore.getState().setAgentMode(agent.id, true)}
                  >
                    ⏵⏵ Modo automático
                  </button>
                )}
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
            ) : needsClaudeLogin(b.text) ? (
              k === lastResult && agent.status === 'error' ? (
                <ClaudeLoginBox key={k} agent={agent} lastMessage={lastUser} follow />
              ) : (
                <div key={k} className="l out err">
                  ⎿ o login do Claude Code tinha expirado
                </div>
              )
            ) : (
              <div key={k} className="l out err">
                ⎿ o turno terminou com erro
                {b.text?.trim() ? `: ${firstLines(b.text, 1)}` : ` (${b.subtype})`}
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
  out.push(<LiveText key="live" agentId={agent.id} />);
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
