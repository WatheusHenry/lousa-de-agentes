import type { Agent } from '@agent-canvas/shared';
import { Select } from '../components/Select.tsx';
import { useStore } from '../state/store.ts';

export const MODELS = ['opus', 'sonnet', 'haiku'];

/** Opções de modelo: o padrão (Automações → Agentes), os conhecidos e um id próprio, se houver. */
export function modelOptions(fallback: string | null, current: string | null) {
  const custom = current && !MODELS.includes(current) ? [current] : [];
  return [
    { value: '', label: `padrão · ${fallback ?? 'Claude Code'}`, hint: 'O de Automações → Agentes' },
    ...[...MODELS, ...custom].map((m) => ({ value: m, label: m })),
  ];
}

/**
 * Modelo do agente, no terminal dele: troca na hora e vale a partir do próximo turno
 * (o turno em andamento segue no modelo em que começou).
 */
export function ModelPicker({ agent }: { agent: Agent }) {
  const fallback = useStore((s) => s.settings?.agents.model ?? null);
  const setModel = useStore((s) => s.setAgentModel);
  return (
    <Select
      className="model-chip nodrag"
      label={`Modelo de ${agent.name}`}
      value={agent.model ?? ''}
      onChange={(v) => setModel(agent.id, v || null)}
      options={modelOptions(fallback, agent.model)}
    />
  );
}
