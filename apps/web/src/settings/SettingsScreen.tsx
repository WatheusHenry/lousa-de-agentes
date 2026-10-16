import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { GitLabProject, SettingsView } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { IconRepo, IconSearch } from '../icons.tsx';

interface Props {
  settings: SettingsView;
  /** Aberta por cima do canvas (já configurado) em vez de tela inteira. */
  modal?: boolean;
  onSaved(s: SettingsView): void;
  onClose?(): void;
}

/** Configuração do GitLab: URL, token e pasta dos repositórios; depois, os projetos do canvas. */
export function SettingsScreen({ settings, modal, onSaved, onClose }: Props) {
  const [step, setStep] = useState<'gitlab' | 'projects'>(settings.configured ? 'projects' : 'gitlab');
  const [current, setCurrent] = useState(settings);

  const done = (s: SettingsView) => {
    setCurrent(s);
    onSaved(s);
  };

  return (
    <div
      className={`setup ${modal ? 'modal' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-title"
    >
      {step === 'gitlab' ? (
        <GitLabStep
          settings={current}
          onClose={onClose}
          onSaved={(s) => {
            done(s);
            setStep('projects');
          }}
        />
      ) : (
        <ProjectsStep settings={current} onBack={() => setStep('gitlab')} onSaved={done} onClose={onClose} />
      )}
    </div>
  );
}

function GitLabStep({
  settings,
  onSaved,
  onClose,
}: {
  settings: SettingsView;
  onSaved(s: SettingsView): void;
  onClose?(): void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState('');
  const [reposDir, setReposDir] = useState(settings.reposDir);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tokenFromEnv = settings.tokenSource === 'env';

  async function save(mode: 'gitlab' | 'demo', e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const view = await api.saveGitLab({
        mode,
        ...(mode === 'gitlab' ? { baseUrl: baseUrl.trim() } : {}),
        ...(mode === 'gitlab' && token.trim() ? { token: token.trim() } : {}),
        ...(reposDir.trim() ? { reposDir: reposDir.trim() } : {}),
      });
      setToken('');
      onSaved(view);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="setup-card" onSubmit={(e) => save('gitlab', e)}>
      <div className="brand">
        <span className="appicon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" />
          </svg>
        </span>
        <b>Agent Canvas</b>
      </div>
      <div>
        <h2 id="setup-title">Conectar ao GitLab</h2>
        <p className="lead">
          O token fica só nesta máquina, num arquivo protegido da pasta do app, nunca no banco nem no
          navegador.
        </p>
      </div>
      <label className="f">
        URL da instância
        <input
          className="field"
          type="url"
          required
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://gitlab.com"
          autoComplete="url"
        />
      </label>
      <label className="f">
        Token de acesso pessoal
        <input
          className="field"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={
            tokenFromEnv
              ? 'Usando AGENT_CANVAS_GITLAB_TOKEN do ambiente'
              : settings.hasToken
                ? 'Token salvo. Preencha só para trocar.'
                : 'glpat-…'
          }
          disabled={tokenFromEnv}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="hint">
          Crie em Preferências → Access tokens, com escopo <code>api</code>. Validamos com GET /user antes de
          salvar.
        </span>
      </label>
      <label className="f">
        Pasta dos repositórios locais
        <input
          className="field mono"
          value={reposDir}
          onChange={(e) => setReposDir(e.target.value)}
          placeholder="~/code"
          spellCheck={false}
        />
        <span className="hint">
          Onde ficam os clones. Os agentes vão trabalhar em worktrees a partir deles.
        </span>
      </label>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {settings.user && settings.mode === 'gitlab' && !error && (
        <p className="ok">
          Conectado como @{settings.user.username} em {settings.baseUrl}
        </p>
      )}
      <div className="row-end">
        <button type="button" className="link-btn" onClick={() => save('demo')} disabled={busy}>
          Usar dados de exemplo
        </button>
        <span className="spacer" />
        {onClose && (
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Validando…' : 'Validar e salvar'}
        </button>
      </div>
    </form>
  );
}

function ProjectsStep({
  settings,
  onBack,
  onSaved,
  onClose,
}: {
  settings: SettingsView;
  onBack(): void;
  onSaved(s: SettingsView): void;
  onClose?(): void;
}) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<GitLabProject[]>([]);
  const [picked, setPicked] = useState<Map<number, GitLabProject>>(
    () => new Map(settings.projects.map((p) => [p.id, p])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .searchProjects(q)
        .then((list) => alive && (setFound(list), setError(null)))
        .catch(
          (err) => alive && setError(err instanceof ApiError ? err.message : 'Falha ao buscar projetos.'),
        );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  // escolhidos primeiro, depois os encontrados na busca
  const list = useMemo(() => {
    const extra = found.filter((p) => !picked.has(p.id));
    return [...picked.values(), ...extra];
  }, [found, picked]);

  const toggle = (p: GitLabProject) =>
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(p.id)) n.delete(p.id);
      else n.set(p.id, p);
      return n;
    });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.selectProjects([...picked.keys()]));
      onClose?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup-card">
      <div>
        <h2 id="setup-title">Escolha os projetos</h2>
        <p className="lead">
          {settings.mode === 'demo'
            ? 'Modo de demonstração, com os projetos de exemplo do protótipo.'
            : `Conectado como @${settings.user?.username} em ${settings.baseUrl}.`}{' '}
          As issues abertas destes projetos aparecem na barra lateral.
        </p>
      </div>
      <div className="search-w">
        <IconSearch />
        <input
          className="field search"
          type="search"
          placeholder="Buscar projetos"
          aria-label="Buscar projetos"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="opts" role="group" aria-label="Projetos">
        {list.length === 0 && <p className="tip">Nenhum projeto encontrado.</p>}
        {list.map((p) => (
          <label className="opt" key={p.id}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p)} />
            <IconRepo />
            <span className="mono">{p.pathWithNamespace}</span>
            {p.description && <small>{p.description.slice(0, 40)}</small>}
          </label>
        ))}
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="row-end">
        <button type="button" className="link-btn" onClick={onBack}>
          Conexão com o GitLab
        </button>
        <span className="spacer" />
        {onClose && (
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
        )}
        <button className="btn primary" onClick={save} disabled={busy || picked.size === 0}>
          {busy ? 'Salvando…' : `Usar ${picked.size} projeto${picked.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
