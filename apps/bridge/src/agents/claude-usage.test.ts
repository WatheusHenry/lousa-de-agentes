import { describe, expect, it, vi } from 'vitest';
import { ClaudeUsageService, type ClaudeOAuth } from './claude-usage.ts';

const NOW = Date.parse('2026-10-17T15:00:00Z');
const login: ClaudeOAuth = { accessToken: 'tok', expiresAt: NOW + 3_600_000, subscriptionType: 'pro' };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const usageBody = {
  five_hour: { utilization: 79, resets_at: '2026-10-17T19:50:00+00:00' },
  seven_day: { utilization: 72.5, resets_at: '2026-10-19T09:00:00+00:00' },
  seven_day_opus: null,
};

describe('ClaudeUsageService', () => {
  it('lê a sessão de 5 h e a semana com o token do Claude Code', async () => {
    const f = reply(200, usageBody);
    const u = await new ClaudeUsageService(
      async () => login,
      f,
      () => NOW,
    ).get();
    expect(u).toMatchObject({
      fiveHour: { percent: 79, resetsAt: '2026-10-17T19:50:00+00:00' },
      sevenDay: { percent: 72.5 },
      plan: 'pro',
      error: null,
    });
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('guarda por um minuto e só consulta de novo depois (ou com force)', async () => {
    let now = NOW;
    const f = reply(200, usageBody);
    const s = new ClaudeUsageService(
      async () => login,
      f,
      () => now,
    );
    await s.get();
    await s.get();
    expect(f).toHaveBeenCalledTimes(1);
    await s.get(true);
    expect(f).toHaveBeenCalledTimes(2);
    now += 61_000;
    await s.get();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('sem login por assinatura não consulta nada', async () => {
    const f = reply(200, usageBody);
    const u = await new ClaudeUsageService(
      async () => null,
      f,
      () => NOW,
    ).get();
    expect(f).not.toHaveBeenCalled();
    expect(u.fiveHour).toBeNull();
    expect(u.error).toMatch(/Sem login/);
  });

  it('token expirado não é renovado pelo bridge', async () => {
    const f = reply(200, usageBody);
    const u = await new ClaudeUsageService(
      async () => ({ ...login, expiresAt: NOW - 1 }),
      f,
      () => NOW,
    ).get();
    expect(f).not.toHaveBeenCalled();
    expect(u.error).toMatch(/expirou/);
  });

  it('um erro passageiro mantém os últimos números', async () => {
    let now = NOW;
    let ok = true;
    const f = vi.fn(async () =>
      ok ? new Response(JSON.stringify(usageBody)) : new Response('{}', { status: 429 }),
    ) as unknown as typeof fetch;
    const s = new ClaudeUsageService(
      async () => login,
      f,
      () => now,
    );
    await s.get();
    ok = false;
    now += 61_000;
    const u = await s.get();
    expect(u.fiveHour?.percent).toBe(79);
    expect(u.error).toMatch(/429/);
  });
});
