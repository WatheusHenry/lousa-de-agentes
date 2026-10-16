import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLine, summarizeTool } from './stream-parser.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n');
const parseAll = (name: string) => fixture(name).map(parseLine);

describe('stream-parser com saídas reais', () => {
  it('turno com ferramentas, permissão negada e segunda mensagem', () => {
    const parsed = parseAll('tools-permission');
    const events = parsed.flatMap((p) => p.events);
    const kinds = events.map((e) => e.kind);

    expect(events[0]).toMatchObject({ kind: 'init', sessionId: '00000000-0000-4000-8000-000000000001' });
    // dois turnos: duas inicializações e dois results
    expect(kinds.filter((k) => k === 'init')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'result')).toHaveLength(2);

    const tools = events.filter((e) => e.kind === 'tool_use');
    expect(tools.map((t) => t.kind === 'tool_use' && `${t.name}(${t.summary})`)).toEqual(
      expect.arrayContaining(['Bash(npm test)', 'Bash(rm notes.txt)']),
    );

    // o rm negado pelo approve volta como tool_result com erro
    const rm = tools.find((t) => t.kind === 'tool_use' && t.summary === 'rm notes.txt')!;
    const denied = events.find(
      (e) => e.kind === 'tool_result' && rm.kind === 'tool_use' && e.toolUseId === rm.toolUseId,
    );
    expect(denied).toMatchObject({ isError: true, content: 'Negado pelo usuário no canvas.' });

    const test = events.find((e) => e.kind === 'tool_result' && e.content.includes('1 passed'));
    expect(test).toMatchObject({ isError: false });

    expect(events.some((e) => e.kind === 'text' && e.text.length > 0)).toBe(true);

    const turns = parsed.filter((p) => p.turn).map((p) => p.turn!);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ isError: false, subtype: 'success' });
    expect(turns[0]!.inputTokens).toBeGreaterThan(0);
    expect(turns[0]!.outputTokens).toBeGreaterThan(0);
    expect(turns[0]!.costUsd).toBeGreaterThan(0);
    expect(parsed.some((p) => (p.contextTokens ?? 0) > 0)).toBe(true);
  });

  it('interrupção: resposta de controle e result abortado', () => {
    const parsed = parseAll('interrupt');
    expect(parsed.find((p) => p.controlResponse)?.controlResponse).toEqual({ requestId: 'int-1', ok: true });
    const result = parsed.flatMap((p) => p.events).find((e) => e.kind === 'result');
    expect(result).toMatchObject({
      isError: true,
      subtype: 'error_during_execution',
      terminalReason: 'aborted_tools',
    });
  });

  it('retomada mantém a mesma sessão e termina com sucesso', () => {
    const parsed = parseAll('resume');
    expect(parsed.find((p) => p.sessionId)?.sessionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(parsed.flatMap((p) => p.events).at(-1)).toMatchObject({
      kind: 'result',
      isError: false,
      text: 'pronto',
    });
  });

  it('linhas desconhecidas ou quebradas não derrubam o parser', () => {
    expect(parseLine('não é json')).toEqual({ events: [] });
    expect(parseLine('{"type":"algo_novo","x":1}')).toEqual({ events: [] });
    expect(parseLine('{"type":"assistant","message":{"content":"inesperado"}}')).toEqual({ events: [] });
    expect(
      parseLine(
        '{"type":"assistant","message":{"content":[{"type":"bloco_novo"},{"type":"text","text":"oi"}]}}',
      ).events,
    ).toEqual([{ kind: 'text', text: 'oi' }]);
  });

  it('ignora mensagens de sub-agentes internos', () => {
    expect(
      parseLine(
        '{"type":"assistant","parent_tool_use_id":"toolu_x","message":{"content":[{"type":"text","text":"interno"}]}}',
      ).events,
    ).toEqual([]);
  });
});

describe('summarizeTool', () => {
  it('resume as ferramentas mais comuns', () => {
    expect(summarizeTool('Bash', { command: 'npm test\necho x' })).toBe('npm test');
    expect(summarizeTool('Read', { file_path: '/tmp/repo/src/app.ts' })).toBe('src/app.ts');
    expect(summarizeTool('Edit', { file_path: '/h/.agent-canvas/worktrees/a_1/README.md' })).toBe(
      'README.md',
    );
    expect(summarizeTool('Edit', { file_path: '/h/.agent-canvas/worktrees/a_1/src/x/y.ts' })).toBe(
      'src/x/y.ts',
    );
    expect(summarizeTool('Grep', { pattern: 'idempotency' })).toBe('idempotency');
    expect(summarizeTool('mcp__canvas__x', { foo: 'bar' })).toBe('bar');
  });
});
