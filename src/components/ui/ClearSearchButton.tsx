import { X } from 'lucide-react';

export function ClearSearchButton({value,onClear,disabled=false,hidden=false}: {
  value:string; onClear:()=>void; disabled?:boolean; hidden?:boolean;
}) {
  if(!value||hidden)return null;
  return <button type="button" aria-label="Borrar búsqueda" disabled={disabled}
    onClick={event=>{
      if(disabled||event.currentTarget.matches(':disabled'))return;
      onClear();
      event.currentTarget.parentElement?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }}
    className="absolute right-0 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full text-ink-600 hover:bg-cream-100 hover:text-ink-950 disabled:cursor-not-allowed disabled:opacity-40">
    <X className="size-4" aria-hidden="true" />
  </button>;
}
