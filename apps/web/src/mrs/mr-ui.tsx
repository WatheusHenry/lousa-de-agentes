import { useState } from 'react';
import { isLocalProject, type MergeRequest } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { useStore } from '../state/store.ts';

/** Revisão local: branch de um agente num repositório fora do GitLab, revisado no canvas. */
export const isLocalMr = (m: Pick<MergeRequest, 'projectId'>) => isLocalProject(m.projectId);
/** "MR !12" ou "Revisão #3". */
export const mrName = (m: Pick<MergeRequest, 'projectId' | 'iid'>) =>
  isLocalMr(m) ? `Revisão #${m.iid}` : `MR !${m.iid}`;
/** "!12" ou "#3", para listas curtas. */
export const mrNum = (m: Pick<MergeRequest, 'projectId' | 'iid'>) =>
  isLocalMr(m) ? `#${m.iid}` : `!${m.iid}`;

/** Badge de estado do MR / pipeline, como o `mrBadge` do protótipo. */
export function MrBadge({ mr }: { mr: MergeRequest }) {
  if (mr.state === 'merged') return <span className="badge mrb">Mergeado</span>;
  if (mr.state === 'closed') return <span className="badge">Fechado</span>;
  if (isLocalMr(mr))
    return (
      <span className="badge info">
        <span className="d" />
        Para revisar
      </span>
    );
  const p = mr.pipelineStatus;
  if (p === 'failed')
    return (
      <span className="badge bad">
        <span className="d" />
        Pipeline falhou
      </span>
    );
  if (p === 'success')
    return (
      <span className="badge ok">
        <span className="d" />
        Pipeline passou
      </span>
    );
  if (p === 'running' || p === 'pending' || p === 'created')
    return (
      <span className="badge info live">
        <span className="d" />
        Pipeline rodando
      </span>
    );
  if (p === 'canceled') return <span className="badge">Pipeline cancelado</span>;
  if (p === 'manual') return <span className="badge warn">Pipeline manual</span>;
  return <span className="badge">Sem pipeline</span>;
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="diffstat">
      <span className="a">+{add}</span> <span className="r">−{del}</span>
    </span>
  );
}

/** Pronto para o merge humano: aberto e com pipeline verde (ou sem pipeline configurado). */
export const mrReady = (m: MergeRequest) =>
  m.state === 'opened' && (m.pipelineStatus === 'success' || m.pipelineStatus === 'none');

export const mrFailed = (m: MergeRequest) => m.state === 'opened' && m.pipelineStatus === 'failed';

/** Etapas desenhadas no foco: o GitLab dá só o status geral, então o desenho é aproximado. */
export function PipelineStages({ mr }: { mr: MergeRequest }) {
  const p = mr.pipelineStatus;
  if (p === 'none')
    return (
      <p className="lab" style={{ margin: 0 }}>
        Este projeto não tem pipeline para o MR.
      </p>
    );
  const st: [string, string, string] =
    p === 'success'
      ? ['ok', 'ok', 'ok']
      : p === 'failed'
        ? ['ok', 'bad', '']
        : p === 'canceled' || p === 'skipped'
          ? ['', '', '']
          : ['ok', 'run', ''];
  const names = ['Build', 'Testes', 'Lint'];
  return (
    <div className="pipe">
      {names.map((nm, j) => (
        <span key={nm} style={{ display: 'contents' }}>
          {j > 0 && <span className="ln" />}
          <span className={`stage ${st[j]}`}>
            {st[j] === 'ok' ? (
              '✓'
            ) : st[j] === 'bad' ? (
              '✕'
            ) : st[j] === 'run' ? (
              <span className="badge-dot" />
            ) : (
              '○'
            )}{' '}
            {nm}
          </span>
        </span>
      ))}
    </div>
  );
}

const REMOTE_NAME = { gitlab: 'GitLab', github: 'GitHub', other: 'remoto' } as const;

/**
 * Revisão local com remoto: "Enviar ao GitHub/GitLab" faz o push com as credenciais git do
 * usuário. No GitLab o MR já nasce no push; no GitHub abre a página do PR preenchida. Depois do
 * envio, vira o link para o MR/PR.
 */
export function PublishButton({ mr, className = 'btn' }: { mr: MergeRequest; className?: string }) {
  const remote = useStore((s) => s.settings?.projects.find((p) => p.id === mr.projectId)?.remote ?? null);
  const [busy, setBusy] = useState(false);
  if (!isLocalMr(mr) || !remote || mr.state !== 'opened') return null;
  const where = REMOTE_NAME[remote];
  const what = remote === 'github' ? 'PR' : 'MR';
  if (mr.publishedTo)
    return mr.remoteUrl ? (
      <a className={className} href={mr.remoteUrl} target="_blank" rel="noreferrer noopener">
        {remote === 'other' ? 'Branch enviado' : `Abrir ${what} no ${where}`}
      </a>
    ) : (
      <span className="lab">Branch enviado ao {where}.</span>
    );
  const publish = async () => {
    setBusy(true);
    const st = useStore.getState();
    try {
      const m = await api.publishMr(mr.ref);
      st.applyServer({ type: 'mr.upsert', mr: m });
      const url = m.remoteUrl;
      st.showToast(
        remote === 'github'
          ? 'Branch enviado ao GitHub. Confirme o PR na página que abriu.'
          : remote === 'gitlab'
            ? 'Branch enviado ao GitLab com o MR.'
            : 'Branch enviado ao remoto.',
        url
          ? { label: `Abrir ${what}`, run: () => window.open(url, '_blank', 'noopener') }
          : { label: 'Ok', run: () => {} },
      );
      if (url && remote === 'github') window.open(url, '_blank', 'noopener');
    } catch (e) {
      st.showToast(e instanceof ApiError ? e.message : 'O envio falhou.', { label: 'Ok', run: () => {} });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className={className}
      disabled={busy}
      title={`git push do branch ${mr.sourceBranch} com as suas credenciais${remote === 'other' ? '' : `, e abre o ${what}`}`}
      onClick={() => void publish()}
    >
      {busy
        ? 'Enviando…'
        : remote === 'other'
          ? 'Enviar branch ao remoto'
          : `Enviar ao ${where} e abrir ${what}`}
    </button>
  );
}
