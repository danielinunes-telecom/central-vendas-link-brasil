'use client'
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Search, X } from 'lucide-react'
import type { Filters, Metric } from '@/lib/model'
import { baseNames, metricNames } from '@/lib/model'
import { debtInstallment, recordIdentifiers } from '@/lib/record-identifiers'
import { brl, dateLabel, pct, qty } from '@/lib/format'
import { Empty } from './indicators'

export type DetailRequest={kind:string;status?:'all'|'pending'|'visited'}
const cash=new Set(['target','goal_sale','mrr','opening_mrr','expense','receipt','debt','contract_values','upgrade','downgrade'])
const amount=(m:Metric)=>m.kind==='band'?pct(m.amount):cash.has(m.kind)?brl(m.amount):m.kind==='visit_coverage'?(m.amount===1?'Visitado':'Pendente'):qty(m.amount)
function explanation(m:Metric) {
  const x=m.details
  if(m.kind==='contract_values') return [x.plan,x.seller_source,x.reason].filter(Boolean).join(' · ')
  if(m.kind==='goal_sale') return String(x.product)+' · '+brl(Number(x.gross))+' × '+pct(Number(x.rate)*100)
  if(m.kind==='expense') return [x.category,x.vehicle,x.trip,x.pending_limit?'Diárias ou pessoas pendentes':x.excess!=null?'Excedente '+brl(Number(x.excess)):null].filter(Boolean).join(' · ')
  if(m.kind==='band') return qty(Number(x.used))+' / '+qty(Number(x.capacity))+' Mbps'
  if(m.kind==='debt') return qty(Number(x.days))+' dias em atraso'
  return [x.subject,x.stage,x.method,x.reason,x.type,x.access].filter(Boolean).join(' · ')
}
type Result={rows:Metric[];total:number;page:number;size:number}
export function Records({request,filters,onClose}:{request:DetailRequest;filters:Filters;onClose:()=>void}) {
  const [page,setPage]=useState(1),[status,setStatus]=useState(request.status||'all'),[search,setSearch]=useState('')
  const [result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true)
  const [exporting,setExporting]=useState(false)
  const modal=useRef<HTMLDialogElement>(null)
  useEffect(()=>{
    const d=modal.current
    d?.showModal()
    return ()=>d?.close()
  },[])
  const kind=request.kind
  const contracts=kind==='active_contract'
  const debt=kind==='debt'
  const titles=debt||kind==='receipt'
  const showIds=kind!=='target'
  useEffect(()=>{
    const abort=new AbortController()
    const timer=setTimeout(async()=>{
      setLoading(true);setError('')
      const query=new URLSearchParams({...filters,kind,q:search,status,page:String(page)})
      try {
        const r=await fetch('/api/records?'+query,{signal:abort.signal})
        const body=await r.json()
        if(!r.ok) throw new Error(body.error)
        if(!abort.signal.aborted) setResult(body)
      } catch(e) {
        if(!abort.signal.aborted) setError(e instanceof Error?e.message:'Falha na consulta.')
      } finally { if(!abort.signal.aborted) setLoading(false) }
    },140)
    return ()=>{clearTimeout(timer);abort.abort()}
  },[filters,kind,page,search,status])
  async function exportCsv() {
    setExporting(true);setError('')
    try {
      const query=new URLSearchParams({...filters,kind,q:search,status,format:'csv'})
      const r=await fetch('/api/records?'+query)
      if(!r.ok) throw new Error((await r.json()).error)
      const link=document.createElement('a')
      link.href=URL.createObjectURL(await r.blob());link.download=kind+'-'+filters.month+'.csv'
      link.click();setTimeout(()=>URL.revokeObjectURL(link.href),2000)
    } catch(e) {setError(e instanceof Error?e.message:'Falha na exportação.')}
    finally {setExporting(false)}
  }
  return <dialog className="records-dialog" ref={modal} onCancel={onClose}
    onClick={e=>{if(e.target===e.currentTarget) onClose()}} aria-labelledby="records-title">
    <div className="records-content">
      <div className="records-heading"><div><h2 id="records-title">{metricNames[kind]||kind}</h2>
        <p>{result?qty(result.total)+' registros com os filtros atuais':'Registros da competência'}</p></div>
        <button className="icon-button subtle" onClick={onClose} aria-label="Fechar registros"><X size={21}/></button></div>
      <div className="records-tools">
        <label className="search"><Search size={16}/><input placeholder={debt?'Buscar cliente ou ID do título':'Buscar registro ou ID'} aria-label="Buscar registro" value={search}
          onChange={e=>{setSearch(e.target.value);setPage(1)}}/></label>
        {kind==='visit_coverage'&&<select aria-label="Situação da visita" value={status} onChange={e=>{setStatus(e.target.value as typeof status);setPage(1)}}>
          <option value="all">Todas as situações</option><option value="visited">Visitados</option><option value="pending">Pendentes</option></select>}
        <button className="secondary" onClick={exportCsv} disabled={exporting||!result?.total}><Download size={16}/>{exporting?'Exportando…':'Exportar CSV'}</button>
      </div>
      {error&&<div className="notice error" role="alert">{error}</div>}
      {loading&&!result?<div className="records-loading" role="status">Carregando registros…</div>:
        result?.rows.length?<div className="table-scroll records-table"><table className="data-table">
          <thead><tr>
            {titles&&<th>ID do título</th>}
            {debt&&<th>Nº da parcela</th>}
            <th>{titles?'Cliente':'Registro'}</th><th>Base</th>
            {showIds&&!debt&&<th>IDs de origem</th>}
            {contracts&&<><th>Renovação</th><th>Valor informado no PDF</th></>}
            <th>Vendedor</th><th>{debt?'Vencimento':titles?'Pagamento':'Data'}</th><th>{debt?'Saldo em aberto':'Valor / situação'}</th>
          </tr></thead>
          <tbody>{result.rows.map(m=><tr key={m.base_code+':'+m.row_key}>
            {titles&&<td><strong>{String(m.details.title??'—')}</strong></td>}
            {debt&&<td>{debtInstallment(m)??'—'}</td>}
            <td><strong>{m.label}</strong><small>{explanation(m)}</small></td>
            <td>{baseNames[m.base_code]}</td>
            {showIds&&!debt&&<td>{recordIdentifiers(m).filter(id=>!titles||id.key!=='title').map(id=>
              <small key={id.key}>{id.label} <strong>{id.value}</strong></small>)}</td>}
            {contracts&&<><td>{dateLabel(typeof (m.details.renewal??m.details.renewal_report)==='string'?String(m.details.renewal??m.details.renewal_report):null)}</td>
              <td>{brl(typeof m.details.contract_total==='number'?m.details.contract_total:typeof m.details.monthly_report==='number'?m.details.monthly_report:null)}
                <small>{m.details.contract_total!=null?'Total dos produtos':m.details.monthly_report!=null?'Líquido mensal':'Sem valor identificado'}</small>
                {typeof m.details.contract_details_date==='string'&&<small>Relatório de {dateLabel(m.details.contract_details_date)}</small>}</td></>}
            <td>{m.seller||'Pendente de vínculo'}</td><td>{dateLabel(m.occurred_on)}</td><td>{amount(m)}</td>
          </tr>)}</tbody>
        </table></div>:<Empty title="Nenhum registro encontrado" description="Altere os filtros para consultar outros resultados."/>}
      {!!result?.total&&<div className="records-pagination"><span>Página {result.page} de {Math.ceil(result.total/result.size)}</span>
        <button className="icon-button subtle" aria-label="Página anterior" onClick={()=>setPage(page-1)} disabled={page<=1}><ChevronLeft size={18}/></button>
        <button className="icon-button subtle" aria-label="Próxima página" onClick={()=>setPage(page+1)} disabled={page*result.size>=result.total}><ChevronRight size={18}/></button></div>}
    </div>
  </dialog>
}

