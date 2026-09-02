import { useMutation } from '@tanstack/react-query';
import { ArrowUp, Bot, Database, LockKeyhole, Sparkles, User } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { appEnv } from '@/app/env';
import { PageHeader } from '@/components/layout/AdminShell';
import { RoleGate } from '@/components/layout/RoleGate';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import { Textarea } from '@/components/ui/Field';
import { getBusinessApi } from '@/services/business-api';
import type { AIAnswerEvidence } from '@/services/business-api';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  consulted?: boolean;
  model?: string;
  fallback?: boolean;
  evidence?: AIAnswerEvidence[];
};

const suggestions = [
  '¿Qué productos debería priorizar para comprar esta semana?',
  'Compará mis ventas del mes con el período anterior.',
  '¿Qué productos tienen poca rotación y capital inmovilizado?',
  '¿Cómo se relacionan margen y volumen en los productos más vendidos?'
];

const renderAssistantInline = (line: string, keyPrefix: string | number): ReactNode => {
  const parts: ReactNode[] = [];
  const pattern = /\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let partIndex = 0;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) {
      parts.push(line.slice(cursor, match.index));
    }
    if (match[1] !== undefined) {
      parts.push(
        <strong key={`${keyPrefix}-bi-${partIndex}`} className="font-black italic text-ink-950">
          {match[1]}
        </strong>
      );
    } else if (match[2] !== undefined) {
      parts.push(
        <strong key={`${keyPrefix}-b-${partIndex}`} className="font-bold text-ink-950">
          {match[2]}
        </strong>
      );
    } else if (match[3] !== undefined) {
      parts.push(
        <em key={`${keyPrefix}-i-${partIndex}`} className="italic text-ink-800">
          {match[3]}
        </em>
      );
    } else if (match[4] !== undefined) {
      parts.push(
        <code
          key={`${keyPrefix}-c-${partIndex}`}
          className="rounded bg-ink-950/5 px-1.5 py-0.5 font-mono text-[0.85em] text-brand-700"
        >
          {match[4]}
        </code>
      );
    }
    cursor = match.index + match[0].length;
    partIndex += 1;
  }

  if (cursor < line.length) {
    parts.push(line.slice(cursor));
  }
  return parts.length > 0 ? parts : line;
};

const isTableSeparator = (line: string): boolean =>
  /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/u.test(line);

const isTableRow = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith('|') || (trimmed.includes('|') && trimmed.endsWith('|'));
};

const parseTableRow = (line: string): string[] => {
  const trimmed = line.trim();
  const raw = trimmed.replace(/^\|/u, '').replace(/\|$/u, '');
  return raw.split('|').map((cell) => cell.trim());
};

const parseTableAlignments = (separatorLine: string): ('left' | 'center' | 'right')[] => {
  const cells = parseTableRow(separatorLine);
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
};

const getAlignClass = (align?: 'left' | 'center' | 'right'): string => {
  if (align === 'center') return 'text-center';
  if (align === 'right') return 'text-right';
  return 'text-left';
};

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'table'; headers: string[]; alignments: ('left' | 'center' | 'right')[]; rows: string[][] }
  | { type: 'bullet'; text: string }
  | { type: 'numbered'; number: string; text: string }
  | { type: 'empty' }
  | { type: 'paragraph'; text: string };

const parseBlocks = (content: string): MarkdownBlock[] => {
  const lines = content.split(/\r?\n/u);
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Check for Markdown Table: header line followed by separator line
    if (i + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[i + 1]!)) {
      const headers = parseTableRow(line);
      const alignments = parseTableAlignments(lines[i + 1]!);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!) && !isTableSeparator(lines[i]!)) {
        rows.push(parseTableRow(lines[i]!));
        i++;
      }
      blocks.push({ type: 'table', headers, alignments, rows });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        text: heading[2]!
      });
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/u);
    if (bullet) {
      blocks.push({ type: 'bullet', text: bullet[1]! });
      i++;
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/u);
    if (numbered) {
      blocks.push({ type: 'numbered', number: numbered[1]!, text: numbered[2]! });
      i++;
      continue;
    }

    if (line.trim() === '') {
      blocks.push({ type: 'empty' });
      i++;
      continue;
    }

    blocks.push({ type: 'paragraph', text: line });
    i++;
  }

  return blocks;
};

/**
 * Renders Markdown subset (tables, headings, bold, italic, code, lists)
 * without using dangerouslySetInnerHTML. React automatically escapes all
 * text, preventing XSS while displaying clean, professional tables and cards.
 */
