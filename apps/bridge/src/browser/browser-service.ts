import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  BROWSER_VIEWPORT,
  normalizeBrowserUrl,
  type Browser,
  type BrowserInput,
  type ServerMessage,
} from '@agent-canvas/shared';
import type { CanvasStore } from '../canvas/canvas-store.ts';
import type { Db } from '../db/index.ts';
import { browser as browserT } from '../db/schema.ts';
import type { Hub } from '../hub.ts';
import { BrowserError, Chrome, findBrowser } from './chrome.ts';
import { FOCUS_REF_JS, REF_CENTER_JS, SNAPSHOT_JS } from './page-scripts.ts';

export { BrowserError } from './chrome.ts';

const nowIso = () => new Date().toISOString();
const newId = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SNAPSHOT_MAX = 30_000;
const CONSOLE_MAX = 200;
/** Intervalo mínimo entre dois quadros da tela enviados ao front (~12 por segundo). */
const FRAME_EVERY_MS = 80;

/** Teclas que o agente pode apertar com browser_press. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};
export const BROWSER_KEYS = Object.keys(KEYS);

interface Page {
  targetId: string;
  sessionId: string;
  lastFrame: { data: string; width: number; height: number } | null;
  frameTimer: ReturnType<typeof setTimeout> | null;
  lastFrameAt: number;
  console: string[];
  loadWaiters: (() => void)[];
  refreshTimer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserDeps {
  db: Db;
  hub: Hub;
  store: CanvasStore;
  /** Pasta de dados: o perfil do navegador fica em <home>/browser-profile. */
  home: string;
  /** Executável do navegador (os testes passam o que acharem). */
  bin?: string | null;
}

/**
 * Navegadores do canvas: abas de um Chrome headless (perfil próprio, sem os seus logins) que o
 * usuário vê e usa pelo cartão (screencast) e que os agentes usam pelas ferramentas browser_*.
 * O Chrome só abre quando um navegador é usado; depois de reiniciar, cada aba reabre no último
 * endereço quando o cartão aparece ou o agente volta a usá-la.
 */
export class BrowserService {
  private chrome: Promise<Chrome> | null = null;
  private readonly pages = new Map<string, Page>();
  private readonly opening = new Map<string, Promise<Page>>();
  private readonly state = new Map<string, Browser>();
  private offCdp: (() => void) | null = null;

  constructor(private readonly d: BrowserDeps) {}

  // ---------- leitura ----------

  get(id: string): Browser | null {
    const known = this.state.get(id);
    if (known) return known;
    const r = this.d.db.select().from(browserT).where(eq(browserT.id, id)).get();
    if (!r) return null;
    const b: Browser = {
      id: r.id,
      url: r.url,
      title: r.title,
      ownerAgentId: r.ownerAgentId,
      status: 'off',
      error: null,
      canBack: false,
      canForward: false,
    };
    this.state.set(id, b);
    return b;
  }

  /** Navegadores com nó vivo no canvas. */
  list(): Browser[] {
    return this.d.store
      .liveNodes()
      .filter((n) => n.type === 'browser')
      .map((n) => this.get(n.refId))
      .filter((b): b is Browser => !!b);
  }

