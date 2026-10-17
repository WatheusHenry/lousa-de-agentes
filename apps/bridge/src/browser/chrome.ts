import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class BrowserError extends Error {}

/** Onde costumam estar o Chrome, o Edge e o Chromium em cada sistema. */
function candidates(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (r): r is string => !!r,
    );
    return roots.flatMap((r) => [
      join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(r, 'Chromium', 'Application', 'chrome.exe'),
      join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ]);
  }
  if (process.platform === 'darwin')
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'brave-browser',
  ].flatMap((b) => ['/usr/bin/', '/usr/local/bin/', '/snap/bin/'].map((d) => d + b));
}

/** Executável do navegador: AGENT_CANVAS_BROWSER_BIN ou o primeiro Chrome/Edge/Chromium instalado. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env.AGENT_CANVAS_BROWSER_BIN;
  if (own) return existsSync(own) ? own : null;
  return candidates(env).find((p) => existsSync(p)) ?? null;
}

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

/** Conexão com o Chrome DevTools Protocol (uma só, com as abas em sessões "flatten"). */
export class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { ok: (v: never) => void; fail: (e: Error) => void }>();
  private readonly listeners = new Set<Listener>();
  onClose: (() => void) | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      let msg: {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.fail(new BrowserError(msg.error.message));
        else p?.ok(msg.result as never);
      } else if (msg.method) for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.fail(new BrowserError('O navegador fechou.'));
      this.pending.clear();
      this.onClose?.();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new BrowserError('Não consegui falar com o navegador.')), {
        once: true,
      });
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new BrowserError('O navegador fechou.'));
    const id = ++this.seq;
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new BrowserError(`O navegador não respondeu (${method}).`));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close(): void {
    this.ws.close();
  }
}

/** Chrome headless com perfil próprio (não usa os logins do seu navegador). */
export class Chrome {
  private constructor(
    readonly cdp: Cdp,
    private readonly proc: ChildProcess,
  ) {}

  static async launch(bin: string, profileDir: string, timeoutMs = 20_000): Promise<Chrome> {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const proc = spawn(
      bin,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new BrowserError('O navegador demorou demais para abrir.'));
      }, timeoutMs);
      proc.stderr!.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new BrowserError(`Não consegui abrir o navegador: ${err.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(
          new BrowserError(
            `O navegador fechou ao abrir (código ${code}).${buf ? ` ${buf.slice(-300)}` : ''}`,
          ),
        );
      });
    });
    proc.stderr!.resume();
    try {
      return new Chrome(await Cdp.connect(url), proc);
    } catch (err) {
      proc.kill();
      throw err;
    }
  }

  /** Fecha o Chrome e espera o processo sair (no Windows, o perfil fica preso até lá). */
  close(): Promise<void> {
    this.cdp.close();
    if (this.proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.proc.kill();
    });
  }
}
