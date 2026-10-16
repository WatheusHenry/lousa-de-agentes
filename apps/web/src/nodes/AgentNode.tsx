import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, useState } from 'react';
import { AgentLines, useStickToBottom } from '../agents/AgentLines.tsx';
import { isBlank, roleLabel, statusLabel, statusTone } from '../agents/agent-ui.ts';
import { IconExpand } from '../icons.tsx';
import { useStore } from '../state/store.ts';
import type { FlowNode } from '../canvas/flow.ts';

const EMPTY: never[] = [];

/** Janela de terminal do agente no canvas. */
function AgentNodeView({ id, data }: NodeProps<FlowNode>) {
  const agent = useStore((s) => s.agents[data.refId]);
  const events = useStore((s) => s.agentEvents[data.refId] ?? EMPTY);
  const fresh = useStore((s) => !!s.fresh[id]);
  const repo = useStore((s) => s.settings?.projects.find((p) => p.id === agent?.repos[0]));
  const openFocus = useStore((s) => s.openFocus);
  const message = useStore((s) => s.messageAgent);
  const [text, setText] = useState('');
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(events.length);
  if (!agent) return null;
  const blank = isBlank(agent);
  const sub = blank
    ? 'sem instrução ainda'
    : agent.repos.length > 1
      ? `${agent.repos.length} repositórios`
      : (repo?.name ?? 'sem repositório');

  return (
    <div className={`card win${fresh ? ' enter' : ''}`}>
      <div className="wbar" data-drag>
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="wname">{agent.name}</span>
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
        />
        <button className="send" aria-label="Enviar" disabled={!text.trim()}>
          ↑
        </button>
      </form>
      <Handle type="target" position={Position.Top} className="hidden-handle" />
      <Handle type="source" position={Position.Bottom} className="hidden-handle" />
    </div>
  );
}

export const AgentNode = memo(AgentNodeView);
