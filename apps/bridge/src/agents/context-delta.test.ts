import { describe, expect, it } from 'vitest';
import { contextDelta } from './supervisor.ts';

describe('o que mudou no contexto', () => {
  const base = '# Contexto\n\n## Repositório\n\n- main\n\n## Nota: Regra\n\nUse event_id.\n';
  it('só as seções novas ou alteradas', () => {
    const next =
      base.replace('Use event_id.', 'Use event_id com TTL de 24h.') + '\n## Nota: Nova\n\nOutra.\n';
    const d = contextDelta(base, next)!;
    expect(d).toContain('TTL de 24h');
    expect(d).toContain('## Nota: Nova');
    expect(d).not.toContain('## Repositório');
  });
  it('nada mudou, ou mudou demais: nulo (o agente lê o arquivo se precisar)', () => {
    expect(contextDelta(base, base)).toBeNull();
    expect(contextDelta(base, `${base}\n## Grande\n\n${'x'.repeat(20_000)}`)).toBeNull();
  });
});