  /** Navegador do agente (o mais recente com nó no canvas). */
  ofAgent(agentId: string): Browser | null {
    const rows = this.d.db.select().from(browserT).where(eq(browserT.ownerAgentId, agentId)).all();
    const live = rows
      .filter((r) => this.d.store.liveNodeOf('browser', r.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return live ? this.get(live.id) : null;
  }

  // ---------- criar e fechar ----------

  /** Cria o navegador e o nó dele. A página abre em segundo plano. */
  create(o: {
    browserId?: string;
    nodeId?: string;
    url?: string;
    agentId?: string | null;
    at?: { x: number; y: number };
  }): Browser {
    const url = normalizeBrowserUrl(o.url ?? '') ?? 'about:blank';
    const id = o.browserId ?? newId('b');
    if (this.get(id)) throw new BrowserError('Navegador já existe.');
    this.d.db
      .insert(browserT)
      .values({ id, url, title: '', ownerAgentId: o.agentId ?? null, createdAt: nowIso() })
      .run();
    const agentNode = o.agentId ? this.d.store.liveNodeOf('agent', o.agentId) : null;
    const out = this.d.store.placeBrowser({
      nodeId: o.nodeId ?? newId('n'),
      browserId: id,
      ...(o.at ? { at: o.at } : {}),
      ...(agentNode ? { agentNodeId: agentNode.id } : {}),
    });
    const b = this.get(id)!;
    this.d.hub.broadcast([
      { type: 'browser.upsert', browser: b },
      ...out,
      this.d.store.logActivity(`Navegador aberto${url !== 'about:blank' ? ` em ${hostOf(url)}` : ''}`),
    ]);
    void this.page(id).catch(() => {});
    return b;
  }

  /** O nó saiu do canvas: fecha a aba (o endereço fica, para desfazer). */
  async close(id: string): Promise<void> {
    const p = this.pages.get(id);
    this.pages.delete(id);
    const b = this.state.get(id);
    if (b) this.patch(id, { status: 'off' }, false);
    if (!p || !this.chrome) return;
    if (p.frameTimer) clearTimeout(p.frameTimer);
    if (p.refreshTimer) clearTimeout(p.refreshTimer);
    const chrome = await this.chrome.catch(() => null);
    await chrome?.cdp.send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.offCdp?.();
    const chrome = await this.chrome?.catch(() => null);
    this.chrome = null;
    this.pages.clear();
    await chrome?.close();
  }

  // ---------- usuário (cartão no canvas) ----------

  /** O cartão apareceu: abre a página se precisar e reenvia o último quadro. */
  async watch(id: string): Promise<void> {
    const p = await this.page(id);
    const b = this.get(id)!;
    this.d.hub.broadcast([{ type: 'browser.upsert', browser: b }]);
    if (p.lastFrame) this.d.hub.broadcast([{ type: 'browser.frame', browserId: id, ...p.lastFrame }]);
  }

  async navigate(id: string, o: { url?: string; action?: 'back' | 'forward' | 'reload' }): Promise<string> {
    const p = await this.page(id);
    const cdp = await this.cdp();
    if (o.action === 'reload') {
      const loaded = this.waitLoad(p);
      await cdp.send('Page.reload', {}, p.sessionId);
      await loaded;
    } else if (o.action) {
      const h = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
        'Page.getNavigationHistory',
        {},
        p.sessionId,
      );
      const entry = h.entries[h.currentIndex + (o.action === 'back' ? -1 : 1)];
      if (!entry) throw new BrowserError(o.action === 'back' ? 'Não há página anterior.' : 'Não há próxima página.');
      const loaded = this.waitLoad(p);
      await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, p.sessionId);
      await loaded;
    } else {
      const url = normalizeBrowserUrl(o.url ?? '');
      if (!url) throw new BrowserError('Endereço inválido: use http:// ou https://.');
      this.patch(id, { status: 'loading', url, error: null });
      const loaded = this.waitLoad(p);
      const r = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, p.sessionId);
      if (r.errorText) {
        this.patch(id, { status: 'error', error: `Não abriu ${url}: ${r.errorText}` });
        throw new BrowserError(`Não abriu ${url}: ${r.errorText}`);
      }
      await loaded;
    }
    await this.refresh(id);
    return this.get(id)!.url;
  }

  /** Clique, rolagem e teclado do usuário na tela do cartão. */
  async input(id: string, ev: BrowserInput): Promise<void> {
    const p = this.pages.get(id) ?? (await this.page(id));
    const cdp = await this.cdp();
    const s = p.sessionId;
    if (ev.kind === 'mouse')
      await cdp.send(
        'Input.dispatchMouseEvent',
        {
          type: ev.type,
          x: ev.x,
          y: ev.y,
          button: ev.type === 'mouseMoved' ? 'none' : ev.button,
          buttons: ev.type === 'mousePressed' ? 1 : 0,
          clickCount: ev.type === 'mouseMoved' ? 0 : ev.clickCount,
          modifiers: ev.modifiers,
        },
        s,
      );
    else if (ev.kind === 'wheel')
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy },
        s,
      );
    else if (ev.kind === 'key')
      await cdp.send(
        'Input.dispatchKeyEvent',
        {
          type: ev.type === 'keyDown' && ev.text ? 'keyDown' : ev.type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
          key: ev.key,
          code: ev.code,
          windowsVirtualKeyCode: ev.keyCode,
          modifiers: ev.modifiers,
          ...(ev.text && ev.type === 'keyDown' ? { text: ev.text, unmodifiedText: ev.text } : {}),
        },
        s,
      );
    else await cdp.send('Input.insertText', { text: ev.text }, s);
  }

  // ---------- agentes (ferramentas browser_*) ----------

  /** Navegador do agente, criado ao lado dele na primeira vez. */
  forAgent(agentId: string, url?: string): { browser: Browser; created: boolean } {
    const own = this.ofAgent(agentId);
    if (own) return { browser: own, created: false };
    return { browser: this.create({ agentId, ...(url ? { url } : {}) }), created: true };
  }

  async snapshot(id: string): Promise<string> {
    await this.page(id);
    return String(await this.evaluate(id, SNAPSHOT_JS(SNAPSHOT_MAX), false));
  }

  async click(id: string, ref: number, opts: { double?: boolean } = {}): Promise<void> {
    const at = await this.evaluate(id, REF_CENTER_JS(ref), false);
    if (typeof at === 'string') throw new BrowserError(at);
    const { x, y } = at as { x: number; y: number };
    const p = await this.page(id);
    const cdp = await this.cdp();
    const clicks = opts.double ? 2 : 1;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, p.sessionId);
    for (let c = 1; c <= clicks; c++) {
      const base = { x, y, button: 'left', clickCount: c };
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, p.sessionId);
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, p.sessionId);
    }
    await this.settle(p);
  }

  async type(id: string, ref: number | null, text: string, opts: { clear?: boolean; submit?: boolean }) {
    const p = await this.page(id);
    if (ref !== null) {
      const err = await this.evaluate(id, FOCUS_REF_JS(ref, opts.clear ?? true), false);
      if (typeof err === 'string') throw new BrowserError(err);
    }
    const cdp = await this.cdp();
    if (text) await cdp.send('Input.insertText', { text }, p.sessionId);
    if (opts.submit) await this.press(id, 'Enter');
    else await this.settle(p, 150);
  }

  async press(id: string, key: string): Promise<void> {
    const k = KEYS[key];
    const single = !k && [...key].length === 1;
    if (!k && !single) throw new BrowserError(`Tecla desconhecida: ${key}. Use ${BROWSER_KEYS.join(', ')} ou um caractere.`);
    const p = await this.page(id);
    const cdp = await this.cdp();
    const text = k ? k.text : key;
    const base = {
      key: key === 'Space' ? ' ' : key,
      code: k?.code ?? '',
      windowsVirtualKeyCode: k?.keyCode ?? key.toUpperCase().charCodeAt(0),
    };
    await cdp.send(
      'Input.dispatchKeyEvent',
      { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) },
      p.sessionId,
    );
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, p.sessionId);
    await this.settle(p);
  }

  async scroll(id: string, dy: number): Promise<void> {
    const p = await this.page(id);
    const cdp = await this.cdp();
    await cdp.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x: BROWSER_VIEWPORT.width / 2,
        y: BROWSER_VIEWPORT.height / 2,
        deltaX: 0,
        deltaY: dy,
      },
      p.sessionId,
    );
    await sleep(250);
  }

  /** Imagem da tela (JPEG em base64). `full` tira a página inteira. */
  async screenshot(id: string, full = false): Promise<string> {
    const p = await this.page(id);
    const cdp = await this.cdp();
    const r = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 70, ...(full ? { captureBeyondViewport: true } : {}) },
      p.sessionId,
    );
    return r.data;
  }

  consoleLog(id: string, clear = false): string[] {
    const p = this.pages.get(id);
    const out = p ? [...p.console] : [];
    if (p && clear) p.console = [];
    return out;
  }

  /** Roda JavaScript na página e devolve o resultado (JSON). */
  async evaluate(id: string, expression: string, wrapErrors = true): Promise<unknown> {
    const p = await this.page(id);
    const cdp = await this.cdp();
    const r = await cdp.send<{
      result: { value?: unknown; description?: string; type: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      p.sessionId,
    );
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new BrowserError(wrapErrors ? `Erro na página: ${msg}` : msg);
    }
    return r.result.value === undefined ? (r.result.description ?? r.result.type) : r.result.value;
  }

  /** Espera um texto aparecer na página (ou só o tempo pedido). */
  async waitFor(id: string, o: { text?: string; ms?: number }): Promise<string> {
    await this.page(id);
    const limit = Math.min(o.ms ?? (o.text ? 15_000 : 1_000), 60_000);
    if (!o.text) {
      await sleep(limit);
      return `Esperei ${limit} ms.`;
    }
    const until = Date.now() + limit;
    const probe = `document.body ? document.body.innerText.includes(${JSON.stringify(o.text)}) : false`;
    while (Date.now() < until) {
      if ((await this.evaluate(id, probe)) === true) return `"${o.text}" apareceu na página.`;
      await sleep(300);
    }
    throw new BrowserError(`"${o.text}" não apareceu em ${limit} ms.`);
  }

  // ---------- Chrome ----------

  private cdp() {
    return this.ensureChrome().then((c) => c.cdp);
  }

  private ensureChrome(): Promise<Chrome> {
    if (this.chrome) return this.chrome;
    const bin = this.d.bin === undefined ? findBrowser() : this.d.bin;
    if (!bin)
      return Promise.reject(
        new BrowserError(
          'Nenhum Chrome, Edge ou Chromium encontrado nesta máquina. Instale um ou aponte o executável em AGENT_CANVAS_BROWSER_BIN.',
        ),
      );
    const started = Chrome.launch(bin, join(this.d.home, 'browser-profile')).then((chrome) => {
      this.offCdp = chrome.cdp.on((method, params, sessionId) => this.onEvent(method, params, sessionId));
      chrome.cdp.onClose = () => {
        // o Chrome caiu: as abas reabrem quando forem usadas de novo
        this.chrome = null;
        this.pages.clear();
        for (const id of this.state.keys()) this.patch(id, { status: 'off' });
      };
      return chrome;
    });
    this.chrome = started;
    started.catch(() => {
      if (this.chrome === started) this.chrome = null;
    });
    return started;
  }

  /** Aba do navegador, aberta (no último endereço) se ainda não estiver. */
  private page(id: string): Promise<Page> {
    const open = this.pages.get(id);
    if (open) return Promise.resolve(open);
    const pending = this.opening.get(id);
    if (pending) return pending;
    const b = this.get(id);
    if (!b) return Promise.reject(new BrowserError('Navegador não encontrado.'));
    const job = this.openPage(id, b.url).finally(() => this.opening.delete(id));
    this.opening.set(id, job);
    return job;
  }

  private async openPage(id: string, url: string): Promise<Page> {
    this.patch(id, { status: 'loading', error: null });
    try {
      const cdp = await this.cdp();
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      const p: Page = {
        targetId,
        sessionId,
        lastFrame: null,
        frameTimer: null,
        lastFrameAt: 0,
        console: [],
        loadWaiters: [],
        refreshTimer: null,
      };
      this.pages.set(id, p);
      await Promise.all([
        cdp.send('Page.enable', {}, sessionId),
        cdp.send('Runtime.enable', {}, sessionId),
        cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { ...BROWSER_VIEWPORT, deviceScaleFactor: 1, mobile: false },
          sessionId,
        ),
      ]);
      await cdp.send(
        'Page.startScreencast',
        { format: 'jpeg', quality: 65, maxWidth: BROWSER_VIEWPORT.width, maxHeight: BROWSER_VIEWPORT.height },
        sessionId,
      );
      if (url && url !== 'about:blank') {
        const loaded = this.waitLoad(p);
        const r = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sessionId);
        if (r.errorText) this.patch(id, { error: `Não abriu ${url}: ${r.errorText}` });
        else await loaded;
      }
      await this.refresh(id);
      return p;
    } catch (err) {
      this.pages.delete(id);
      this.patch(id, { status: 'error', error: (err as Error).message });
      throw err;
    }
  }

  private pageBySession(sessionId: string | undefined): [string, Page] | null {
    if (!sessionId) return null;
    for (const entry of this.pages) if (entry[1].sessionId === sessionId) return entry;
    return null;
  }

  private onEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const hit = this.pageBySession(sessionId);
    if (!hit) return;
    const [id, p] = hit;
    switch (method) {
      case 'Page.screencastFrame': {
        void this.cdp()
          .then((c) => c.send('Page.screencastFrameAck', { sessionId: params.sessionId }, p.sessionId))
          .catch(() => {});
        const meta = params.metadata as { deviceWidth: number; deviceHeight: number };
        p.lastFrame = { data: String(params.data), width: meta.deviceWidth, height: meta.deviceHeight };
        this.sendFrame(id, p);
        return;
      }
      case 'Page.loadEventFired':
        p.loadWaiters.splice(0).forEach((f) => f());
        this.scheduleRefresh(id, p);
        return;
      case 'Page.frameNavigated':
        if (!(params.frame as { parentId?: string }).parentId) this.scheduleRefresh(id, p);
        return;
      case 'Page.navigatedWithinDocument':
        this.scheduleRefresh(id, p);
        return;
      case 'Page.javascriptDialogOpening': {
        // alert/confirm/prompt travariam a página: aceita e anota no console
        const d = params as { type: string; message: string; defaultPrompt?: string };
        this.pushConsole(p, `[dialog ${d.type}] ${d.message} (aceito automaticamente)`);
        void this.cdp()
          .then((c) =>
            c.send('Page.handleJavaScriptDialog', { accept: true, promptText: d.defaultPrompt ?? '' }, p.sessionId),
          )
          .catch(() => {});
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const c = params as { type: string; args: { value?: unknown; description?: string; type: string }[] };
        const text = c.args
          .map((a) =>
            a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type),
          )
          .join(' ');
        this.pushConsole(p, `[${c.type}] ${text}`);
        return;
      }
      case 'Runtime.exceptionThrown': {
        const e = params.exceptionDetails as { text: string; exception?: { description?: string } };
        this.pushConsole(p, `[exception] ${e.exception?.description ?? e.text}`);
        return;
      }
    }
  }

  private pushConsole(p: Page, line: string) {
    p.console.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    if (p.console.length > CONSOLE_MAX) p.console.splice(0, p.console.length - CONSOLE_MAX);
  }

  /** Manda o quadro mais recente, no máximo um a cada FRAME_EVERY_MS. */
  private sendFrame(id: string, p: Page) {
    if (p.frameTimer) return;
    const wait = Math.max(0, p.lastFrameAt + FRAME_EVERY_MS - Date.now());
    p.frameTimer = setTimeout(() => {
      p.frameTimer = null;
      p.lastFrameAt = Date.now();
      if (p.lastFrame && this.pages.get(id) === p)
        this.d.hub.broadcast([{ type: 'browser.frame', browserId: id, ...p.lastFrame }]);
    }, wait);
  }

  private waitLoad(p: Page, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // páginas que não terminam de carregar (streaming, long polling) não travam o agente
      const timer = setTimeout(() => {
        p.loadWaiters = p.loadWaiters.filter((f) => f !== done);
        resolve();
      }, timeoutMs);
      p.loadWaiters.push(done);
    });
  }

  /** Depois de um clique ou tecla: espera a navegação que ele causar, se houver. */
  private async settle(p: Page, ms = 400): Promise<void> {
    let navigated = false;
    const mark = () => (navigated = true);
    p.loadWaiters.push(mark);
    await sleep(ms);
    p.loadWaiters = p.loadWaiters.filter((f) => f !== mark);
    if (navigated) await sleep(200);
  }

  private scheduleRefresh(id: string, p: Page) {
    if (p.refreshTimer) clearTimeout(p.refreshTimer);
    p.refreshTimer = setTimeout(() => {
      p.refreshTimer = null;
      void this.refresh(id).catch(() => {});
    }, 150);
  }

  /** Endereço, título e histórico atuais da aba. */
  private async refresh(id: string): Promise<void> {
    const p = this.pages.get(id);
    if (!p) return;
    const cdp = await this.cdp();
    const h = await cdp.send<{ currentIndex: number; entries: { url: string; title: string }[] }>(
      'Page.getNavigationHistory',
      {},
      p.sessionId,
    );
    const cur = h.entries[h.currentIndex];
    this.patch(id, {
      status: 'ready',
      url: cur?.url ?? 'about:blank',
      title: cur?.title ?? '',
      canBack: h.currentIndex > 0,
      canForward: h.currentIndex < h.entries.length - 1,
    });
  }

  private patch(id: string, patch: Partial<Browser>, broadcast = true): void {
    const prev = this.get(id);
    if (!prev) return;
    const next = { ...prev, ...patch };
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.state.set(id, next);
    if (patch.url !== undefined || patch.title !== undefined)
      this.d.db.update(browserT).set({ url: next.url, title: next.title }).where(eq(browserT.id, id)).run();
    if (broadcast) this.d.hub.broadcast([{ type: 'browser.upsert', browser: next } satisfies ServerMessage]);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
