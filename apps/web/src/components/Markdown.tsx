import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  children: string;
  /** URL do projeto no GitLab: links relativos (ex.: /uploads/…) passam a apontar para ela. */
  baseUrl?: string;
  className?: string;
  /** Versão compacta (cartões, janela do agente): títulos menores, sem margens grandes. */
  compact?: boolean;
}

/**
 * Markdown do GitLab e das respostas dos agentes. HTML cru nunca é renderizado (o conteúdo
 * vem de fora); links abrem em outra aba; imagens viram links, para não carregar nada de
 * terceiros sem o usuário pedir.
 */
function MarkdownView({ children, baseUrl, className, compact }: Props) {
  const resolve = (url: string) => {
    const safe = defaultUrlTransform(url);
    if (!baseUrl || !safe || /^[a-z][a-z0-9+.-]*:|^#/i.test(safe)) return safe;
    try {
      // GitLab: "/uploads/x" é relativo ao projeto; "/grupo/p/-/issues/1" é relativo à instância
      const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
      return safe.startsWith('/uploads/') ? new URL(safe.slice(1), base).href : new URL(safe, base).href;
    } catch {
      return safe;
    }
  };
  const components: Components = {
    a: ({ href, children: c }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {c}
      </a>
    ),
    img: ({ src, alt }) => (
      <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer">
        🖼 {alt || 'imagem'}
      </a>
    ),
    // checklists do GitLab: só leitura
    input: ({ checked, type }) =>
      type === 'checkbox' ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null,
  };
  return (
    <div className={`md${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={resolve}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownView);
