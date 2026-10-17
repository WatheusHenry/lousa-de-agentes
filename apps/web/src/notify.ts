import type { ServerMessage } from '@agent-canvas/shared';
import { agentNodeOf, mrNodeOf, type CanvasState, useStore } from './state/store.ts';

/**
 * Notificações do sistema (API Notification do navegador) para o que espera você quando o
 * canvas não está na frente: pedido de permissão, pergunta, agente que terminou ou parou com
 * erro, MR pronto para merge e pipeline com falha. Liga e desliga no painel de Automações.
 */
const KEY = 'ac-notify';

export const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window;

export function notifyWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function notifyActive(): boolean {
  return notifySupported() && notifyWanted() && Notification.permission === 'granted';
}

/** Pede a permissão do navegador (precisa de um clique do usuário) e guarda a escolha. */
export async function enableNotify(): Promise<NotificationPermission | 'unsupported'> {
  if (!notifySupported()) return 'unsupported';
  const p =
    Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  try {
    if (p === 'granted') localStorage.setItem(KEY, '1');
  } catch {
    /* sem armazenamento: vale só nesta aba */
  }
  return p;
}

export function disableNotify(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nada a lembrar */
  }
}

/** Só avisa quando o canvas não está na frente (aba escondida ou janela sem foco). */
const away = () => document.visibilityState === 'hidden' || !document.hasFocus();

function show(title: string, body: string, tag: string, open: () => void) {
  try {
    const n = new Notification(title, { body: body.slice(0, 180), tag, silent: false });
    n.onclick = () => {
      window.focus();
      open();
      n.close();
    };
  } catch {
    /* navegador sem suporte a notificação fora de service worker */
  }
}

const LIVE = ['running', 'waiting', 'coordinating'];

/** Chamado com cada mensagem do bridge, antes de ela mudar o estado (para comparar com o anterior). */
export function notifyFor(m: ServerMessage, prev: CanvasState): void {
  if (!notifyActive() || !away()) return;
  const name = (agentId: string) => prev.agents[agentId]?.name ?? 'Um agente';
  const focusAgent = (agentId: string) => () => {
    const n = agentNodeOf(useStore.getState(), agentId);
    if (n) useStore.getState().select(n.id);
  };
  const actions = () => useStore.getState().setTab('actions');

  if (m.type === 'approval.upsert' && m.approval.status === 'pending' && !prev.approvals[m.approval.id]) {
    show(
      `${name(m.approval.agentId)} pede permissão`,
      `${m.approval.toolName}(${m.approval.summary})`,
      `ap-${m.approval.id}`,
      actions,
    );
  } else if (
    m.type === 'question.upsert' &&
    m.question.status === 'pending' &&
    !prev.questions[m.question.id]
  ) {
    show(`${name(m.question.agentId)} perguntou`, m.question.text, `q-${m.question.id}`, actions);
  } else if (m.type === 'agent.upsert') {
    const before = prev.agents[m.agent.id];
    if (!before || !LIVE.includes(before.status)) return;
    if (m.agent.status === 'done')
      show(`${m.agent.name} concluiu`, m.agent.title, `ag-${m.agent.id}`, focusAgent(m.agent.id));
    else if (m.agent.status === 'error')
      show(
        `${m.agent.name} parou com erro`,
        m.agent.error ?? m.agent.title,
        `ag-${m.agent.id}`,
        focusAgent(m.agent.id),
      );
  } else if (m.type === 'mr.upsert' && m.mr.state === 'opened') {
    const before = prev.mergeRequests[m.mr.ref];
    if (!before || before.pipelineStatus === m.mr.pipelineStatus) return;
    const open = () => {
      const n = mrNodeOf(useStore.getState(), m.mr.ref);
      if (n) useStore.getState().select(n.id);
    };
    if (m.mr.pipelineStatus === 'success')
      show(`MR !${m.mr.iid} pronto para merge`, m.mr.title, `mr-${m.mr.ref}`, open);
    else if (m.mr.pipelineStatus === 'failed')
      show(`Pipeline do MR !${m.mr.iid} falhou`, m.mr.title, `mr-${m.mr.ref}`, open);
  }
}
