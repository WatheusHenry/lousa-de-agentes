import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventBody } from '@agent-canvas/shared';
import { timeline } from './Timeline.tsx';

let id = 0;
const ev = (body: AgentEventBody): AgentEvent => ({
  id: ++id,
  agentId: 'a',
  ts: '2026-10-16T10:00:00Z',
  body,
});

describe('linha do tempo do agente', () => {
  it('guarda só os marcos: tarefa, permissão, MR, fim e erro', () => {
    const marks = timeline([
      ev({ kind: 'user_message', text: 'Resolva a issue.' }),
      ev({ kind: 'text', text: 'Vou ler o código.' }),
      ev({ kind: 'tool_use', toolUseId: 't1', name: 'Read', summary: 'src/a.ts', input: {} }),
      ev({ kind: 'permission', approvalId: 'p', toolName: 'Bash', summary: 'npm test', status: 'pending' }),
      ev({ kind: 'tool_use', toolUseId: 't2', name: 'Bash', summary: 'git commit -m "x"', input: {} }),
      ev({
        kind: 'tool_use',
        toolUseId: 't3',
        name: 'mcp__canvas__open_merge_request',
        summary: 'Webhook',
        input: {},
      }),
      ev({
        kind: 'result',
        isError: false,
        subtype: 'success',
        text: 'ok',
        costUsd: 0.1,
        numTurns: 3,
        terminalReason: null,
      }),
      ev({ kind: 'error', message: 'O processo terminou' }),
    ]);
    expect(marks.map((m) => [m.k, m.label])).toEqual([
      ['msg', 'Mensagem: Resolva a issue.'],
      ['ask', 'Pediu permissão: Bash(npm test)'],
      ['', 'Fez commit'],
      ['', 'Enviou o merge request'],
      ['done', 'Concluiu o turno'],
      ['bad', 'O processo terminou'],
    ]);
  });
});
