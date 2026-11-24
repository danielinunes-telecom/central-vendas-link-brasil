import { detail, filtersFrom } from '@/server/dashboard'
import { errorResponse, HttpError, json, session } from '@/server/http'
import { brl, dateLabel, pct } from '@/lib/format'
import { baseNames } from '@/lib/model'
import { debtInstallment, recordIdentifiers } from '@/lib/record-identifiers'
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
    const debt=params.get('kind')==='debt'
    const contracts=params.get('kind')==='active_contract'
    const header=debt?['ID do título','Nº da parcela','Cliente','Base','Vencimento','Vendedor','Saldo em aberto','Dias em atraso']:['Registro','Base','Vendedor','Data','Valor ou quantidade','Produto','Contrato','Situação','IDs de origem']
    if(contracts) header.push('Renovação','Valor total dos produtos','Data do relatório complementar','Valor líquido mensal do PDF')
    const cols=result.rows.map(r=>debt
      ? [r.details.title,debtInstallment(r),r.label,baseNames[r.base_code],dateLabel(r.occurred_on),r.seller,brl(r.amount),r.details.days]
      : [r.label,baseNames[r.base_code],r.seller,dateLabel(r.occurred_on),r.kind==='band'?pct(r.amount):
        ['target','goal_sale','mrr','opening_mrr','expense','receipt','contract_values','upgrade','downgrade','cancellation_effective','cancellation_reversed'].includes(r.kind)?brl(r.amount):r.amount,
        r.product,r.details.contract,r.details.status||r.details.reason,
        recordIdentifiers(r).map(id=>id.label+' '+id.value).join(' · '),
        ...(contracts ? [r.details.renewal ? dateLabel(String(r.details.renewal)) : '',
          typeof r.details.contract_total==='number' ? brl(r.details.contract_total) : '',
          r.details.contract_details_date ? dateLabel(String(r.details.contract_details_date)) : '',
          typeof r.details.monthly_report==='number' ? brl(r.details.monthly_report) : ''] : [])])
    const csv='\ufeff'+[header,...cols].map(row=>row.map(escaped).join(';')).join('\r\n')
    return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'private, no-store'}})
  } catch (error) { return errorResponse(error) }
}

