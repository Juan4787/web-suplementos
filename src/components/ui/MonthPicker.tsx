import { useId } from 'react';
import { Select } from './Select';
import { cn } from '@/lib/cn';

const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

/** Month-only selection; no day or timezone conversion enters the saved value. */
export function MonthPicker({value,onChange,id,disabled=false,minYear=2000,maxYear=2100,className}: {
  value:string;
  onChange:(value:string)=>void;
  id?:string;
  disabled?:boolean;
  minYear?:number;
  maxYear?:number;
  className?:string;
}) {
  const generatedId=useId();
  const controlId=id??generatedId;
  const [year,month]=value.split('-');
  const commit=(next:string)=>{
    if(!disabled&&/^\d{4}-(0[1-9]|1[0-2])$/.test(next)&&Number(next.slice(0,4))>=minYear&&Number(next.slice(0,4))<=maxYear)onChange(next);
  };
  return <div role="group" aria-label="Mes a revisar" className={cn('flex min-w-0 flex-1 flex-wrap gap-1',className)}>
    <input type="hidden" id={controlId} value={value} />
    <Select id={controlId+'-month'} aria-label="Mes a revisar: mes" disabled={disabled} searchable={false} size="sm"
      className="min-w-33 flex-[1_1_8.25rem] [&>button]:gap-1 [&>button]:px-2 [&>button>span]:whitespace-nowrap"
      value={month} onValueChange={next=>commit(year+'-'+next)}
      options={monthNames.map((label,index)=>({value:String(index+1).padStart(2,'0'),label}))} />
    <Select id={controlId+'-year'} aria-label="Mes a revisar: año" disabled={disabled} size="sm"
      className="min-w-17 flex-[1_1_4.25rem] [&>button]:gap-0.5 [&>button]:px-1 [&>button>span]:whitespace-nowrap"
      value={year} onValueChange={next=>commit(next+'-'+month)}
      options={Array.from({length:Math.max(0,maxYear-minYear+1)},(_,index)=>({value:String(minYear+index),label:String(minYear+index)}))} />
  </div>;
}
