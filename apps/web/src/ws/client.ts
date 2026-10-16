import { SESSION_QUERY, ServerMessage, type ClientMessage } from '@agent-canvas/shared';

type Status = 'connecting' | 'open' | 'closed';

/**
 * WebSocket tipado com o bridge. Reconecta sozinho; mensagens enviadas sem conexão ficam
 * numa fila e saem quando a conexão volta.
 */
export class BridgeSocket {
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private retry = 0;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onStatus: (s: Status) => void,
  ) {}

  connect(): void {
    this.stopped = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?${SESSION_QUERY}=${this.token}`);
    this.ws = ws;
    this.onStatus('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      const pending = this.queue;
      this.queue = [];
      pending.forEach((m) => this.send(m));
    };
    ws.onmessage = (e) => {
      try {
        const parsed = ServerMessage.safeParse(JSON.parse(String(e.data)));
        if (parsed.success) this.onMessage(parsed.data);
        else console.warn('mensagem do bridge fora do contrato', parsed.error);
      } catch {
        console.warn('mensagem do bridge ilegível');
      }
    };
    ws.onclose = () => {
      this.onStatus('closed');
      if (this.stopped) return;
      const wait = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else this.queue.push(m);
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
