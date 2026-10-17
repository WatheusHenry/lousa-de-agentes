import type { Agent } from '@agent-canvas/shared';
import { useStore } from '../state/store.ts';

/**
 * Modo automático do agente, como no Claude Code: ligado, o agente faz tudo sem pedir
 * permissão (menos o que as travas negam). Shift+Tab no campo de mensagem alterna.
 */
export function AutoModeToggle({ agent, full = false }: { agent: Agent; full?: boolean }) {
  const setMode = useStore((s) => s.setAgentMode);
  const on = agent.autoMode;
  return (
    <button
      type="button"
      className={`auto-chip nodrag${on ? ' on' : ''}`}
      aria-pressed={on}
      title={
        on
          ? 'Modo automático: faz tudo sem pedir permissão, menos push, sudo, merge e arquivos fora do worktree. Clique (ou Shift+Tab) para voltar a pedir.'
          : 'Pede permissão a cada passo. Clique (ou Shift+Tab) para o modo automático.'
      }
      onClick={() => setMode(agent.id, !on)}
    >
      <span aria-hidden="true">{on ? '⏵⏵' : '✋'}</span>
      {full ? (on ? 'modo automático' : 'pede permissão') : on ? 'auto' : 'pede'}
      {full && <kbd>Shift+Tab</kbd>}
    </button>
  );
}

/** Shift+Tab no campo de mensagem alterna o modo (devolve true se tratou a tecla). */
export function autoModeKey(
  e: { key: string; shiftKey: boolean; preventDefault(): void },
  agent: Agent,
): boolean {
  if (e.key !== 'Tab' || !e.shiftKey) return false;
  e.preventDefault();
  useStore.getState().setAgentMode(agent.id, !agent.autoMode);
  return true;
}
