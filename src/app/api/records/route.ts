import { detail, filtersFrom } from '@/server/dashboard'
import { errorResponse, HttpError, json, session } from '@/server/http'
import { brl, dateLabel, pct } from '@/lib/format'
export const dynamic = 'force-dynamic'
export async function GET(req:Request) {
  try {
    const current=await session(), params=new URL(req.url).searchParams
    const result=await detail(current,filtersFrom(params,current),params)
    if(params.get('format')!=='csv')return json(result)
    if(result.total>result.size)throw new HttpError(422,'Mais de 10.000 registros. Reduza o período ou aplique filtros para exportar.')
    const escaped=(value:unknown)=>{
      let text=value==null?'':String(value)
      if(typeof value==='string'&&/^[\t\r\n ]*[=+\-@]/.test(text))text="'"+text
      return '"'+text.replaceAll('"','""')+'"'
    }
    const header=['Registro','Vendedor','Data','Valor ou quantidade','Produto','Contrato','Situação']
    const cols=result.rows.map(r=>[r.label,r.seller,dateLabel(r.occurred_on),r.kind==='band'?pct(r.amount):
      ['target','goal_sale','mrr','opening_mrr','expense','receipt','debt','upgrade','downgrade'].includes(r.kind)?brl(r.amount):r.amount,
      r.product,r.details.contract,r.details.status||r.details.reason])
    const csv='\ufeff'+[header,...cols].map(row=>row.map(escaped).join(';')).join('\r\n')
    return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'private, no-store'}})
  } catch (error) { return errorResponse(error) }
}

