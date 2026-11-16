import 'server-only'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { DashboardData, Filters, Line, Goal, Trend, Category, Usage, MonthState, Metric, Seller, Viewer, BaseChange } from '@/lib/model'
import { earliestMonth, metricNames } from '@/lib/model'
import { localDay } from '@/lib/format'
import { asUser } from './db'
import { demoMode } from './auth'

const monthFormat = /^\d{4}-(0[1-9]|1[0-2])$/
const raw = z.object({
  month: z.string().regex(monthFormat).optional(),
  seller: z.string().max(80).optional(),
  branch: z.string().max(150).optional(),
  city: z.string().max(150).optional(),
  product: z.string().max(100).optional(),
})
export function filtersFrom(params: URLSearchParams, current: Viewer): Filters {
  const v = raw.parse(Object.fromEntries(params))
  const now = localDay().slice(0,7)
  const month = v.month && v.month>=earliestMonth && v.month<=now ? v.month : now
  return { month,seller:current.seller_key || v.seller || '',branch:v.branch || '',city:v.city || '',product:v.product || '' }
}
const scope = (f: Filters) => [f.month+'-01',f.seller,f.branch,f.city,f.product]
const where = "month=$1::date and ($2='' or seller_key=$2) " +
  "and ($3='' or branch=$3 or kind in ('target','expense','negotiation')) " +
  "and ($4='' or city=$4 or kind in ('target','expense','negotiation')) " +
  "and ($5='' or product=$5 or kind in ('target','expense','debt','visit_coverage','visit_task','visit_overdue','prospect_visit','lead_new','lead_won','negotiation'))"
const base = " from comercial.metric_rows where " + where
const val = (v: string|number|null|undefined) => v == null ? null : Number(v)
const pair = (start: number|null, end: number|null, entries: number|null, exits: number|null): BaseChange =>
  ({start,end,entries: start==null ? null : entries,exits:start==null ? null : exits})

async function aggregate(db: PoolClient, f: Filters) {
  const filters = scope(f)
  const summary = (await db.query<Line>(
    "select kind,count(*)::int count,coalesce(sum(amount),0)::float8 amount, " +
    "count(*) filter(where amount=1)::int coverage,coalesce(sum((details->>'excess')::numeric),0)::float8 excess," +
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
    "with scoped as (select kind,row_key,details,amount" + base + " and kind in ('opening_contract','active_contract','mrr','opening_mrr')), " +
    "c0 as (select row_key id,details->>'client' client from scoped where kind='opening_contract'), " +
    "c1 as (select row_key id,details->>'client' client from scoped where kind='active_contract'), " +
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
    "with b as (select coalesce(details->>'circuit',row_key) circuit,label,amount,occurred_on,details," +
      "row_number() over (partition by coalesce(details->>'circuit',row_key) order by occurred_on desc,amount desc) last_row," +
      "max(amount) over (partition by coalesce(details->>'circuit',row_key)) peak" + base + " and kind='band') " +
    "select circuit,label,amount::float8 last,peak::float8, (details->>'used')::float8 used,(details->>'capacity')::float8 capacity," +
    "occurred_on::text as day from b where last_row=1 order by peak desc limit 300", filters)).rows
  return {summary,goals,daily,expenses,pipeline,countBase,trend,circuits}
}
export async function dashboard(current: Viewer, filters: Filters): Promise<DashboardData> {
  return asUser(current.email, async db => {
    const s = await db.query<{data:MonthState;observed_on:string;refreshed_at:Date}>(
      'select data,observed_on::text,refreshed_at from comercial.metric_state where month=$1::date',[filters.month+'-01'])
    const state = s.rows[0]?.data ?? {}
    const observed = s.rows[0]?.observed_on ?? null
    const sellerList = (await db.query<Seller>('select * from comercial.sellers where active order by name')).rows
    const options = (await db.query<{branches:string[];cities:string[];products:string[]}>(
      "select array_agg(distinct branch order by branch) filter(where branch is not null) branches," +
      "array_agg(distinct city order by city) filter(where city is not null) cities," +
      "array_agg(distinct product order by product) filter(where product is not null) products " +
      "from comercial.metric_rows where month=$1::date and ($2='' or seller_key=$2)",[filters.month+'-01',filters.seller])).rows[0]
    const a = await aggregate(db,filters)
    const c=a.countBase
    const visit = a.summary.find(l=>l.kind==='visit_coverage')
    return {
      viewer:current, filters, options: { sellers:sellerList, branches:options.branches||[], cities:options.cities||[], products:options.products||[] },
      lines:a.summary, goals:a.goals, daily:a.daily, expenses:a.expenses, pipeline:a.pipeline, state, observed,
      lastUpdate:s.rows[0]?.refreshed_at.toISOString() ?? null, demo:demoMode(), today:localDay(),
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
export async function detail(current: Viewer, filters: Filters, params: URLSearchParams) {
  const kind = z.string().refine(v=>Object.hasOwn(metricNames,v),'Indicador inválido.').parse(params.get('kind'))
  const page = z.coerce.number().int().min(1).max(10000).catch(1).parse(params.get('page')||1)
  const search = z.string().max(160).catch('').parse(params.get('q')||'')
  const status = z.enum(['all','visited','pending']).catch('all').parse(params.get('status')||'all')
  const csv = params.get('format')==='csv'
  const size = csv ? 10000 : 20
  return asUser(current.email, async db => {
    const actualKind=kind==='active_client'?'active_contract':kind
    const conditions=where+" and kind=$6 and ($7='' or position(lower($7) in lower(label || ' ' || coalesce(details->>'contract',''))) > 0)" +
      " and ($8='all' or kind<>'visit_coverage' or ($8='visited' and amount=1) or ($8='pending' and amount=0))"
    const args=[...scope(filters),actualKind,search,status]
    const projection='select kind,row_key,m.seller_key,s.name seller,occurred_on::text,label,amount::float8,city,branch,product,details '+
      'from comercial.metric_rows m left join comercial.sellers s on s.seller_key=m.seller_key where '+conditions.replace('seller_key=$2','m.seller_key=$2')
    const matched=kind==='active_client'?"select distinct on(details->>'client') * from ("+projection+
      ") r where details->>'client' is not null order by details->>'client',occurred_on desc,row_key":projection
    const count = (await db.query<{total:number}>('select count(*)::int total from ('+matched+') q',args)).rows[0].total
    const rows = (await db.query<Metric>(
      'select * from ('+matched+') q order by occurred_on desc nulls last,label,row_key limit $9 offset $10',
      [...args,size,csv?0:(page-1)*size])).rows
    return {rows,total:count,page,size}
  })
}

