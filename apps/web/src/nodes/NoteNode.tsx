import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { IconExpand, IconNote } from '../icons.tsx';
import { useStore } from '../state/store.ts';
import type { FlowNode } from '../canvas/flow.ts';

function NoteNodeView({ id, data }: NodeProps<FlowNode>) {
  const note = useStore((s) => s.notes[data.refId]);
  const fresh = useStore((s) => !!s.fresh[id]);
  const links = useStore(
    (s) => s.noteLinks.filter((l) => l.noteId === data.refId && s.nodes[l.targetNodeId]).length,
  );
  const updateNote = useStore((s) => s.updateNote);
  const flushNote = useStore((s) => s.flushNote);
  const openFocus = useStore((s) => s.openFocus);
  if (!note) return null;

  return (
    <div className={`card ncard note${fresh ? ' enter' : ''}`}>
      <div className="nhead" data-drag>
        <span className="ico note">
          <IconNote />
        </span>
        <span className="num">{note.isHandoff ? 'Passagem' : 'Nota'}</span>
        <span style={{ flex: 1 }} />
        <span className="nmeta nlinks">
          {links ? `${links} vínculo${links > 1 ? 's' : ''}` : 'Sem vínculos'}
        </span>
        <button
          className="btn plain icon xs expand nodrag"
          aria-label="Expandir"
          title="Expandir"
          onClick={() => openFocus(id)}
        >
          <IconExpand />
        </button>
      </div>
      <input
        className="ntitle-in nodrag"
        value={note.title}
        placeholder="Título da nota"
        aria-label="Título da nota"
        onChange={(e) => updateNote(note.id, { title: e.target.value })}
        onBlur={(e) => {
          if (!e.target.value.trim()) updateNote(note.id, { title: 'Sem título' });
          flushNote(note.id);
        }}
      />
      <textarea
        className="nbody nodrag nowheel"
        value={note.body}
        placeholder="Escreva decisões, regras de negócio, links, trechos de log…"
        aria-label="Texto da nota"
        onChange={(e) => updateNote(note.id, { body: e.target.value })}
        onBlur={() => flushNote(note.id)}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="port"
        aria-label="Vincular nota a uma issue"
        title="Arraste até uma issue"
      >
        <span style={{ pointerEvents: 'none' }}>+</span>
      </Handle>
      <Handle type="target" position={Position.Left} className="hidden-handle" />
    </div>
  );
}

export const NoteNode = memo(NoteNodeView);
