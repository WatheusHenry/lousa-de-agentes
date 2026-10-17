import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeBrowserUrl, type ServerMessage } from '@agent-canvas/shared';
import { CanvasStore } from '../canvas/canvas-store.ts';
import { openDb } from '../db/index.ts';
import { Hub } from '../hub.ts';
import { BrowserService, isCanvasUrl } from './browser-service.ts';
import { findBrowser } from './chrome.ts';

describe('endereços do navegador', () => {
  it('completa o esquema e recusa o que não é http(s)', () => {
    expect(normalizeBrowserUrl('localhost:5173/x')).toBe('http://localhost:5173/x');
    expect(normalizeBrowserUrl('exemplo.com')).toBe('https://exemplo.com/');
    expect(normalizeBrowserUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
    expect(normalizeBrowserUrl('')).toBe('about:blank');
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull();
  });
  it('reconhece o próprio canvas em qualquer nome local', () => {
    const ports = [4317, 5173];
    expect(isCanvasUrl('http://localhost:5173/', ports)).toBe(true);
    expect(isCanvasUrl('http://127.0.0.2:4317/api/state', ports)).toBe(true);
    expect(isCanvasUrl('http://[::1]:5173', ports)).toBe(true);
    expect(isCanvasUrl('http://app.localhost:5173', ports)).toBe(true);
    expect(isCanvasUrl('http://localhost:3000', ports)).toBe(false);
    expect(isCanvasUrl('https://exemplo.com:5173', ports)).toBe(false);
  });
});

const PAGE = `<!doctype html><title>Teste</title>
<h1>Olá</h1>
<label for="q">Busca</label><input id="q" placeholder="digite">
<button onclick="document.getElementById('out').textContent='clicou ' + document.getElementById('q').value; console.log('log da página')">Enviar</button>
<a href="/dois">Outra página</a>
<p id="out"></p>`;

const bin = findBrowser();

/** Usa o Chrome/Edge desta máquina; sem nenhum instalado, o teste é pulado. */
describe.skipIf(!bin)('navegador de verdade (Chrome headless)', () => {
  let http: Server;
  let base = '';
  const home = mkdtempSync(join(tmpdir(), 'agent-canvas-browser-'));
  const { db, close } = openDb(':memory:');
  const store = new CanvasStore(db);
  const hub = new Hub();
  const sent: ServerMessage[] = [];
  hub.broadcast = (m) => void sent.push(...(Array.isArray(m) ? m : [m]));
  // a porta do servidor de teste é sorteada; a do "canvas" é outra, fixa
  let canvas: Server;
  let canvasPort = 0;
  const blockedPorts: number[] = [];
  const svc = new BrowserService({ db, hub, store, home, bin, blockedPorts });

  beforeAll(async () => {
    http = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(req.url === '/dois' ? '<title>Dois</title><p>segunda página</p>' : PAGE);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const addr = http.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    canvas = createServer((_req, res) => res.end('<title>Canvas</title>token-secreto'));
    await new Promise<void>((r) => canvas.listen(0, '127.0.0.1', r));
    canvasPort = (canvas.address() as { port: number }).port;
    blockedPorts.push(canvasPort);
  });

  afterAll(async () => {
    await svc.shutdown();
    http.close();
    canvas.close();
    close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('abre, lê, digita, clica, navega e manda quadros da tela', async () => {
    const b = svc.create({ url: `${base}/`, at: { x: 0, y: 0 } });
    expect(store.liveNodes().some((n) => n.type === 'browser' && n.refId === b.id)).toBe(true);
    await svc.watch(b.id);
    expect(svc.get(b.id)).toMatchObject({ status: 'ready', title: 'Teste' });

    const snap = await svc.snapshot(b.id);
    expect(snap).toContain('# Olá');
    const input = /\[(\d+)\] textbox "Busca"/.exec(snap);
    const button = /\[(\d+)\] button "Enviar"/.exec(snap);
    expect(input && button).toBeTruthy();

    await svc.type(b.id, Number(input![1]), 'canvas', {});
    await svc.click(b.id, Number(button![1]));
    expect(await svc.evaluate(b.id, "document.getElementById('out').textContent")).toBe('clicou canvas');
    expect(svc.consoleLog(b.id)).toContain('[log] log da página');

    const link = /\[(\d+)\] link "Outra página"/.exec(await svc.snapshot(b.id));
    await svc.click(b.id, Number(link![1]));
    await svc.waitFor(b.id, { text: 'segunda página' });
    await new Promise((r) => setTimeout(r, 300));
    expect(svc.get(b.id)).toMatchObject({ url: `${base}/dois`, title: 'Dois', canBack: true });

    await svc.navigate(b.id, { action: 'back' });
    expect(svc.get(b.id)!.url).toBe(`${base}/`);

    expect((await svc.screenshot(b.id)).length).toBeGreaterThan(1000);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.some((m) => m.type === 'browser.frame' && m.browserId === b.id)).toBe(true);

    // o agente sem navegador ganha um; a segunda chamada reaproveita o mesmo
    const mine = svc.forAgent('a_x', `${base}/`);
    expect(mine.created).toBe(true);
    expect(svc.forAgent('a_x').browser.id).toBe(mine.browser.id);

    // o próprio canvas não abre: nem direto, nem por fetch de dentro de outra página
    await expect(svc.navigate(b.id, { url: `http://localhost:${canvasPort}/` })).rejects.toThrow(
      /próprio Agent Canvas/,
    );
    const leaked = await svc.evaluate(
      b.id,
      `fetch('http://127.0.0.1:${canvasPort}/', { mode: 'no-cors' }).then((r) => r.text()).catch(() => 'bloqueado')`,
    );
    expect(leaked).toBe('bloqueado');
    expect(svc.consoleLog(b.id).some((l) => l.startsWith('[bloqueado]'))).toBe(true);
    expect(() => svc.create({ url: `127.0.0.1:${canvasPort}` })).toThrow(/próprio Agent Canvas/);

    // fechar a aba guarda o endereço; ao olhar de novo, reabre no mesmo lugar
    await svc.close(b.id);
    expect(svc.get(b.id)!.status).toBe('off');
    await svc.watch(b.id);
    expect(svc.get(b.id)).toMatchObject({ status: 'ready', url: `${base}/` });
  }, 60_000);
});
