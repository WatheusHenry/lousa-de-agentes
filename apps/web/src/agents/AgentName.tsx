import { useEffect, useRef, useState, type ElementType } from 'react';
import type { Agent } from '@agent-canvas/shared';
import { useStore } from '../state/store.ts';

/** Nome do agente; duplo clique (ou "Renomear" no menu) edita. Enter salva, Esc cancela, vazio volta ao automático. */
export function AgentName({
  agent,
  as: Tag = 'span',
  className,
}: {
  agent: Agent;
  as?: ElementType;
  className?: string;
}) {
  const rename = useStore((s) => s.renameAgent);
  const requested = useStore((s) => s.renaming === agent.id);
  const setRenaming = useStore((s) => s.setRenaming);
  const [local, setLocal] = useState(false);
  const editing = local || requested;
  const [text, setText] = useState(agent.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setText(agent.name);
    input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const done = (save: boolean) => {
    setLocal(false);
    setRenaming(null);
    if (save && text.trim() !== agent.name) rename(agent.id, text);
  };

  if (editing)
    return (
      <input
        ref={input}
        className="name-edit nodrag nowheel"
        value={text}
        maxLength={40}
        autoFocus
        aria-label={`Nome de ${agent.name}`}
        placeholder="Nome automático"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') done(true);
          if (e.key === 'Escape') done(false);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    );
  return (
    <Tag
      className={className}
      title={`${agent.name}\nDuplo clique para renomear`}
      onDoubleClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        setLocal(true);
      }}
    >
      {agent.name}
    </Tag>
  );
}
