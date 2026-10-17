import { useEffect, useRef, useState, type FormEvent } from 'react';
import { WORKSPACE_NAME_MAX, type SettingsView, type WorkspaceInfo } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { IconCheck, IconChevron, IconPencil, IconPlus, IconTrash } from '../icons.tsx';
import { useStore } from '../state/store.ts';
import { fit } from './viewport.ts';

/** Resumo dos projetos do workspace aberto: o grupo em comum, ou o primeiro projeto. */
export function projectsSummary(paths: string[]): string {
  if (!paths.length) return 'sem projetos';
  const groups = new Set(paths.map((p) => p.split('/').slice(0, -1).join(' / ')));
  if (groups.size === 1 && paths.length > 1) return `${[...groups][0]!} · ${paths.length} projetos`;
  return paths.length > 1
    ? `${paths[0]!.replace(/\//g, ' / ')} +${paths.length - 1}`
    : paths[0]!.replace(/\//g, ' / ');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Depois de trocar de workspace: o estado novo inteiro e a câmera enquadrando o canvas dele. */
async function reload(view: SettingsView) {
  const st = useStore.getState();
  st.setSettings(view);
  st.loadSnapshot(await api.state());
  st.setMulti([]);
  requestAnimationFrame(() => requestAnimationFrame(() => fit(false)));
}

const fail = (err: unknown) =>
  useStore.getState().showToast(err instanceof ApiError ? err.message : 'Falha ao falar com o bridge.', {
    label: 'Ok',
    run: () => {},
  });

/**
 * Seletor de workspaces no topo, ao lado do nome do app. Cada workspace é um ambiente isolado:
 * canvas, agentes, atividade e projetos próprios. Os agentes dos outros continuam trabalhando.
 */
export function WorkspaceSwitcher() {
  const settings = useStore((s) => s.settings)!;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = settings.workspaces.find((w) => w.id === settings.workspaceId);
  const elsewhere = settings.workspaces
    .filter((w) => w.id !== settings.workspaceId)
    .reduce((n, w) => n + w.busy, 0);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      // no campo de nome, Esc cancela só a edição
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest?.('.wsw-form')) return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  return (
    <div className="wsw" ref={box}>
      <button
        className="wsw-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Trocar de workspace"
        onClick={() => setOpen(!open)}
      >
        <span className="wsw-name">{current?.name ?? 'Workspace'}</span>
        <span className="wsw-sub">{projectsSummary(settings.projects.map((p) => p.pathWithNamespace))}</span>
        {elsewhere > 0 && (
          <span
            className="wsw-dot"
            title={`${plural(elsewhere, 'agente trabalhando', 'agentes trabalhando')} em outros workspaces`}
          />
        )}
        <IconChevron />
      </button>
      {open && <WorkspaceMenu settings={settings} onDone={() => setOpen(false)} />}
    </div>
  );
}

function WorkspaceMenu({ settings, onDone }: { settings: SettingsView; onDone(): void }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<SettingsView>, close = true) {
    setBusy(true);
    try {
      const view = await work();
      await reload(view);
      if (close) onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (w: WorkspaceInfo) => {
    if (w.id === settings.workspaceId) return onDone();
    void run(() => api.switchWorkspace(w.id));
  };

  return (
    <div className="wsw-pop" role="dialog" aria-label="Workspaces" aria-busy={busy}>
      <div className="wsw-title">Workspaces</div>
      <ul className="wsw-list">
        {settings.workspaces.map((w) =>
          editing === w.id ? (
            <li key={w.id}>
              <NameForm
                initial={w.name}
                label="Salvar"
                onCancel={() => setEditing(null)}
                onSubmit={(name) =>
                  run(async () => {
                    const v = await api.renameWorkspace(w.id, name);
                    setEditing(null);
                    return v;
                  }, false)
                }
              />
            </li>
          ) : confirming === w.id ? (
            <li key={w.id} className="wsw-confirm">
              <p>
                Apagar <b>{w.name}</b>? O canvas, as notas e os agentes dele saem junto. Os branches e clones
                não mudam.
              </p>
              <div className="row-end">
                <button className="btn plain sm" onClick={() => setConfirming(null)}>
                  Cancelar
                </button>
                <button
                  className="btn danger sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const v = await api.deleteWorkspace(w.id);
                      setConfirming(null);
                      return v;
                    }, false)
                  }
                >
                  Apagar
                </button>
              </div>
            </li>
          ) : (
            <li key={w.id} className={`wsw-item${w.id === settings.workspaceId ? ' on' : ''}`}>
              <button className="wsw-pick" disabled={busy} onClick={() => switchTo(w)}>
                <span className="wsw-check">{w.id === settings.workspaceId && <IconCheck />}</span>
                <span className="wsw-label">
                  <span className="wsw-item-name">{w.name}</span>
                  <small>
                    {plural(w.projects, 'projeto', 'projetos')}
                    {w.busy > 0 && <span className="wsw-busy"> · {w.busy} trabalhando</span>}
                  </small>
                </span>
              </button>
              <span className="wsw-acts">
                <button
                  className="btn plain icon sm"
                  aria-label={`Renomear ${w.name}`}
                  title="Renomear"
                  onClick={() => setEditing(w.id)}
                >
                  <IconPencil size={13} />
                </button>
                {settings.workspaces.length > 1 && (
                  <button
                    className="btn plain icon sm"
                    aria-label={`Apagar ${w.name}`}
                    title={w.busy ? 'Há agentes trabalhando: pare-os antes de apagar' : 'Apagar'}
                    disabled={w.busy > 0}
                    onClick={() => setConfirming(w.id)}
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </span>
            </li>
          ),
        )}
      </ul>
      {creating ? (
        <NameForm
          initial=""
          label="Criar"
          onCancel={() => setCreating(false)}
          onSubmit={(name) => run(() => api.createWorkspace(name))}
        />
      ) : (
        <button className="wsw-new" onClick={() => setCreating(true)}>
          <IconPlus size={13} /> Novo workspace
        </button>
      )}
      <p className="wsw-hint">
        Cada workspace tem canvas, agentes e projetos próprios. A conexão com o GitLab e as regras de
        permissão valem para todos.
      </p>
    </div>
  );
}

function NameForm({
  initial,
  label,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  onSubmit(name: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <form className="wsw-form" onSubmit={submit}>
      <input
        autoFocus
        value={name}
        maxLength={WORKSPACE_NAME_MAX}
        placeholder="Nome do workspace"
        aria-label="Nome do workspace"
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }}
      />
      <button className="btn primary sm" disabled={!name.trim()}>
        {label}
      </button>
    </form>
  );
}
