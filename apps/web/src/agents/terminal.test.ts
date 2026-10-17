import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventBody } from '@agent-canvas/shared';
import { groupLabel, readKind, segments, splitShell } from './terminal.ts';

let id = 0;
const ev = (body: AgentEventBody): AgentEvent => ({ id: ++id, agentId: 'a', ts: '', body }) as AgentEvent;
const use = (name: string, command = '', toolUseId = `t${id + 1}`) =>
  ev({ kind: 'tool_use', toolUseId, name, summary: command || 'x', input: { command } });
const res = (toolUseId: string, isError = false) =>
  ev({ kind: 'tool_result', toolUseId, content: 'ok', isError, truncated: false });

describe('terminal do agente', () => {
  it('quebra comandos encadeados fora de aspas e heredocs', () => {
    expect(splitShell(`cat a.txt; echo "x && y" && npm test | tail -5`)).toEqual([
      { sep: '', part: 'cat a.txt' },
      { sep: ';', part: 'echo "x && y"' },
      { sep: '&&', part: 'npm test' },
      { sep: '|', part: 'tail -5' },
    ]);
    expect(splitShell(`cat > a.js <<'EOF'\nx; y\nEOF`)).toHaveLength(1);
  });

  it('reconhece leituras: Read, buscas e comandos que só leem', () => {
    expect(readKind(use('Read'))).toBe('read');
    expect(readKind(use('Grep'))).toBe('search');
    expect(readKind(use('Bash', 'cat .agent-canvas/context.md; git status; ls'))).toBe('read');
    expect(readKind(use('Bash', 'grep -rn foo src'))).toBe('search');
    expect(readKind(use('Bash', 'ls -la'))).toBe('list');
    expect(readKind(use('Bash', 'npm test'))).toBeNull();
    expect(readKind(use('Bash', 'echo x > a.txt'))).toBeNull();
    expect(readKind(use('Edit'))).toBeNull();
  });

  it('agrupa leituras seguidas com os resultados; uma só fica solta; erro quebra o grupo', () => {
    const a = use('Read', '', 'r1');
    const b = use('Grep', '', 'r2');
    const edit = use('Edit', '', 'e1');
    const c = use('Read', '', 'r3');
    const segs = segments([a, res('r1'), b, res('r2'), edit, res('e1'), c, res('r3', true)]);
    expect(segs.map((s) => s.type)).toEqual(['reads', 'event', 'event', 'event', 'event']);
    expect(segs[0]).toMatchObject({ type: 'reads', kinds: ['read', 'search'] });
    expect(groupLabel(['read', 'read', 'search', 'list'])).toBe('Leu 2 arquivos · 1 busca · listou 1 pasta');
  });
});
