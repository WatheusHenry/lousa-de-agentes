import type { WebSocket } from 'ws';
import type { ServerMessage } from '@agent-canvas/shared';

/** Distribui mensagens do bridge para os navegadores conectados. */
export class Hub {
  readonly clients = new Set<WebSocket>();

  broadcast(msgs: ServerMessage | ServerMessage[], except?: WebSocket): void {
    for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
      const data = JSON.stringify(msg);
      for (const ws of this.clients) if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}
