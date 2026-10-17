import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { Canvas } from './canvas/Canvas.tsx';
import { closeMenu, ContextMenu, isMenuOpen } from './canvas/ContextMenu.tsx';
import { Toolbar } from './canvas/Toolbar.tsx';
import { WorkspaceSwitcher } from './canvas/WorkspaceSwitcher.tsx';
import { type Dir, fit, focusNode, neighbor } from './canvas/viewport.ts';
import { IconSide } from './icons.tsx';
import { Focus } from './panels/Focus.tsx';
import { Inspector } from './panels/Inspector.tsx';
import { Palette } from './panels/Palette.tsx';
import { Sidebar } from './panels/Sidebar.tsx';
import { Toast } from './panels/Toast.tsx';
import { newAgentAt, newNoteAt } from './actions.ts';
import { useBudgetWatch } from './costs.ts';
import { refreshIssues } from './state/issues.ts';
import { activeFixer, hasPendingUndo, liveAgents, liveMrs, useStore } from './state/store.ts';
import { mrFailed, mrReady } from './mrs/mr-ui.tsx';

const ISSUES_EVERY_MS = 60_000;
const ARROWS: Record<string, Dir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

export function Workspace() {
  useBudgetWatch();
  const settings = useStore((s) => s.settings)!;
  const sideHidden = useStore((s) => s.sideHidden);
  const connection = useStore((s) => s.connection);
  const projectsKey = settings.projects.map((p) => p.id).join(',');
  const main = useRef<HTMLDivElement>(null);

  // issues abertas dos projetos escolhidos: ao abrir, ao mudar a seleção e a cada minuto
  useEffect(() => {
    void refreshIssues();
    const t = setInterval(() => void refreshIssues(), ISSUES_EVERY_MS);
    return () => clearInterval(t);
  }, [projectsKey, settings.mode, settings.baseUrl, settings.workspaceId]);

  // atalhos de teclado (sem animação, como no protótipo)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = !!t.closest?.('input,textarea,select,[contenteditable]');
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && isMenuOpen()) {
        e.preventDefault();
        closeMenu();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z' && hasPendingUndo() && !typing) {
        e.preventDefault();
        st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.setPalette(!st.paletteOpen);
        return;
      }
      if (mod && e.key.toLowerCase() === 'b' && !typing) {
        e.preventDefault();
        if (innerWidth <= 860) st.setSideOpen(!st.sideOpen);
        else instantSide(main.current, () => st.setSideHidden(!st.sideHidden));
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.multi.length > 1 && !typing && !st.focusId) {
        e.preventDefault();
        st.removeNodes(st.multi);
        return;
      }
      if (e.key === 'Escape' && st.multi.length && !typing) {
        st.setMulti([]);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected && !typing && !st.focusId) {
        e.preventDefault();
        st.removeNode(st.selected);
        return;
      }
      // teclas soltas só valem no canvas: sem modificador, sem digitar, sem foco, paleta ou diálogo
      const free =
        !mod &&
        !e.altKey &&
        !typing &&
        !st.focusId &&
        !st.paletteOpen &&
        !st.settingsOpen &&
        !document.querySelector('.fpick-bg, .setup.modal');
      if (!free) return;
      const onControl = !!t.closest?.('button,a,[role=option],[role=tab],[role=listbox]');
      const dir = ARROWS[e.key];
      if (dir && !onControl) {
        e.preventDefault();
        const id = neighbor(st.selected, dir);
        if (id) focusNode(id);
        return;
      }
      if (e.key === 'Enter' && st.selected && !onControl) {
        e.preventDefault();
        st.openFocus(st.selected);
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : '';
      if (k === 'n') {
        e.preventDefault();
        if (e.shiftKey) newNoteAt();
        else newAgentAt();
      } else if (k === 'a') {
        e.preventDefault();
        st.showSection('actions');
        if (innerWidth <= 860) st.setSideOpen(true);
        else if (st.sideHidden) st.setSideHidden(false);
      } else if (k === 'f') {
        e.preventDefault();
        fit(true);
      } else if (e.key === '?') {
        e.preventDefault();
        st.setPanel(st.panel === 'help' ? null : 'help');
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar />
        <div className={`main${sideHidden ? ' side-hidden' : ''}`} ref={main}>
          <Sidebar />
          <Canvas />
          <Toolbar />
          <Toast />
          <Focus />
          <Inspector />
          <Palette />
          {connection === 'closed' && (
            <div className="offline" role="status">
              Sem conexão com o bridge. Tentando de novo…{' '}
              <button className="link-btn" onClick={() => location.reload()}>
                Recarregar
              </button>
            </div>
          )}
        </div>
      </div>
      <ContextMenu />
    </ReactFlowProvider>
  );
}

