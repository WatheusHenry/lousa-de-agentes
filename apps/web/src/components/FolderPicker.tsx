import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, type DirListing } from '../api/http.ts';
import { IconRepo } from '../icons.tsx';

interface Props {
  title: string;
  /** Pasta onde começa (vazia = pasta pessoal). */
  start?: string;
  /** "repo": escolher um clone (os clones ganham o botão Escolher). "dir": qualquer pasta. */
  mode?: 'dir' | 'repo';
  onPick(path: string): void;
  onClose(): void;
}

/**
 * Seletor de pastas servido pelo bridge. O navegador não entrega o caminho real de uma pasta
 * escolhida, então a navegação é feita aqui; quando a máquina tem um seletor nativo (zenity,
 * kdialog ou Finder), ele também fica disponível.
 */
export function FolderPicker({ title, start, mode = 'dir', onPick, onClose }: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [native, setNative] = useState(false);

  async function open(path?: string, showHidden = hidden) {
    setError(null);
    try {
      const l = await api.dirs(path, showHidden);
      setListing(l);
      setNative(l.native);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao listar a pasta.');
      // pasta inicial inválida: cai na pasta pessoal
      if (!listing && path) void open(undefined, showHidden);
    }
  }

  useEffect(() => {
    void open(start || undefined);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function system() {
    try {
      const { path } = await api.pickNative(title, listing?.path);
      if (path) onPick(path);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'O seletor do sistema falhou.');
    }
  }

  const crumbs = listing ? breadcrumbs(listing.path, listing.home) : [];
  const repos = listing?.entries.filter((e) => e.isRepo).length ?? 0;

  // portal: fora de formulários (botões não enviam o form) e sem herdar estilos do campo
  return createPortal(
    <div className="fpick-bg" onClick={onClose}>
      <div
        className="fpick"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fpick-h">
          <b>{title}</b>
          <button type="button" className="btn plain icon" aria-label="Fechar" onClick={onClose}>
            ✕
          </button>
        </div>
        <nav className="fpick-crumbs" aria-label="Caminho">
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="sep">/</span>}
              <button type="button" className="link-btn" onClick={() => open(c.path)}>
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="fpick-list" role="listbox" aria-label="Pastas">
          {listing?.parent && (
            <button type="button" className="fpick-row" onClick={() => open(listing.parent!)}>
              <span className="ico-up">↑</span>
              <span>Pasta acima</span>
            </button>
          )}
          {listing?.entries.map((e) => (
            <div className="fpick-row-w" key={e.path}>
              <button type="button" className="fpick-row" onClick={() => open(e.path)} title={e.path}>
                <span className={e.isRepo ? 'ico-repo' : 'ico-dir'}>{e.isRepo ? <IconRepo /> : '▸'}</span>
                <span className="nm">{e.name}</span>
                {e.isRepo && <span className="badge repo">git</span>}
              </button>
              {mode === 'repo' && e.isRepo && (
                <button type="button" className="btn sm" onClick={() => onPick(e.path)}>
                  Escolher
                </button>
              )}
            </div>
          ))}
          {listing && !listing.entries.length && <p className="tip">Nenhuma subpasta aqui.</p>}
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <div className="fpick-f">
          <label className="fpick-hidden">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked);
                void open(listing?.path, e.target.checked);
              }}
            />
            Pastas ocultas
          </label>
          {native && (
            <button
              type="button"
              className="link-btn"
              onClick={system}
              title="Abre a janela de pastas do sistema"
            >
              Usar o seletor do sistema
            </button>
          )}
          <span className="spacer" />
          <span className="lab">
            {mode === 'dir' && listing
              ? `${repos ? `${repos} clone${repos === 1 ? '' : 's'} aqui` : 'Nenhum clone direto aqui'} · a busca também olha as subpastas`
              : ''}
          </span>
          <button
            className="btn primary"
            disabled={!listing || (mode === 'repo' && !listing.isRepo)}
            onClick={() => listing && onPick(listing.path)}
          >
            {mode === 'repo' ? 'Usar este repositório' : 'Usar esta pasta'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "/home/ana/projetos/x" → ~ / projetos / x (a home vira "~"). */
function breadcrumbs(path: string, home: string) {
  const out: { label: string; path: string }[] = [];
  let rest = path;
  let base = '';
  if (path === home || path.startsWith(home + '/')) {
    out.push({ label: '~', path: home });
    base = home;
    rest = path.slice(home.length);
  } else {
    out.push({ label: '/', path: '/' });
  }
  for (const part of rest.split('/').filter(Boolean)) {
    base = `${base}/${part}`;
    out.push({ label: part, path: base });
  }
  return out;
}
