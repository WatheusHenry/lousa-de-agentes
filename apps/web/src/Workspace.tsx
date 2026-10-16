import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { api, ApiError } from './api/http.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { closeMenu, ContextMenu, isMenuOpen } from './canvas/ContextMenu.tsx';
import { Toolbar } from './canvas/Toolbar.tsx';
import { IconSide } from './icons.tsx';
import { Focus } from './panels/Focus.tsx';
import { Inspector } from './panels/Inspector.tsx';
import { Sidebar } from './panels/Sidebar.tsx';
import { Toast } from './panels/Toast.tsx';
import { newAgentAt } from './actions.ts';
import { hasPendingUndo, liveAgents, useStore } from './state/store.ts';

const ISSUES_EVERY_MS = 60_000;

async function refreshIssues() {
  const st = useStore.getState();
  st.setIssuesLoading(true);
  try {
    const { issues, errors } = await api.issues();
    useStore
      .getState()
      .setIssues(issues, errors.length ? errors.map((e) => `${e.project}: ${e.error}`).join(' · ') : null);
  } catch (err) {
    useStore.setState({
      issuesLoading: false,
      issuesError: err instanceof ApiError ? err.message : 'Falha ao buscar issues.',
    });
  }
}

/** Nome do espaço de trabalho no topo: o grupo em comum dos projetos, ou o primeiro projeto. */
function workspaceName(paths: string[]): string {
  if (!paths.length) return '';
  const groups = new Set(paths.map((p) => p.split('/').slice(0, -1).join(' / ')));
  if (groups.size === 1 && paths.length > 1) return [...groups][0]!;
  return paths.length > 1
    ? `${paths[0]!.replace(/\//g, ' / ')} +${paths.length - 1}`
    : paths[0]!.replace(/\//g, ' / ');
}

export function Workspace() {
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
  }, [projectsKey, settings.mode, settings.baseUrl]);

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
      if (mod && e.key.toLowerCase() === 'b' && !typing) {
        e.preventDefault();
        if (innerWidth <= 860) st.setSideOpen(!st.sideOpen);
        else instantSide(main.current, () => st.setSideHidden(!st.sideHidden));
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected && !typing && !st.focusId) {
        e.preventDefault();
        st.removeNode(st.selected);
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar workspace={workspaceName(settings.projects.map((p) => p.pathWithNamespace))} />
        <div className={`main${sideHidden ? ' side-hidden' : ''}`} ref={main}>
          <Sidebar />
          <Canvas />
          <Toolbar />
          <Toast />
          <Focus />
          <Inspector />
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

function TopBar({ workspace }: { workspace: string }) {
  const sideHidden = useStore((s) => s.sideHidden);
  const sideOpen = useStore((s) => s.sideOpen);
  const setSideHidden = useStore((s) => s.setSideHidden);
  const setSideOpen = useStore((s) => s.setSideOpen);
  const active = useStore(
    (s) => liveAgents(s).filter((a) => a.status === 'running' || a.status === 'coordinating').length,
  );
  const waiting = useStore((s) => liveAgents(s).filter((a) => a.status === 'waiting').length);
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
        <span className="ws">{workspace}</span>
      </div>
      <div className="spacer" />
      <div className="stats">
        <span className={`badge info${active ? ' live' : ''}`}>
          <span className="d" />
          {active} ativo{active === 1 ? '' : 's'}
        </span>
        {waiting > 0 && (
          <button
            className="badge warn badge-btn"
            title="Ver ações pendentes"
            onClick={() => {
              useStore.getState().setTab('actions');
              if (innerWidth <= 860) setSideOpen(true);
              else if (sideHidden) setSideHidden(false);
            }}
          >
            <span className="d" />
            {waiting} aguardando você
          </button>
        )}
        <span className="badge mrb">0 MRs</span>
      </div>
      <button className="btn primary" onClick={() => newAgentAt()}>
        + Novo agente
      </button>
    </header>
  );
}
