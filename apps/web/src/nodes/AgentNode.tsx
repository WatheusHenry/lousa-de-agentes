import { Handle, Position, useStore as useFlow, type NodeProps } from '@xyflow/react';
import { memo, useState } from 'react';
import type { Agent, AgentEvent } from '@agent-canvas/shared';
import { AgentLines, useStickToBottom } from '../agents/AgentLines.tsx';
import { AgentName } from '../agents/AgentName.tsx';
import { AutoModeToggle, autoModeKey } from '../agents/AutoModeToggle.tsx';
import { ModelPicker } from '../agents/ModelPicker.tsx';
import { fmtK, fmtUsd, isBlank, reposText, roleLabel, statusLabel, statusTone } from '../agents/agent-ui.ts';
import { IconExpand } from '../icons.tsx';
import { useStore } from '../state/store.ts';
import { NodeResize } from '../canvas/NodeResize.tsx';
import type { FlowNode } from '../canvas/flow.ts';

const EMPTY: never[] = [];
const NO_PROJECTS: never[] = [];
/** Abaixo deste zoom o terminal fica ilegível: a janela mostra um resumo em letra grande. */
const FAR = 0.75;

/** Janela de terminal do agente no canvas. */
function AgentNodeView({ id, data }: NodeProps<FlowNode>) {
  const agent = useStore((s) => s.agents[data.refId]);
  const events = useStore((s) => s.agentEvents[data.refId] ?? EMPTY);
  const fresh = useStore((s) => !!s.fresh[id]);
  const projects = useStore((s) => s.settings?.projects ?? NO_PROJECTS);
  const openFocus = useStore((s) => s.openFocus);
  const message = useStore((s) => s.messageAgent);
  const [text, setText] = useState('');
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(events.length);
  const far = useFlow((s) => s.transform[2] < FAR);
  if (!agent) return null;
  const blank = isBlank(agent);
  const sub = blank ? 'sem instrução ainda' : reposText(agent, projects);

  return (
    <div className={`card win${fresh ? ' enter' : ''}`}>
      <div className="wbar" data-drag>
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <AgentName agent={agent} className="wname" />
        <span className="wsub">
          {roleLabel(agent)} · {sub}
        </span>
        <span className={`badge st ${statusTone(agent.status)}`}>
          <span className="d" />
          {statusLabel(agent.status)}
        </span>
        <button
          className="btn plain icon expand nodrag"
          aria-label={`Abrir ${agent.name} em tela grande`}
          title="Abrir em foco"
          onClick={() => openFocus(id)}
        >
          <IconExpand />
        </button>
      </div>
      {far ? (
        <AgentSummary agent={agent} events={events} />
      ) : (
        <>
          <div className="tbody nodrag nowheel" ref={ref} onScroll={onScroll}>
            {blank && events.length === 0 ? (
              <div className="empty-term">
                <b>Agente em branco</b>
                <ul>
                  <li>Arraste um repositório ou uma issue da barra lateral para cima desta janela.</li>
                  <li>Escreva a primeira instrução abaixo. O agente começa por ela.</li>
                </ul>
              </div>
            ) : (
              <AgentLines agent={agent} events={events} />
            )}
          </div>
          <form
            className="composer nodrag"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              message(agent.id, text.trim());
              setText('');
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={blank ? `Primeira instrução para ${agent.name}` : `Mensagem para ${agent.name}`}
              aria-label={`Mensagem para ${agent.name}`}
              autoComplete="off"
              onKeyDown={(e) => autoModeKey(e, agent)}
            />
            <ModelPicker agent={agent} />
            <AutoModeToggle agent={agent} />
            <button className="send" aria-label="Enviar" disabled={!text.trim()}>
              ↑
            </button>
          </form>
        </>
      )}
      <Handle type="target" position={Position.Top} className="hidden-handle" />
      <Handle type="source" position={Position.Bottom} className="hidden-handle" />
      <NodeResize type="agent" />
    </div>
  );
}

/** Resumo para zoom afastado: tarefa, o que está fazendo (ou como terminou) e o gasto. */
function AgentSummary({ agent: a, events }: { agent: Agent; events: AgentEvent[] }) {
  let now = '';
  for (let i = events.length - 1; i >= 0 && !now; i--) {
    const b = events[i]!.body;
    if (b.kind === 'tool_use') now = `${b.name.replace(/^mcp__canvas__/, '')}(${b.summary})`;
    else if (b.kind === 'result') now = (b.text ?? '').split('\n').find((l) => l.trim()) ?? 'Turno concluído';
    else if (b.kind === 'permission' && b.status === 'pending') now = `Pede permissão: ${b.summary}`;
    else if (b.kind === 'question' && b.answer === null) now = `Pergunta: ${b.text}`;
    else if (b.kind === 'error') now = b.message;
  }
  return (
    <div className="wsum">
      <div className="wsum-t">{a.title}</div>
      {now && <div className="wsum-now">{now}</div>}
      <div className="wsum-n">
        {fmtK(a.inputTokens + a.outputTokens)} tokens · {fmtUsd(a.costUsd)}
      </div>
    </div>
  );
}

export const AgentNode = memo(AgentNodeView);
