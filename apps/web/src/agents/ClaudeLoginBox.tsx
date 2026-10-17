import { useLayoutEffect, useRef, useState } from 'react';
import type { Agent } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { useStore } from '../state/store.ts';

/**
 * No terminal do agente, quando o login do Claude Code expirou: refaz o login pelo bridge
 * (`claude auth login`, que abre o navegador) e, depois, reenvia a mensagem que falhou.
 */
export function ClaudeLoginBox({
  agent,
  lastMessage,
  follow = false,
}: {
  agent: Agent;
  lastMessage: string | null;
  /** No terminal do agente: rola até a caixa quando ela cresce. */
  follow?: boolean;
}) {
  const login = useStore((s) => s.claudeLogin);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // a caixa cresce (link, campo do código): o terminal rola para ela não ficar cortada
  useLayoutEffect(() => {
    if (!follow) return;
    let el = box.current?.parentElement;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow, login.state, login.url]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao falar com o bridge.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cl-box nodrag" ref={box} onPointerDown={(e) => e.stopPropagation()}>
      <b>
        {login.state === 'done'
          ? 'Login do Claude Code renovado.'
          : 'O login do Claude Code nesta máquina expirou.'}
      </b>
      {login.state === 'done' ? (
        <>
          <span className="cl-ok">✓ O Claude Code já pode rodar os agentes de novo.</span>
          <div className="cl-row">
            {lastMessage && !resent ? (
              <button
                className="btn sm primary"
                onClick={() => {
                  useStore.getState().messageAgent(agent.id, lastMessage);
                  setResent(true);
                }}
              >
                Reenviar a última mensagem
              </button>
            ) : (
              <span className="lab">{resent ? 'Mensagem reenviada.' : 'Mande a mensagem de novo.'}</span>
            )}
          </div>
        </>
      ) : login.state === 'waiting' ? (
        <>
          <span className="lab">{login.message ?? 'Termine o login na página que abriu no navegador.'}</span>
          <div className="cl-row">
            {login.url && (
              <a className="btn sm" href={login.url} target="_blank" rel="noreferrer noopener">
                Abrir a página de login
              </a>
            )}
            <button className="btn sm plain" disabled={busy} onClick={() => run(api.cancelClaudeLogin)}>
              Cancelar
            </button>
          </div>
          <form
            className="cl-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) void run(() => api.claudeLoginCode(code)).then(() => setCode(''));
            }}
          >
            <input
              className="field"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Se a página mostrar um código, cole aqui"
              aria-label="Código de login"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn sm" disabled={busy || !code.trim()}>
              Enviar
            </button>
          </form>
        </>
      ) : (
        <>
          {login.state === 'failed' && login.message && <span className="cl-err">{login.message}</span>}
          <div className="cl-row">
            <button className="btn sm primary" disabled={busy} onClick={() => run(api.claudeLogin)}>
              {login.state === 'failed' ? 'Tentar de novo' : 'Entrar de novo no Claude'}
            </button>
            <span className="lab">ou rode `claude` e /login num terminal</span>
          </div>
        </>
      )}
      {error && <span className="cl-err">{error}</span>}
    </div>
  );
}