export const renderAssistantContent = (content: string): ReactNode => {
  const blocks = parseBlocks(content);

  return (
    <div className="space-y-2">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          return (
            <h4
              key={index}
              className="mt-3.5 mb-1.5 font-display text-sm font-black tracking-tight text-ink-950"
            >
              {renderAssistantInline(block.text, `h-${index}`)}
            </h4>
          );
        }

        if (block.type === 'table') {
          return (
            <div
              key={index}
              className="my-3 overflow-hidden rounded-2xl border border-ink-950/10 bg-white shadow-sm"
            >
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-ink-950/10 bg-cream-100/80">
                      {block.headers.map((header, hIdx) => {
                        const align = getAlignClass(block.alignments[hIdx]);
                        return (
                          <th
                            key={hIdx}
                            className={`px-3.5 py-2.5 font-black whitespace-nowrap text-ink-900 ${align}`}
                          >
                            {renderAssistantInline(header, `th-${index}-${hIdx}`)}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-950/5">
                    {block.rows.map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        className="transition-colors hover:bg-cream-50/60"
                      >
                        {row.map((cell, cIdx) => {
                          const align = getAlignClass(block.alignments[cIdx]);
                          return (
                            <td
                              key={cIdx}
                              className={`px-3.5 py-2 whitespace-nowrap text-ink-700 ${align}`}
                            >
                              {renderAssistantInline(cell, `td-${index}-${rIdx}-${cIdx}`)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        }

        if (block.type === 'bullet') {
          return (
            <div key={index} className="flex items-start gap-2.5 py-0.5">
              <span
                aria-hidden="true"
                className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500"
              />
              <div className="flex-1 leading-relaxed text-ink-800">
                {renderAssistantInline(block.text, `b-${index}`)}
              </div>
            </div>
          );
        }

        if (block.type === 'numbered') {
          return (
            <div key={index} className="flex items-start gap-2.5 py-0.5">
              <span className="shrink-0 font-bold tabular-nums text-brand-600">
                {block.number}.
              </span>
              <div className="flex-1 leading-relaxed text-ink-800">
                {renderAssistantInline(block.text, `n-${index}`)}
              </div>
            </div>
          );
        }

        if (block.type === 'empty') {
          return <div key={index} aria-hidden="true" className="h-1" />;
        }

        return (
          <p key={index} className="leading-relaxed text-ink-800">
            {renderAssistantInline(block.text, `p-${index}`)}
          </p>
        );
      })}
    </div>
  );
};

export default function AiPage() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Preguntame por datos concretos de tu tienda —stock, ventas, compras, precios o márgenes— y los voy a consultar antes de responder. También podés pedirme ideas generales; no puedo modificar nada.'
    }
  ]);
  const ask = useMutation({
    mutationFn: async (question: string) =>
      (await getBusinessApi()).askBusinessAi(
        question,
        messages
          .filter((message) => message.id !== 'welcome')
          .slice(-6)
          .map(({ role, content }) => ({ role, content }))
      ),
    onSuccess: (result) => {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.answer,
          consulted: result.usedTools.length > 0,
          model: result.model,
          fallback: result.fallback,
          evidence: result.evidence
        }
      ]);
    }
  });
  const submit = (question = input) => {
    const clean = question.trim();
    if (!clean || ask.isPending) return;
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: clean }]);
    setInput('');
    ask.mutate(clean);
  };
  if (!appEnv.aiEnabled) {
    return (
      <RoleGate capability="use_ai">
        <div className="page-enter">
          <PageHeader title="Asistente pendiente de privacidad" description="Los modelos ya aprobaron las pruebas. El asistente permanece apagado hasta confirmar la protección de las consultas." />
          <section className="max-w-3xl rounded-[2rem] bg-white p-7 shadow-card sm:p-9">
            <span className="grid size-12 place-items-center rounded-2xl bg-brand-100 text-brand-700"><Bot className="size-6" /></span>
            <h2 className="mt-5 font-display text-2xl font-black">El núcleo no depende de la IA</h2>
            <p className="mt-3 leading-7 text-ink-600">Pedidos, stock, compras, ventas, analíticas y Excel siguen funcionando de forma independiente. Falta confirmar que el proveedor principal no conserve las consultas antes de enviarle datos comerciales.</p>
            <div className="mt-6 flex items-start gap-3 rounded-2xl bg-cream-100 p-4 text-sm font-semibold text-ink-700"><LockKeyhole className="mt-0.5 size-5 shrink-0 text-brand-600" /><p>Mientras esta pantalla esté bloqueada no se envía ningún dato comercial a los modelos.</p></div>
          </section>
        </div>
      </RoleGate>
    );
  }
  return (
    <RoleGate capability="use_ai">
      <div className="page-enter">
        <PageHeader title="Asistente del negocio" description="La base de datos calcula los números exactos de tu tienda y el asistente te ayuda a interpretarlos y tomar decisiones." />
        <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
          <section className="flex min-h-[42rem] flex-col overflow-hidden rounded-[2rem] bg-white shadow-card">
            <div className="flex items-center justify-between gap-3 border-b border-ink-950/8 px-5 py-4 sm:px-6"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-2xl bg-brand-100 text-brand-700"><Bot className="size-5" /></span><div><h2 className="font-black">Analista Impulso</h2><p className="text-xs font-semibold text-brand-600">Disponible · Modo solo lectura</p></div></div><div className="flex items-center gap-2"><span className="hidden items-center gap-2 rounded-full bg-cream-100 px-3 py-2 text-xs font-black text-ink-600 lg:inline-flex"><Database className="size-3.5" /> Datos de la tienda</span><span className="inline-flex items-center rounded-full border border-ink-950/10 bg-white px-3 py-2 text-xs font-black text-ink-700">Automático</span></div></div>
            <div className="flex-1 space-y-5 overflow-y-auto bg-cream-50 p-4 sm:p-6">
              {messages.map((message) => (
                <article key={message.id} className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {message.role === 'assistant' ? <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-950 text-brand-300"><Bot className="size-4" /></span> : null}
                  <div className={`max-w-[82%] rounded-[1.5rem] px-4 py-3 text-sm leading-6 sm:max-w-[72%] ${message.role === 'user' ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md border border-ink-950/7 bg-white text-ink-800 shadow-sm'}`}>
                    {message.role === 'assistant' ? renderAssistantContent(message.content) : <p className="whitespace-pre-wrap">{message.content}</p>}
                    {message.evidence?.length ? <details className="mt-3 border-t border-ink-950/8 pt-2"><summary className="cursor-pointer text-[11px] font-black text-ink-600">Datos exactos usados</summary><dl className="mt-2 space-y-1.5">{message.evidence.map((fact) => <div key={`${fact.label}-${fact.formatted}`} className="flex items-start justify-between gap-4 text-xs"><dt className="text-ink-600">{fact.label}</dt><dd className="shrink-0 font-black text-ink-950">{fact.formatted}</dd></div>)}</dl></details> : null}
                    {message.consulted ? <p className="mt-3 flex items-center gap-1.5 border-t border-ink-950/8 pt-2 text-[10px] font-black uppercase tracking-wider text-brand-600"><Database className="size-3" /> Respuesta basada en datos reales de tu tienda</p> : null}
                  </div>
                  {message.role === 'user' ? <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700"><User className="size-4" /></span> : null}
                </article>
              ))}
              {ask.isPending ? <div className="flex gap-3"><span className="grid size-9 place-items-center rounded-full bg-ink-950 text-brand-300"><Bot className="size-4" /></span><div className="flex items-center gap-2 rounded-[1.5rem] rounded-bl-md bg-white px-4 py-3 shadow-sm"><span className="size-2 animate-bounce rounded-full bg-brand-600" /><span className="size-2 animate-bounce rounded-full bg-brand-600 [animation-delay:120ms]" /><span className="size-2 animate-bounce rounded-full bg-brand-600 [animation-delay:240ms]" /></div></div> : null}
              {ask.error ? <ErrorState error={ask.error} /> : null}
            </div>
            <div className="border-t border-ink-950/8 bg-white p-4 sm:p-5">
              <div className="relative"><Textarea className="min-h-24 resize-none pr-16" maxLength={1200} placeholder="Ej. ¿Qué debería reponer esta semana y por qué?" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} /><Button className="absolute bottom-3 right-3 size-11 px-0" onClick={() => submit()} disabled={!input.trim() || ask.isPending} aria-label="Enviar pregunta"><ArrowUp className="size-5" /></Button></div>
              <p className="mt-2 text-xs text-ink-600">Enter para enviar · Shift + Enter para una nueva línea</p>
            </div>
          </section>
          <aside className="space-y-5">
            <section className="rounded-[1.75rem] bg-ink-950 p-5 text-white"><LockKeyhole className="size-6 text-brand-300" /><h2 className="mt-4 font-display text-xl font-black">Seguridad total</h2><p className="mt-2 text-sm leading-6 text-white/60">El asistente no puede modificar stock, precios, compras ni pedidos. Solo responde preguntas de consulta.</p></section>
            <section className="rounded-[1.75rem] bg-white p-5 shadow-card"><h3 className="flex items-center gap-2 text-sm font-black text-ink-950"><Sparkles className="size-4 text-brand-600" /> Preguntas sugeridas</h3><div className="mt-4 space-y-2">{suggestions.map((suggestion) => <button key={suggestion} className="w-full rounded-2xl bg-cream-100 p-3 text-left text-xs font-bold leading-5 transition hover:bg-brand-50 hover:text-brand-700" onClick={() => submit(suggestion)}>{suggestion}</button>)}</div></section>
          </aside>
        </div>
      </div>
    </RoleGate>
  );
}
