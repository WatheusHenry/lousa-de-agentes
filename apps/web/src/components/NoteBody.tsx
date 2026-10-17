import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown.tsx';

interface Props {
  value: string;
  onChange(v: string): void;
  /** Sai do campo: grava a nota. */
  onCommit(): void;
  placeholder: string;
  /** Classes do campo de texto (o mesmo espaço é usado pela prévia). */
  className?: string;
  compact?: boolean;
  /** Abre já editando (só quando a nota está vazia, para não esconder a prévia). */
  autoFocus?: boolean;
}

/**
 * Texto de uma nota: mostra o Markdown formatado e vira campo de texto ao clicar (ou Enter).
 * Sair do campo grava e volta para a prévia. Nota vazia começa editando.
 */
export function NoteBody({ value, onChange, onCommit, placeholder, className, compact, autoFocus }: Props) {
  const [editing, setEditing] = useState(() => !value.trim());
  const area = useRef<HTMLTextAreaElement>(null);
  const focusNext = useRef(false);

  useEffect(() => {
    if (!editing || !focusNext.current) return;
    focusNext.current = false;
    const el = area.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  useEffect(() => {
    if (!autoFocus || !editing) return;
    const t = setTimeout(() => area.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
    // só na montagem: depois, quem decide o foco é o usuário
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const edit = () => {
    focusNext.current = true;
    setEditing(true);
  };

  if (editing)
    return (
      <textarea
        ref={area}
        className={className}
        value={value}
        placeholder={placeholder}
        aria-label="Texto da nota"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          onCommit();
          if (value.trim()) setEditing(false);
        }}
      />
    );

  return (
    <div
      className={`${className ?? ''} note-md`}
      role="button"
      tabIndex={0}
      title="Clique para editar"
      aria-label="Texto da nota (clique para editar)"
      onClick={(e) => {
        // links abrem normalmente, sem entrar na edição
        if (!(e.target as HTMLElement).closest('a')) edit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          edit();
        }
      }}
    >
      <Markdown compact={compact}>{value}</Markdown>
    </div>
  );
}
