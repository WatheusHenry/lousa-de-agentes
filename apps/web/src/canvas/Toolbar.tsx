import { useStore as useFlowStore } from '@xyflow/react';
import { newNoteAt } from '../actions.ts';
import { IconBolt, IconFit, IconHelp, IconNewNote, IconSearch, IconZoomIn, IconZoomOut } from '../icons.tsx';
import { useStore } from '../state/store.ts';
import { fit, zoomBy } from './viewport.ts';

/** Toolbar flutuante no topo, em grupos (zoom, criar, painéis). */
export function Toolbar() {
  const zoom = useFlowStore((s) => s.transform[2]);
  const setPanel = useStore((s) => s.setPanel);
  return (
    <div className="toolbar">
      <div className="tb-grp" role="group" aria-label="Zoom">
        <button
          className="btn plain icon"
          aria-label="Diminuir zoom"
          title="Diminuir zoom"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <IconZoomOut />
        </button>
        <output>{Math.round(zoom * 100)}%</output>
        <button
          className="btn plain icon"
          aria-label="Aumentar zoom"
          title="Aumentar zoom"
          onClick={() => zoomBy(1.2)}
        >
          <IconZoomIn />
        </button>
        <button className="btn plain sm" title="Ajustar à tela" onClick={() => fit(true)}>
          <IconFit />
          <span className="lb">Ajustar</span>
        </button>
      </div>
      <div className="tb-grp" role="group" aria-label="Criar">
        <button className="btn plain sm" title="Nova nota" onClick={() => newNoteAt()}>
          <IconNewNote />
          <span className="lb">Nota</span>
        </button>
      </div>
      <div className="tb-grp" role="group" aria-label="Painéis">
        <button
          className="btn plain sm"
          title="Buscar agentes, issues, notas e ações (Ctrl/⌘ + K)"
          onClick={() => useStore.getState().setPalette(true)}
        >
          <IconSearch size={14} />
          <span className="lb">Buscar</span>
        </button>
        <button className="btn plain sm" title="Automações" onClick={() => setPanel('auto')}>
          <IconBolt />
          <span className="lb">Automações</span>
        </button>
        <button className="btn plain sm" title="Como funciona" onClick={() => setPanel('help')}>
          <IconHelp />
          <span className="lb">Como funciona</span>
        </button>
      </div>
    </div>
  );
}
