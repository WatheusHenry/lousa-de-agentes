import { useState, type ElementType } from 'react';

/**
 * Texto que vira campo ao clicar duas vezes (ou no lápis). Enter ou sair do campo salva,
 * Esc cancela. Valor vazio ou igual ao atual não salva.
 */
export function EditableText({
  value,
  onSave,
  as: Tag = 'span',
  className,
  max = 40,
  label,
  stop = false,
}: {
  value: string;
  onSave(next: string): void;
  as?: ElementType;
  className?: string;
  max?: number;
  label: string;
  /** Não deixa o duplo clique subir (a janela do agente abre o foco com ele). */
  stop?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const v = draft?.trim().replace(/\s+/g, ' ');
    setDraft(null);
    if (v && v !== value) onSave(v);
  };
  if (draft !== null)
    return (
      <input
        className={`${className ?? ''} nodrag editable-in`}
        value={draft}
        maxLength={max}
        autoFocus
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    );
  return (
    <Tag
      className={`${className ?? ''} editable`}
      title={`${label} (duplo clique)`}
      onDoubleClick={(e: React.MouseEvent) => {
        if (stop) e.stopPropagation();
        setDraft(value);
      }}
    >
      {value}
    </Tag>
  );
}
