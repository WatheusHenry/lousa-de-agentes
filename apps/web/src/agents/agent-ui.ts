import type { Agent, AgentStatus } from '@agent-canvas/shared';

export const statusLabel = (s: AgentStatus): string =>
  ({
    idle: 'Pronto',
    queued: 'Na fila',
    running: 'Trabalhando',
    waiting: 'Aguardando você',
    coordinating: 'Coordenando',
    done: 'Concluído',
    paused: 'Pausado',
    stopped: 'Parado',
    error: 'Erro',
  })[s];

export const statusShort = (s: AgentStatus): string => (s === 'waiting' ? 'Aguardando' : statusLabel(s));

export const statusTone = (s: AgentStatus): string =>
  ({
    idle: '',
    queued: '',
    running: 'info live',
    waiting: 'warn',
    coordinating: 'info',
    done: 'ok',
    paused: '',
    stopped: '',
    error: 'bad',
  })[s];

export const LIVE: AgentStatus[] = ['running', 'waiting', 'coordinating'];
export const isLive = (a: Agent | undefined) => !!a && LIVE.includes(a.status);

export const roleLabel = (a: Agent): string =>
  (
    ({
      orchestrator: 'Orquestrador',
      sub: 'Sub-agente',
      explorer: 'Explorador',
      reviewer: 'Revisor',
      fix: 'Correção',
      main: 'Agente',
    }) satisfies Record<Agent['role'], string>
  )[a.role];

export const isBlank = (a: Agent) => !a.sessionId && !a.instruction;

export const fmtK = (n: number): string =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '') + 'k' : String(n);

export const fmtUsd = (n: number): string =>
  n === 0 ? '$0' : n < 0.01 ? '<$0,01' : `$${n.toFixed(2).replace('.', ',')}`;

export const SUGGESTIONS = [
  'Explique o que você mudou',
  'Rode os testes de novo',
  'Adicione um teste para o caso de erro',
  'Mostre os commits que você fez',
];

/** "payments-api", ou "2 repositórios" para o orquestrador. */
export const reposText = (a: Agent, projects: { id: number; name: string }[]): string =>
  a.repos.length > 1
    ? `${a.repos.length} repositórios`
    : (projects.find((p) => p.id === a.repos[0])?.name ?? 'sem repositório');
