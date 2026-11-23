import 'server-only'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { DashboardData, Filters, Line, Goal, Trend, Category, Usage, MonthState, Metric, Seller, Viewer, BaseChange, BaseCode } from '@/lib/model'
import { earliestMonth, metricNames } from '@/lib/model'
import { detailIdentifiers, generatedRowKey, rowIdentifiers } from '@/lib/record-identifiers'
import { localDay } from '@/lib/format'
import { asUser } from './db'
import { demoMode } from './auth'

const monthFormat = /^\d{4}-(0[1-9]|1[0-2])$/
const raw = z.object({
  base:z.enum(['','old','new','legacy']).optional(),
  month: z.string().regex(monthFormat).optional(),
  seller: z.string().max(80).optional(),
  branch: z.string().max(150).optional(),
  city: z.string().max(150).optional(),
  product: z.string().max(100).optional(),
  period: z.enum(['monthly','quarterly','semiannual']).optional(),
})
export function filtersFrom(params: URLSearchParams, current: Viewer): Filters {
  const v = raw.parse(Object.fromEntries(params))
  const now = localDay().slice(0,7)
  const month = v.month && v.month>=earliestMonth && v.month<=now ? v.month : now
  return { month,period:v.period||'monthly',base:v.base||'',seller:current.seller_key || v.seller || '',branch:v.branch || '',city:v.city || '',product:v.product || '' }
}
const scope = (f: Filters, bases: BaseCode[]) => [f.month+'-01',f.seller,f.branch,f.city,f.product,bases]
const identity = "coalesce(details->>'identity',base_code||':'||(details->>'client'))"
const clientCounts = "count(distinct case when kind in ('visit_coverage','visit_overdue') then "+identity+" else base_code||':'||row_key end)"
async function positions(db:PoolClient, f:Filters) {
  const states=(await db.query<{base_code:BaseCode;data:MonthState;observed_on:string;refreshed_at:Date}>(
    'select base_code,data,observed_on::text,refreshed_at from comercial.metric_state where month=$1::date order by base_code',
    [f.month+'-01'])).rows
  const classified=states.filter(row=>row.base_code!=='legacy')
  const bases:BaseCode[]=f.base?[f.base as BaseCode]:classified.length?['old','new']:['legacy']
  return {states,bases}
}
const where = "month=$1::date and base_code=any($6::text[]) and ($2='' or seller_key=$2) " +
  "and ($3='' or branch=$3 or kind in ('target','expense','negotiation')) " +
  "and ($4='' or city=$4 or kind in ('target','expense','negotiation')) " +
  "and ($5='' or product=$5 or kind in ('target','expense','debt','visit_coverage','visit_task','visit_overdue','prospect_visit','lead_new','lead_won','negotiation'))"
const base = " from comercial.metric_rows where " + where
const val = (v: string|number|null|undefined) => v == null ? null : Number(v)
const pair = (start: number|null, end: number|null, entries: number|null, exits: number|null): BaseChange =>
  ({start,end,entries: start==null ? null : entries,exits:start==null ? null : exits})

