import { describe, expect, it } from 'vitest';
import { ClientMessage, GitLabSettingsInput, issueRef, parseIssueRef, ServerMessage } from './index.ts';

describe('issueRef', () => {
  it('ida e volta', () => {
    expect(issueRef(12, 142)).toBe('12#142');
    expect(parseIssueRef('12#142')).toEqual({ projectId: 12, iid: 142 });
  });
  it('recusa formato inválido', () => {
    expect(() => parseIssueRef('abc')).toThrow();
  });
});

describe('ClientMessage', () => {
  it('aceita note.create válido', () => {
    const r = ClientMessage.safeParse({
      type: 'note.create',
      nodeId: 'n1',
      note: { id: 't1', title: 'Decisões', body: '' },
      x: 10,
      y: 20,
    });
    expect(r.success).toBe(true);
  });
  it('recusa tipo desconhecido e coordenadas inválidas', () => {
    expect(ClientMessage.safeParse({ type: 'agent.hack' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'node.move', nodeId: 'n1', x: Infinity, y: 0 }).success).toBe(
      false,
    );
  });
});

describe('ServerMessage', () => {
  it('aceita activity', () => {
    expect(
      ServerMessage.safeParse({ type: 'activity', text: 'oi', ts: '2026-01-01T00:00:00Z' }).success,
    ).toBe(true);
  });
});

describe('GitLabSettingsInput', () => {
  it('exige URL http(s)', () => {
    expect(GitLabSettingsInput.safeParse({ baseUrl: 'ftp://x' }).success).toBe(false);
    expect(GitLabSettingsInput.safeParse({ baseUrl: 'https://gitlab.com' }).success).toBe(true);
  });
});
