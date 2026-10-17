import type { WebSocket } from 'ws';
import type { ServerMessage } from '@agent-canvas/shared';

/** Distribui mensagens do bridge para os navegadores conectados. */
export class Hub {
  readonly clients = new Set<WebSocket>();
  /** Só passa o que é do workspace aberto (o servidor liga; os agentes dos outros seguem trabalhando). */
  visible: (msg: ServerMessage) => boolean = () => true;

  broadcast(msgs: ServerMessage | ServerMessage[], except?: WebSocket): void {
    for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
      if (!this.visible(msg)) continue;
      const data = JSON.stringify(msg);
      for (const ws of this.clients) if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}