async function aggregate(db: PoolClient, f: Filters, bases:BaseCode[]) {
  const filters = scope(f,bases)
  const summary = (await db.query<Line>(
    "select kind,(case when kind='target' then count(distinct seller_key) else "+clientCounts+" end)::int count,coalesce(sum(amount),0)::float8 amount, " +
    "count(distinct case when kind='visit_coverage' and amount=1 then "+identity+" end)::int coverage,coalesce(sum((details->>'excess')::numeric),0)::float8 excess," +
    "count(*) filter(where details->>'pending_limit'='true')::int missing" + base + " group by kind",filters)).rows
  const goals = (await db.query<Goal>(
    "with m as (select kind,seller_key,amount,label,details" + base + " and kind in ('target','goal_sale','goal_pending')) " +
    "select t.seller_key,t.label name,t.details->>'team' team,t.amount::float8 target, " +
    "coalesce(sum(m.amount) filter(where m.kind='goal_sale'),0)::float8 actual, " +
    "count(*) filter(where m.kind='goal_pending')::int pending from m t left join m on m.seller_key=t.seller_key and m.kind<>'target' " +
    "where t.kind='target' group by t.seller_key,t.label,t.details,t.amount order by actual desc,t.label",filters)).rows
  const daily = (await db.query<Trend>(
    "select occurred_on::text as day,sum(amount)::float8 value" + base + " and kind='goal_sale' group by occurred_on order by occurred_on",filters)).rows
  const expenses = (await db.query<Category>(
    "select details->>'category' name,coalesce(sum(amount),0)::float8 amount,count(*)::int count" + base +
    " and kind='expense' group by details->>'category' order by amount desc",filters)).rows
  const pipeline = (await db.query<Category>(
    "select coalesce(details->>'stage','Sem etapa') name,count(*)::int amount,count(*)::int count" + base +
    " and kind='negotiation' group by details->>'stage' order by amount desc",filters)).rows
  const countBase = (await db.query(
    "with scoped as (select kind,base_code||':'||row_key row_key,"+identity+" client,details,amount" + base + " and kind in ('opening_contract','active_contract','mrr','opening_mrr')), " +
    "c0 as (select row_key id,client from scoped where kind='opening_contract'), " +
    "c1 as (select row_key id,client from scoped where kind='active_contract'), " +
    "m as (select coalesce(a.row_key,b.row_key) id,coalesce(a.amount,0) s,coalesce(b.amount,0) e " +
      "from (select * from scoped where kind='opening_mrr') a full join (select * from scoped where kind='mrr') b using(row_key)) " +
    "select (select count(*) from c0)::int c0, (select count(*) from c1)::int c1, " +
    "(select count(*) from c1 where client is null)::int unresolved, " +
    "(select count(distinct client) from c0)::int p0,(select count(distinct client) from c1)::int p1," +
    "(select count(*) from (select id from c1 except select id from c0) z)::int centry," +
    "(select count(*) from (select id from c0 except select id from c1) z)::int cexit," +
    "(select count(*) from (select client from c1 where client is not null except select client from c0 where client is not null) z)::int pentry," +
    "(select count(*) from (select client from c0 where client is not null except select client from c1 where client is not null) z)::int pexit," +
    "(select sum(amount) from scoped where kind='opening_mrr')::float8 m0," +
    "(select sum(amount) from scoped where kind='mrr')::float8 m1," +
    "(select coalesce(sum(greatest(e-s,0)),0) from m)::float8 mentry," +
    "(select coalesce(sum(greatest(s-e,0)),0) from m)::float8 mexit", filters)).rows[0]
  const trend = (await db.query<Trend>(
    "select occurred_on::text as day, avg(amount)::float8 value" + base + " and kind='band' group by occurred_on order by occurred_on", filters)).rows
  const circuits = (await db.query<Usage>(
    "with b as (select coalesce(details->>'circuit',row_key) circuit,base_code,label,amount,occurred_on,details," +
      "row_number() over (partition by base_code,coalesce(details->>'circuit',row_key) order by occurred_on desc,amount desc) last_row," +
      "max(amount) over (partition by base_code,coalesce(details->>'circuit',row_key)) peak" + base + " and kind='band') " +
    "select circuit,base_code,label,amount::float8 last,peak::float8, (details->>'used')::float8 used,(details->>'capacity')::float8 capacity," +
    "occurred_on::text as day from b where last_row=1 order by peak desc limit 300", filters)).rows
  return {summary,goals,daily,expenses,pipeline,countBase,trend,circuits}
}
async function dashboardMonthly(current: Viewer, filters: Filters): Promise<DashboardData> {
  return asUser(current.email, async db => {
    const {states,bases}=await positions(db,filters)
    const selected=states.filter(row=>bases.includes(row.base_code))
    const state:MonthState=selected.reduce<MonthState>((out,row)=>{
      for(const key of ['closing','visits','expenses','debts','receipts','leads','signatures','overdue','changes','reversal','band','goal'] as const) {
        out[key]=out[key]||row.data[key]
      }
      for(const key of ['meal','lodging','threshold'] as const) out[key]=row.data[key]
      for(const key of ['debt_as_of','contract_as_of'] as const) {
        const date=row.data[key]
        if(date&&(!out[key]||date>out[key]))out[key]=date
      }
      return out
    },{})
    state.opening=selected.length===bases.length&&selected.every(row=>row.data.opening&&row.data.closing)
    const observed=selected.map(row=>row.observed_on).sort().at(-1)??null
    const lastUpdate=selected.map(row=>row.refreshed_at.toISOString()).sort().at(-1)??null
    const sellerList = (await db.query<Seller>('select * from comercial.sellers where active order by name')).rows
    const options = (await db.query<{branches:string[];cities:string[];products:string[]}>(
      "select array_agg(distinct branch order by branch) filter(where branch is not null) branches," +
      "array_agg(distinct city order by city) filter(where city is not null) cities," +
      "array_agg(distinct product order by product) filter(where product is not null) products " +
      "from comercial.metric_rows where month=$1::date and ($2='' or seller_key=$2) and base_code=any($3::text[])",[filters.month+'-01',filters.seller,bases])).rows[0]
    const a = await aggregate(db,filters,bases)
    const c=a.countBase
    const visit = a.summary.find(l=>l.kind==='visit_coverage')
    return {
      viewer:current, filters, options: { sellers:sellerList, branches:options.branches||[], cities:options.cities||[], products:options.products||[] },
      lines:a.summary, goals:a.goals, daily:a.daily, expenses:a.expenses, pipeline:a.pipeline, state, observed,
      lastUpdate, basePositions:states.map(row=>({code:row.base_code,observed:row.observed_on,
        contracts:!!row.data.closing,debts:!!row.data.debts,expenses:!!row.data.expenses})), demo:demoMode(), today:localDay(),
      base:{
        clients:pair(state.opening?c.p0:null,state.closing?c.p1:null,c.pentry,c.pexit),
        contracts:pair(state.opening?c.c0:null,state.closing?c.c1:null,c.centry,c.cexit),
        mrr:pair(val(c.m0),val(c.m1),c.mentry,c.mexit), unresolved:c.unresolved,
      },
      coverage:{active:visit?.count??0,visited:visit?.coverage??0,pending:(visit?.count??0)-(visit?.coverage??0),older:a.summary.find(l=>l.kind==='visit_overdue')?.count??0},
      bandwidth:{trend:a.trend,circuits:a.circuits},
    }
  })
}
function periodMonths(filters:Filters){
  const [year,month]=filters.month.split('-').map(Number)
  const size=filters.period==='quarterly'?3:filters.period==='semiannual'?6:1
  const block=Math.floor((month-1)/size)*size+1
  return Array.from({length:size},(_,i)=>`${year}-${String(block+i).padStart(2,'0')}`)
}
export async function dashboard(current:Viewer,filters:Filters):Promise<DashboardData>{
  const months=periodMonths(filters)
  if(months.length===1)return dashboardMonthly(current,{...filters,period:'monthly'})
  const all=await Promise.all(months.map(month=>dashboardMonthly(current,{...filters,month,period:'monthly'})))
  const last=all.at(-1)!, first=all[0]
  const positional=new Set(['active_contract','active_client','mrr','debt','expired','renewal_pending','unsigned','visit_coverage','visit_overdue','contract_values'])
  const lineKinds=new Set(all.flatMap(d=>d.lines.map(l=>l.kind)))
  last.lines=Array.from(lineKinds,k=>{
    const values=all.map(d=>d.lines.find(l=>l.kind===k)).filter(Boolean) as Line[]
    if(positional.has(k))return values.at(-1)??{kind:k,count:0,amount:0,coverage:0,excess:0,missing:0}
    return values.reduce<Line>((out,v)=>({kind:k,count:out.count+v.count,amount:out.amount+v.amount,coverage:out.coverage+v.coverage,excess:out.excess+v.excess,missing:out.missing+v.missing}),{kind:k,count:0,amount:0,coverage:0,excess:0,missing:0})
  })
  const goals=new Map<string,Goal>()
  for(const d of all)for(const g of d.goals){const old=goals.get(g.seller_key);goals.set(g.seller_key,old?{...g,target:old.target+g.target,actual:old.actual+g.actual,pending:old.pending+g.pending}:{...g})}
  last.goals=Array.from(goals.values()).sort((a,b)=>b.actual-a.actual)
  last.daily=all.flatMap(d=>d.daily)
  const categories=(key:'expenses'|'pipeline')=>{const map=new Map<string,Category>();for(const d of all)for(const row of d[key]){const old=map.get(row.name);map.set(row.name,{name:row.name,amount:(old?.amount||0)+row.amount,count:(old?.count||0)+row.count})}return Array.from(map.values())}
  last.expenses=categories('expenses');last.pipeline=categories('pipeline')
  last.base={clients:{start:first.base.clients.start,end:last.base.clients.end,entries:all.reduce((n,d)=>n+(d.base.clients.entries||0),0),exits:all.reduce((n,d)=>n+(d.base.clients.exits||0),0)},
    contracts:{start:first.base.contracts.start,end:last.base.contracts.end,entries:all.reduce((n,d)=>n+(d.base.contracts.entries||0),0),exits:all.reduce((n,d)=>n+(d.base.contracts.exits||0),0)},
    mrr:{start:first.base.mrr.start,end:last.base.mrr.end,entries:all.reduce((n,d)=>n+(d.base.mrr.entries||0),0),exits:all.reduce((n,d)=>n+(d.base.mrr.exits||0),0)},unresolved:last.base.unresolved}
  last.filters=filters;last.observed=last.observed;last.state={...first.state,...last.state}
  return last
}
type DetailResult={rows:Metric[];total:number;page:number;size:number}
export async function detail(current: Viewer, filters: Filters, params: URLSearchParams):Promise<DetailResult> {
  const kind = z.string().refine(v=>Object.hasOwn(metricNames,v),'Indicador inválido.').parse(params.get('kind'))
  const page = z.coerce.number().int().min(1).max(10000).catch(1).parse(params.get('page')||1)
  const search = z.string().max(160).catch('').parse(params.get('q')||'')
  const status = z.enum(['all','visited','pending']).catch('all').parse(params.get('status')||'all')
  const csv = params.get('format')==='csv'
  const size = csv ? 10000 : 20
  if(filters.period!=='monthly'){
    const query=new URLSearchParams(params);query.set('format','csv');query.set('page','1')
    const results:DetailResult[]=await Promise.all(periodMonths(filters).map(month=>detail(current,{...filters,month,period:'monthly'},query)))
    const rows:Metric[]=results.flatMap(result=>result.rows).sort((a,b)=>(b.occurred_on||'').localeCompare(a.occurred_on||''))
    return {rows:csv?rows:rows.slice((page-1)*size,page*size),total:rows.length,page,size}
  }
  return asUser(current.email, async db => {
    const {bases}=await positions(db,filters)
    const actualKind=kind==='active_client'?'active_contract':kind
    const identifierValues=detailIdentifiers.map(([key])=>"details->>'"+key+"'").join(',')
    const searchable="($8='' or position(lower($8) in lower(label)) > 0" +
      " or exists(select from unnest(array["+identifierValues+"]) as id(value) where position(lower($8) in lower(id.value)) > 0)" +
      " or (kind=any($10::text[]) and row_key !~ $11 and position(lower($8) in lower(row_key)) > 0))"
    const statusFilter="($9='all' or kind<>'visit_coverage' or ($9='visited' and amount=1) or ($9='pending' and amount=0))"
    const args=[...scope(filters,bases),actualKind,search,status,Object.keys(rowIdentifiers),generatedRowKey]
    const projection='select kind,row_key,m.base_code,m.seller_key,s.name seller,occurred_on::text,label,amount::float8,city,branch,product,details '+
      'from comercial.metric_rows m left join comercial.sellers s on s.seller_key=m.seller_key where '+where.replace('seller_key=$2','m.seller_key=$2')
        .replace('base_code=any','m.base_code=any')+' and kind=$7'
    const dedupe=kind==='active_client'||kind==='visit_coverage'||kind==='visit_overdue'||kind==='target'
    const distinctKey=kind==='target'?'seller_key':identity
    const eligible=kind==='active_client'?" where details->>'client' is not null":''
    const representative=dedupe
      ? 'select distinct on ('+distinctKey+') * from ('+projection+') r'+eligible+
        ' order by '+distinctKey+',amount desc nulls last,occurred_on desc nulls last,base_code,row_key'
      : projection
    const matched='select * from ('+representative+') r where '+searchable+' and '+statusFilter
    const count = (await db.query<{total:number}>('select count(*)::int total from ('+matched+') q',args)).rows[0].total
    const rows = (await db.query<Metric>(
      'select * from ('+matched+') q order by occurred_on desc nulls last,label,base_code,row_key limit $12 offset $13',
      [...args,size,csv?0:(page-1)*size])).rows
    if(kind==='active_contract'&&rows.length) {
      for(const baseCode of bases) {
        const scoped=rows.filter(row=>row.base_code===baseCode)
        if(!scoped.length)continue
        const extra=(await db.query<{row_key:string;renewal:string|null;total:number;observed_on:string}>(
          'select row_key,renewal::text,total::float8,observed_on::text from comercial.base_contract_details_for($1::date,$2,$3::text[])',
          [filters.month+'-01',baseCode,scoped.map(row=>row.row_key)])).rows
        const byKey=new Map(extra.map(row=>[row.row_key,row]))
        for(const row of scoped) {
          const details=byKey.get(row.row_key)
          if(details) Object.assign(row.details,{renewal:details.renewal,contract_total:details.total,contract_details_date:details.observed_on})
        }
      }
    }
    for(const row of rows) delete row.details.identity
    return {rows,total:count,page,size}
  })
}

