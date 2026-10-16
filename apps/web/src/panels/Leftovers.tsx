import { useCallback, useEffect, useState } from 'react';
import type { WorktreeLeftover } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { useStore } from '../state/store.ts';

const shortPath = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, '~');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Pastas de trabalho de agentes removidos do canvas. Apagar pede confirmação e mostra antes
 * o que se perderia (arquivos sem commit); o branch continua no clone.
 */
export function Leftovers() {
  const [list, setList] = useState<WorktreeLeftover[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // agentes saindo do canvas (ou voltando) mudam a lista
  const agentNodes = useStore((s) => Object.values(s.nodes).filter((n) => n.type === 'agent').length);

  const load = useCallback(async () => {
    try {
      const l = await api.leftovers();
      setList(l);
      setChosen(new Set(l.map((x) => x.agentId)));
    } catch {
      setList([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, agentNodes]);

  if (!list.length) return null;
  const picked = list.filter((x) => chosen.has(x.agentId));
  const lost = picked.reduce((n, x) => n + x.uncommitted, 0);

  async function remove() {
    setBusy(true);
    try {
      const res = await api.cleanupWorktrees(picked.map((x) => x.agentId));
      const msg = res.errors.length
        ? `${plural(res.removed.length, 'pasta apagada', 'pastas apagadas')}; ${res.errors[0]!.error}`
        : `${plural(res.removed.length, 'pasta apagada', 'pastas apagadas')}. Os branches continuam nos clones.`;
      useStore.getState().showToast(msg, { label: 'Ok', run: () => {} });
    } catch (e) {
      useStore.getState().showToast(e instanceof ApiError ? e.message : 'Falha ao apagar as pastas.', {
        label: 'Ok',
        run: () => {},
      });
    } finally {
      setBusy(false);
      setConfirming(false);
      void load();
    }
  }

  return (
    <>
      <div className="grp-h">
        <span>Pastas de agentes removidos</span>
        <span className="cnt">{list.length}</span>
      </div>
      {list.map((x) => (
        <label className="act-card leftover" key={x.agentId}>
          <div className="act-top">
            <input
              type="checkbox"
              checked={chosen.has(x.agentId)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(x.agentId);
                else next.delete(x.agentId);
                setChosen(next);
                setConfirming(false);
              }}
              aria-label={`Apagar a pasta de ${x.name}`}
            />
            <b>{x.name}</b>
            <span className="lab mono" title={x.path}>
              {x.kind === 'workspace' ? 'pasta do orquestrador' : (x.branch ?? shortPath(x.path))}
            </span>
          </div>
          {(x.uncommitted > 0 || x.unpushed > 0) && (
            <div className="act-btns">
              {x.uncommitted > 0 && (
                <span className="badge warn">
                  {plural(x.uncommitted, 'arquivo sem commit', 'arquivos sem commit')}
                </span>
              )}
              {x.unpushed > 0 && (
                <span className="badge" title="Ficam no branch do clone; só a pasta sai">
                  {plural(x.unpushed, 'commit não enviado', 'commits não enviados')}
                </span>
              )}
            </div>
          )}
        </label>
      ))}
      {confirming ? (
        <div className="callout" role="alertdialog" aria-label="Confirmar limpeza">
          <span>
            Apagar {plural(picked.length, 'pasta', 'pastas')}? Os branches continuam no clone
            {lost
              ? `, mas ${plural(lost, 'arquivo sem commit se perde', 'arquivos sem commit se perdem')}`
              : ''}
            .
          </span>
          <div className="act-btns">
            <button className="btn sm danger" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Apagando…' : 'Apagar'}
            </button>
            <button className="btn sm plain" disabled={busy} onClick={() => setConfirming(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="act-btns" style={{ margin: '0 2px 8px' }}>
          <button className="btn sm" disabled={!picked.length} onClick={() => setConfirming(true)}>
            Apagar {plural(picked.length, 'pasta', 'pastas')}…
          </button>
        </div>
      )}
    </>
  );
}
