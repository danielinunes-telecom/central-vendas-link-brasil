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
    let bases:BaseCode[]
    if(p.base){bases=[p.base as BaseCode]}
    else{
      const available=(await db.query<{base_code:BaseCode}>(
        `select distinct base_code from comercial.metric_state
         where month >= make_date($1, 1, 1) and month < make_date($1 + 1, 1, 1)`,[p.year])).rows.map(r=>r.base_code)
      // "legacy" is the import made before Old Base/New Base were separated.  It
      // must not be added to both current bases or every overlapping row is doubled.
      bases=available.some(base=>base==='old'||base==='new')
        ? (['old','new'] as BaseCode[]).filter(base=>available.includes(base))
        : available.includes('legacy')?['legacy']:['old','new']
    }
    const metrics=(await db.query<{month:string;kind:string;amount:number|null;count:number;excess:number|null;category:string|null}>(
      `select to_char(month,'YYYY-MM') AS "month",kind,sum(amount)::float8 amount,count(*)::int count,
       sum(case when details->>'excess' ~ '^-?[0-9]+([.][0-9]+)?$' then (details->>'excess')::numeric end)::float8 excess,
       details->>'category' category from comercial.metric_rows
       where extract(year from month)=$1 and base_code=any($2::text[]) and ($3='' or seller_key=$3)
         and coalesce((details->>'excluded_from_kpi')::boolean,false)=false
       group by month,kind,details->>'category'`,[p.year,bases,seller])).rows
    const states=(await db.query<{month:string;observed_on:string;data:Record<string,unknown>}>(
      `select to_char(month,'YYYY-MM') AS "month",observed_on::text,data from comercial.metric_state
       where extract(year from month)=$1 and base_code=any($2::text[])`,[p.year,bases])).rows
    const notes=(await db.query<{month:string;justification:string}>(
      `select to_char(month,'YYYY-MM') AS "month",justification from comercial.monthly_justifications
       where extract(year from month)=$1 and seller_key=$2`,[p.year,seller])).rows
    const stateBy=new Map<string,{observed:string;data:Record<string,unknown>}>()
    for(const s of states){const old=stateBy.get(s.month);stateBy.set(s.month,{observed:old&&old.observed>s.observed_on?old.observed:s.observed_on,data:{...(old?.data||{}),...s.data}})}
    const noteBy=new Map(notes.map(n=>[n.month,n.justification]))
    const rows:AnnualSummaryRow[]=Array.from({length:12},(_,i)=>{
      const month=`${p.year}-${String(i+1).padStart(2,'0')}`, list=metrics.filter(m=>m.month===month), state=stateBy.get(month)
      const sum=(kind:string)=>{const x=list.filter(m=>m.kind===kind&&m.amount!=null);return x.length?x.reduce((a,b)=>a+Number(b.amount),0):null}
      const count=(kind:string)=>{const x=list.filter(m=>m.kind===kind);return x.length?x.reduce((a,b)=>a+b.count,0):null}
      const expenses={fuel:null as number|null,travel:null as number|null,extras:null as number|null}
      for(const e of list.filter(m=>m.kind==='expense')){const k=expenseKind(e.category);expenses[k]=(expenses[k]??0)+(e.amount??0)}
      const knownCount=(kind:string,stateKey:string)=>count(kind)??(state?.data[stateKey]===true?0:null)
      const knownSum=(kind:string,stateKey:string)=>sum(kind)??(state?.data[stateKey]===true?0:null)
      const cancellation=sum('cancellation_effective')
      return {month,label:new Intl.DateTimeFormat('pt-BR',{month:'long',timeZone:'UTC'}).format(new Date(`${month}-01T00:00:00Z`)),positionDate:state?.observed||null,
        portfolio:sum('mrr'),fuel:expenses.fuel,travel:expenses.travel,extras:expenses.extras,
        excess:list.some(m=>m.kind==='expense'&&m.excess!=null)?list.filter(m=>m.kind==='expense').reduce((a,b)=>a+(b.excess??0),0):null,
        target:sum('target'),activations:sum('goal_sale'),upgrades:sum('upgrade'),downgrades:sum('downgrade'),
        cancellations:cancellation??sum('cancellation'),reversals:sum('cancellation_reversed')??sum('reversal'),
        leads:knownCount('lead_new','leads'),visits:knownCount('visit_task','visits'),converted:knownCount('lead_won','leads'),
        justification:noteBy.get(month)||'',receipts:knownSum('receipt','receipts'),debt:knownSum('debt','debts'),
        contractIssues:state?.data.closing===true||(count('expired')!=null||count('renewal_pending')!=null)
          ?(count('expired')??0)+(count('renewal_pending')??0):null}
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