/** Pelo atalho, a barra lateral aparece e some sem animação (ação de teclado não anima). */
function instantSide(main: HTMLElement | null, change: () => void) {
  main?.classList.add('instant');
  change();
  requestAnimationFrame(() => requestAnimationFrame(() => main?.classList.remove('instant')));
}

function TopBar() {
  const sideHidden = useStore((s) => s.sideHidden);
  const sideOpen = useStore((s) => s.sideOpen);
  const setSideHidden = useStore((s) => s.setSideHidden);
  const setSideOpen = useStore((s) => s.setSideOpen);
  const active = useStore(
    (s) => liveAgents(s).filter((a) => a.status === 'running' || a.status === 'coordinating').length,
  );
  const waiting = useStore((s) => liveAgents(s).filter((a) => a.status === 'waiting').length);
  const mrCount = useStore((s) => liveMrs(s).filter((m) => m.state === 'opened').length);
  const mrReadyCount = useStore((s) => liveMrs(s).filter(mrReady).length);
  const mrFailedCount = useStore(
    (s) => liveMrs(s).filter((m) => mrFailed(m) && !activeFixer(s, m.ref)).length,
  );
  const goActions = () => {
    useStore.getState().showSection('actions');
    if (innerWidth <= 860) setSideOpen(true);
    else if (sideHidden) setSideHidden(false);
  };
  // aviso na aba do navegador quando um agente espera você (com o canvas em segundo plano)
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Aguardando você · Agent Canvas` : 'Agent Canvas';
  }, [waiting]);
  return (
    <header className="top">
      <button
        className="btn plain icon"
        aria-label="Mostrar ou ocultar barra lateral"
        aria-pressed={innerWidth <= 860 ? sideOpen : !sideHidden}
        title="Barra lateral (Ctrl/⌘ + B)"
        onClick={() => (innerWidth <= 860 ? setSideOpen(!sideOpen) : setSideHidden(!sideHidden))}
      >
        <IconSide size={16} />
      </button>
      <div className="brand">
        <span className="appicon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" />
          </svg>
        </span>
        <b>Agent Canvas</b>
        <span className="brand-sep" aria-hidden="true">
          /
        </span>
        <WorkspaceSwitcher />
      </div>
      <div className="spacer" />
      <div className="stats">
        {active > 0 && (
          <span className="badge info live">
            <span className="d" />
            {active} trabalhando
          </span>
        )}
        {waiting > 0 && (
          <button className="badge warn badge-btn" title="Ver ações pendentes" onClick={goActions}>
            <span className="d" />
            {waiting} aguardando você
          </button>
        )}
        {mrFailedCount > 0 && (
          <button className="badge bad badge-btn" title="Ver pipelines com falha" onClick={goActions}>
            <span className="d" />
            {mrFailedCount} pipeline{mrFailedCount > 1 ? 's falharam' : ' falhou'}
          </button>
        )}
        {mrReadyCount > 0 ? (
          <button className="badge ok badge-btn" title="Ver o que está pronto para merge" onClick={goActions}>
            {mrReadyCount} pronto{mrReadyCount > 1 ? 's' : ''} para merge
          </button>
        ) : (
          mrCount > 0 && (
            <span className="badge mrb">
              {mrCount} MR{mrCount === 1 ? '' : 's'} aberto{mrCount === 1 ? '' : 's'}
            </span>
          )
        )}
      </div>
      <button className="btn primary" onClick={() => newAgentAt()}>
        + Novo agente
      </button>
    </header>
  );
}
