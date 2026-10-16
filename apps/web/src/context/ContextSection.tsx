import { useRef, useState } from 'react';
import { HEAVY_ITEM_TOKENS, type Agent } from '@agent-canvas/shared';
import { fmtK } from '../agents/agent-ui.ts';
import { IconPlus } from '../icons.tsx';
import { useStore } from '../state/store.ts';
import { ContextPicker } from './ContextPicker.tsx';
import { kindIcon, meterClass, useAgentContext } from './ctx-ui.tsx';

/**
 * Contexto do agente no painel (seção 7 do plano e protótipo): medidor com a estimativa e o uso
 * real do último turno, chips com tokens, Resumir nos itens pesados e sugestões.
 */
export function ContextSection({ agent: a }: { agent: Agent }) {
  const ctx = useAgentContext(a);
  const st = useStore.getState();
  const [picking, setPicking] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);

  if (!ctx)
    return (
      <div className="grp">
        <h4>Contexto</h4>
        <p className="ctx-empty">Calculando…</p>
      </div>
    );

  const over = ctx.totalTokens > ctx.budget;
  const used = ctx.items.reduce((s, i) => s + i.tokens, 0);
  return (
    <div className="grp">
      <div className="sec-h">
        <h4>Contexto</h4>
        <button
          ref={addBtn}
          type="button"
          className="btn sm"
          aria-haspopup="dialog"
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
        >
          <IconPlus size={12} /> Adicionar
        </button>
      </div>
      <div className={`meter${over ? ' over' : ''}`}>
        <div className="meter-top">
          <span>
            <b>{fmtK(ctx.totalTokens)}</b> tokens{a.contextTokens ? ' estimados' : ''}
          </span>
          <span>recomendado até {fmtK(ctx.budget)}</span>
        </div>
        <div
          className="stack"
          role="img"
          aria-label={`${fmtK(ctx.totalTokens)} de ${fmtK(ctx.budget)} tokens recomendados`}
        >
          {ctx.items.map((i) => (
            <i
              key={i.id}
              className={meterClass(i.kind, i.summarized)}
              style={{ flexGrow: i.tokens }}
              title={`${i.label} · ${fmtK(i.tokens)}`}
            />
          ))}
          {/* cabeçalho do context.md (avisos, repositório, MR) */}
          <i
            className="k-other"
            style={{ flexGrow: Math.max(0, ctx.totalTokens - used) }}
            title="cabeçalho"
          />
          <i className="k-free" style={{ flexGrow: Math.max(0, ctx.budget - ctx.totalTokens) }} />
        </div>
        {a.contextTokens > 0 && (
          <span className="lab" title="Entrada e cache do último turno, como o claude informou">
            Uso real no último turno: <b>{fmtK(a.contextTokens)}</b> tokens (inclui o system prompt e a
            conversa)
          </span>
        )}
      </div>
      {over && (
        <div className="callout">
          <span>
            Contexto acima do recomendado. Resuma os itens maiores para o agente focar no que importa.
          </span>
        </div>
      )}
      {ctx.items.length ? (
        <div className="tags">
          {ctx.items.map((i) => {
            const { icon } = kindIcon(i.kind);
            const busy = ctx.summarizing.includes(i.id);
            return (
              <span
                key={i.id}
                className={`chipx${i.summarized ? ' sum' : ''}${i.error ? ' err' : ''}`}
                title={i.error ?? (i.source === 'link' ? 'Vem dos vínculos do canvas' : 'Adicionado à mão')}
              >
                {icon}
                {i.label}
                {i.summarized && <em>resumo</em>}
                <span className="tk">{i.error ? '!' : fmtK(i.tokens)}</span>
                {busy ? (
                  <span className="mini" aria-live="polite">
                    Resumindo…
                  </span>
                ) : i.summarized ? (
                  <button
                    className="mini"
                    title={`Voltar ao conteúdo completo (${fmtK(i.fullTokens)} tokens)`}
                    onClick={() => st.contextUnsummarize(a.id, i.id)}
                  >
                    Completo
                  </button>
                ) : (
                  i.tokens >= HEAVY_ITEM_TOKENS && (
                    <button
                      className="mini"
                      title="Resume com um modelo pequeno, preservando arquivos, erros e decisões"
                      onClick={() => st.contextSummarize(a.id, i.id)}
                    >
                      Resumir
                    </button>
                  )
                )}
                {i.removable && (
                  <button
                    className="x"
                    aria-label={`Remover ${i.label} do contexto`}
                    onClick={() => st.contextRemove(a.id, i.id)}
                  >
                    ✕
                  </button>
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="ctx-empty">Nenhum contexto ainda.</p>
      )}
      {ctx.suggestions.length > 0 && (
        <div className="sugg">
          <span className="lab">Sugeridos para esta tarefa</span>
          {ctx.suggestions.map((s) => (
            <button
              key={`${s.kind}:${s.ref}`}
              type="button"
              className="chip-s"
              title={s.why}
              onClick={() => st.contextAdd(a.id, s.kind, s.ref)}
            >
              <IconPlus size={11} />
              {s.label}
            </button>
          ))}
        </div>
      )}
      {picking && <ContextPicker agent={a} anchor={addBtn.current} onClose={() => setPicking(false)} />}
    </div>
  );
}
