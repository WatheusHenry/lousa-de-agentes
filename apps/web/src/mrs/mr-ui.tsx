import type { MergeRequest } from '@agent-canvas/shared';

/** Badge de estado do MR / pipeline, como o `mrBadge` do protótipo. */
export function MrBadge({ mr }: { mr: MergeRequest }) {
  if (mr.state === 'merged') return <span className="badge mrb">Mergeado</span>;
  if (mr.state === 'closed') return <span className="badge">Fechado</span>;
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
