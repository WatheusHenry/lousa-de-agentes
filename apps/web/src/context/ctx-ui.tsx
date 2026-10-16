import { useEffect } from 'react';
import type { Agent, ContextKind } from '@agent-canvas/shared';
import { api } from '../api/http.ts';
import { IconDoc, IconIssue, IconMr, IconNote, IconRepo } from '../icons.tsx';
import { useStore } from '../state/store.ts';

/** Ícone e classe de cor (medidor e chips, como no protótipo) de cada tipo de item. */
export function kindIcon(kind: ContextKind) {
  switch (kind) {
    case 'repo':
      return { cls: 'repo', icon: <IconRepo size={12} /> };
    case 'issue':
      return { cls: 'issue', icon: <IconIssue size={12} /> };
    case 'note':
      return { cls: 'note', icon: <IconNote size={12} /> };
    case 'mr_diff':
      return { cls: 'mr', icon: <IconMr size={12} /> };
    default:
      return { cls: 'doc', icon: <IconDoc size={12} /> };
  }
}

export const meterClass = (kind: ContextKind, summarized: boolean) =>
  summarized
    ? 'k-sum'
    : kind === 'repo'
      ? 'k-repo'
      : kind === 'issue'
        ? 'k-issue'
        : kind === 'note'
          ? 'k-note'
          : 'k-other';

/**
 * Carrega o contexto do agente ao abrir o painel; depois o bridge manda `context.updated`.
 * Recarrega quando muda o que define os itens dos vínculos (issue, repositório, worktree).
 */
export function useAgentContext(a: Agent | undefined) {
  const ctx = useStore((s) => (a ? s.contexts[a.id] : undefined));
  const key = a ? `${a.id}|${a.issueRef}|${a.repos.join(',')}|${a.worktreePath}` : '';
  useEffect(() => {
    if (!a) return;
    let alive = true;
    api
      .agentContext(a.id)
      .then((c) => alive && useStore.setState((s) => ({ contexts: { ...s.contexts, [a.id]: c } })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return ctx;
}
