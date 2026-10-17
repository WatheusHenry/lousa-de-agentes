import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Approval, ServerMessage } from '@agent-canvas/shared';
import { notifyFor } from './notify.ts';
import { useStore } from './state/store.ts';

const shown: { title: string; body: string }[] = [];
const g = globalThis as unknown as Record<string, unknown>;
let away = true;

beforeEach(() => {
  shown.length = 0;
  away = true;
  localStorage.setItem('ac-notify', '1');
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (away ? 'hidden' : 'visible'),
  });
  document.hasFocus = () => !away;
  g.Notification = class {
    static permission = 'granted';
    onclick: (() => void) | null = null;
    constructor(title: string, o: { body: string }) {
      shown.push({ title, body: o.body });
    }
    close() {}
  };
});
afterEach(() => {
  localStorage.removeItem('ac-notify');
  delete g.Notification;
});

const agent = (status: Agent['status']): Agent =>
  ({ id: 'a1', name: 'agente-1', title: 'Webhook', status, error: null }) as Agent;

describe('notificações do sistema', () => {
  it('avisa permissão nova e agente que terminou, só com o canvas em segundo plano', () => {
    const prev = { ...useStore.getState(), agents: { a1: agent('running') }, approvals: {} };
    const ap = {
      id: 'p1',
      agentId: 'a1',
      toolName: 'Bash',
      summary: 'npm test',
      status: 'pending',
    } as Approval;
    notifyFor({ type: 'approval.upsert', approval: ap } as ServerMessage, prev);
    notifyFor({ type: 'agent.upsert', agent: agent('done') } as ServerMessage, prev);
    expect(shown).toEqual([
      { title: 'agente-1 pede permissão', body: 'Bash(npm test)' },
      { title: 'agente-1 concluiu', body: 'Webhook' },
    ]);

    // pedido já conhecido, agente que já estava parado ou canvas na frente: nada
    shown.length = 0;
    notifyFor({ type: 'approval.upsert', approval: ap } as ServerMessage, { ...prev, approvals: { p1: ap } });
    notifyFor({ type: 'agent.upsert', agent: agent('done') } as ServerMessage, {
      ...prev,
      agents: { a1: agent('idle') },
    });
    away = false;
    notifyFor({ type: 'agent.upsert', agent: agent('error') } as ServerMessage, prev);
    expect(shown).toEqual([]);
  });

  it('desligado no painel: não avisa', () => {
    localStorage.removeItem('ac-notify');
    const prev = { ...useStore.getState(), agents: { a1: agent('running') } };
    notifyFor({ type: 'agent.upsert', agent: agent('done') } as ServerMessage, prev);
    expect(shown).toEqual([]);
  });
});
