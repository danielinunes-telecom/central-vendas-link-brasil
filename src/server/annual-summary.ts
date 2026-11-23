import 'server-only'
import { z } from 'zod'
import type { AnnualSummaryData, AnnualSummaryRow, BaseCode, Seller, Viewer } from '@/lib/model'
import { asUser } from './db'

const input=z.object({year:z.coerce.number().int().min(2026).max(2100),seller:z.string().max(80).catch(''),base:z.enum(['','old','new','legacy']).catch('')})
const expenseKind=(value:string|null)=>{
  const s=(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase()
  if(s.includes('COMBUST'))return 'fuel'
  if(s.includes('HOSPED')||s.includes('ALIMENT')||s.includes('ALMO')||s.includes('JANT')||s.includes('REFEIC'))return 'travel'
  return 'extras'
}
export async function annualSummary(current:Viewer,params:URLSearchParams):Promise<AnnualSummaryData>{
  const p=input.parse(Object.fromEntries(params)); const seller=current.seller_key||p.seller
  return asUser(current.email,async db=>{
    const sellers=(await db.query<Seller>('select * from comercial.sellers where active order by name')).rows
    const bases:BaseCode[]=p.base?[p.base as BaseCode]:['old','new','legacy']
    const metrics=(await db.query<{month:string;kind:string;amount:number|null;count:number;excess:number;category:string|null}>(
      `select to_char(month,'YYYY-MM') month,kind,sum(amount)::float8 amount,count(*)::int count,
       coalesce(sum((details->>'excess')::numeric) filter(where details?'excess'),0)::float8 excess,
       details->>'category' category from comercial.metric_rows
       where extract(year from month)=$1 and base_code=any($2::text[]) and ($3='' or seller_key=$3)
       group by month,kind,details->>'category'`,[p.year,bases,seller])).rows
    const states=(await db.query<{month:string;observed_on:string;data:Record<string,unknown>}>(
      `select to_char(month,'YYYY-MM') month,observed_on::text,data from comercial.metric_state
       where extract(year from month)=$1 and base_code=any($2::text[])`,[p.year,bases])).rows
    const notes=(await db.query<{month:string;justification:string}>(
      `select to_char(month,'YYYY-MM') month,justification from comercial.monthly_justifications
       where extract(year from month)=$1 and seller_key=$2`,[p.year,seller])).rows
    const stateBy=new Map<string,{observed:string;data:Record<string,unknown>}>()
    for(const s of states){const old=stateBy.get(s.month);stateBy.set(s.month,{observed:old&&old.observed>s.observed_on?old.observed:s.observed_on,data:{...(old?.data||{}),...s.data}})}
    const noteBy=new Map(notes.map(n=>[n.month,n.justification]))
    const rows:AnnualSummaryRow[]=Array.from({length:12},(_,i)=>{
      const month=`${p.year}-${String(i+1).padStart(2,'0')}`, list=metrics.filter(m=>m.month===month), state=stateBy.get(month)
      const sum=(kind:string)=>{const x=list.filter(m=>m.kind===kind);return x.length?x.reduce((a,b)=>a+(b.amount??0),0):null}
      const count=(kind:string)=>{const x=list.filter(m=>m.kind===kind);return x.length?x.reduce((a,b)=>a+b.count,0):null}
      const expenses={fuel:null as number|null,travel:null as number|null,extras:null as number|null}
      for(const e of list.filter(m=>m.kind==='expense')){const k=expenseKind(e.category);expenses[k]=(expenses[k]??0)+(e.amount??0)}
      const hasExpenses=Boolean(state?.data.expenses); for(const k of Object.keys(expenses) as (keyof typeof expenses)[])if(hasExpenses&&expenses[k]===null)expenses[k]=0
      return {month,label:new Intl.DateTimeFormat('pt-BR',{month:'long',timeZone:'UTC'}).format(new Date(`${month}-01T00:00:00Z`)),positionDate:state?.observed||null,
        portfolio:sum('mrr'),fuel:expenses.fuel,travel:expenses.travel,extras:expenses.extras,
        excess:hasExpenses?list.filter(m=>m.kind==='expense').reduce((a,b)=>a+b.excess,0):null,target:sum('target'),activations:sum('goal_sale'),
        upgrades:sum('upgrade'),downgrades:sum('downgrade'),cancellations:sum('cancellation_effective')??sum('cancellation'),reversals:sum('cancellation_reversed')??sum('reversal'),
        leads:state?.data.leads?count('lead_new'):null,visits:state?.data.visits?count('visit_task'):null,converted:state?.data.leads?count('lead_won'):null,
        justification:noteBy.get(month)||'',receipts:state?.data.receipts?sum('receipt'):null,debt:state?.data.debts?sum('debt'):null,
        contractIssues:state?.data.closing?(count('expired')??0)+(count('renewal_pending')??0):null}
    })
    return {year:p.year,rows,sellers,seller,canEdit:Boolean(seller)}
  })
}
export async function saveJustification(current:Viewer,body:unknown){
  const v=z.object({month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),seller:z.string().max(80),justification:z.string().max(4000)}).parse(body)
  const seller=current.seller_key||v.seller;if(!seller)throw new Error('Selecione um vendedor para registrar a justificativa.')
  return asUser(current.email,async db=>{await db.query(`insert into comercial.monthly_justifications(seller_key,month,justification,updated_by)
    values($1,$2::date,$3,$4) on conflict(seller_key,month) do update set justification=excluded.justification,updated_by=excluded.updated_by,updated_at=now()`,[seller,v.month+'-01',v.justification,current.email]);return {ok:true}})
}
