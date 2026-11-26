'use client'
import { useCallback, useContext, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowRight, CircleCheck, ClipboardList, Database, FileSpreadsheet, History, LoaderCircle, Plus, Settings2, UploadCloud, Wrench } from 'lucide-react'
import { FinancialVisibility, useMoney } from './financial-visibility'
import { dateLabel, pct, qty } from '@/lib/format'
import { baseNames, roles, sourceNames, type AdminData, type CorrectionIssue, type ImportBatch, type Role, type SourceStatus } from '@/lib/model'
import { Card, Empty } from './indicators'

const stateText:Record<string,string>={queued:'Na fila',processing:'Processando',complete:'Concluída',partial:'Concluída com avisos',failed:'Falhou',applied:'Importado',unchanged:'Já atualizado'}
const badge=(s:string)=>'status-badge '+(s==='failed'?'red':s==='partial'?'amber':s==='applied'||s==='complete'||s==='unchanged'?'green':'blue')
const sizeLabel=(n:number)=>n>=1024*1024?(n/(1024*1024)).toFixed(1).replace('.',',')+' MB':Math.ceil(n/1024)+' KB'
type ImportHistory={batches:ImportBatch[];sources:SourceStatus[]}

export function Administration({today,onUpdated}:{today:string;onUpdated:()=>void}) {
  const [tab,setTab]=useState<'imports'|'corrections'|'settings'>('imports')
  return <>
    <div className="view-tabs"><button className={tab==='imports'?'active':''} onClick={()=>setTab('imports')}><UploadCloud size={16}/> Importações</button>
      <button className={tab==='corrections'?'active':''} onClick={()=>setTab('corrections')}><Wrench size={16}/> Correções</button>
      <button className={tab==='settings'?'active':''} onClick={()=>setTab('settings')}><Settings2 size={16}/> Configurações</button></div>
    {tab==='imports'?<ImportPanel today={today} onUpdated={onUpdated}/>:tab==='corrections'?<CorrectionsPanel onUpdated={onUpdated}/>:<SettingsPanel today={today} onUpdated={onUpdated}/>}
  </>
}

function CorrectionsPanel({onUpdated}:{onUpdated:()=>void}){
  const show=useContext(FinancialVisibility)
  const [data,setData]=useState<AdminData|null>(null),[selected,setSelected]=useState<CorrectionIssue|null>(null)
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const read=useCallback(async()=>{const r=await fetch('/api/admin/corrections',{cache:'no-store'});const b=await r.json();if(!r.ok)throw new Error(b.error);setData(b)},[])
  useEffect(()=>{read().catch(e=>setError(e.message))},[read])
  async function save(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!selected)return;if(!show&&selected.kind==='goal'){setError('Exiba os valores para salvar a correção.');return}setBusy(true);setError('');setMessage('')
    const f=new FormData(e.currentTarget),value=selected.kind==='goal'?{seller:String(f.get('seller')),product:String(f.get('product')),total:Number(f.get('total')),note:String(f.get('note'))}
      :selected.kind==='contract_link'?{client:String(f.get('client')),note:String(f.get('note'))}
      :{classification:String(f.get('classification')),contract:String(f.get('contract')),note:String(f.get('note'))}
    try{const r=await fetch('/api/admin/corrections',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:selected.kind,base:selected.base_code,row:selected.row_key,value})});if(!r.ok)throw new Error((await r.json()).error)
      setMessage('Correção salva e competências recalculadas.');setSelected(null);await read();onUpdated()
    }catch(e){setError(e instanceof Error?e.message:'Falha ao salvar a correção.')}finally{setBusy(false)}}
  if(!data)return <Card title="Correções pendentes"><div className="import-body">{error?<div className="notice error">{error}</div>:'Consultando validações…'}</div></Card>
  const actionable=data.corrections.filter(i=>i.kind!=='import'),imports=data.corrections.filter(i=>i.kind==='import')
  return <div className="settings-stack">{message&&<div className="notice success"><CircleCheck size={16}/>{message}</div>}{error&&<div className="notice error">{error}</div>}
    <Card title="Validações pendentes" description="Registros que não puderam ser confirmados automaticamente.">
      {actionable.length?<div className="table-scroll"><table className="data-table"><thead><tr><th>Competência</th><th>Base</th><th>Registro</th><th>Motivo</th><th>Ação</th></tr></thead><tbody>
        {actionable.map(i=><tr key={i.key}><td>{i.month?i.month.slice(0,7):'—'}</td><td>{baseNames[i.base_code]}</td><td><strong>{i.label}</strong><small>ID {i.row_key}</small></td><td>{i.reason}</td><td><button className="secondary" onClick={()=>setSelected(i)}>Corrigir</button></td></tr>)}</tbody></table></div>
      :<Empty title="Nenhuma correção pendente" description="As importações disponíveis foram validadas automaticamente." icon={CircleCheck}/>}</Card>
    {selected&&<Card title={'Corrigir · '+selected.label} description={selected.reason}><form className="settings-form" onSubmit={save}>
      {selected.kind==='goal'&&<><label>Vendedor<select name="seller" required>{data.sellers.map(s=><option key={s.seller_key} value={s.seller_key}>{s.name}</option>)}</select></label>
        <div className="form-pair"><label>Descrição do produto<input name="product" defaultValue={String(selected.details.original_description||'')} required/></label><label>Valor total do contrato<input name="total" type={show?'number':'password'} readOnly={!show} title={!show?'Exiba os valores para editar':undefined} min="0" step="0.01" defaultValue={String(selected.details.contract_total||'')} required/></label></div></>}
      {selected.kind==='contract_link'&&<label>ID do cliente correto<input name="client" required/></label>}
      {selected.kind==='cancellation'&&<><label>ID do contrato correto<input name="contract" defaultValue={String(selected.details.contract||'')} placeholder="Obrigatório quando houver mais de um contrato"/></label><label>Classificação<select name="classification"><option value="request">Somente solicitação</option><option value="effective">Cancelamento efetivado</option><option value="reversed">Reversão confirmada</option><option value="pending">Manter pendente</option></select></label></>}
      <label>Justificativa da correção<input name="note" minLength={4} required/></label><div className="form-pair"><button type="submit" className="primary" disabled={busy}>Salvar e recalcular</button><button type="button" className="secondary" onClick={()=>setSelected(null)}>Cancelar</button></div>
    </form></Card>}
    {!!imports.length&&<Card title="Avisos dos arquivos" description="Erros estruturais exigem correção no arquivo e novo envio."><div className="simple-rows">{imports.map(i=><div key={i.key}><AlertTriangle size={16}/><span>{i.label}<small>{i.reason}</small></span><strong>{baseNames[i.base_code]}</strong></div>)}</div></Card>}
  </div>
}

function ImportPanel({today,onUpdated}:{today:string;onUpdated:()=>void}) {
  const [history,setHistory]=useState<ImportHistory|null>(null),[files,setFiles]=useState<File[]>([])
  const [base,setBase]=useState('')
  const [observed,setObserved]=useState(today),[drag,setDrag]=useState(false),[sending,setSending]=useState(false)
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[current,setCurrent]=useState<string|null>(null)
  const selector=useRef<HTMLInputElement>(null),updated=useRef(onUpdated)
  useEffect(()=>{updated.current=onUpdated},[onUpdated])
  const read=useCallback(async ()=>{
    try {
      const r=await fetch('/api/admin/imports',{cache:'no-store'})
      const body=await r.json()
      if(!r.ok) throw new Error(body.error)
      setHistory(body)
      return body as ImportHistory
    } catch(e){setError(e instanceof Error?e.message:'Falha ao consultar as importações.');return null}
  },[])
  useEffect(()=>{void read()},[read])
  const active=history?.batches.some(b=>b.status==='queued'||b.status==='processing')||!!current
  useEffect(()=>{
    if(!active) return
    const timer=setInterval(async()=>{
      const loaded=await read()
      const b=loaded?.batches.find(row=>row.id===current)
      if(b&&!['queued','processing'].includes(b.status)){
        setCurrent(null);setMessage(stateText[b.status]||b.status);updated.current()
      } else if(loaded&&!current&&!loaded.batches.some(b=>['queued','processing'].includes(b.status))) updated.current()
    },2300)
    return ()=>clearInterval(timer)
  },[active,current,read])
  function add(incoming:FileList|File[]) {
    if(sending)return
    setError('');setMessage('')
    const picked=Array.from(incoming)
    const eligible=picked.filter(f=>/\.(xlsx|xls|pdf)$/i.test(f.name)&&f.size>0&&f.size<=25*1024*1024)
    if(eligible.length!==picked.length){setError('Use apenas Excel ou o PDF de contratos detalhados, com vendedor ou de alterações, com até 25 MB por arquivo.');return}
    if(eligible.length>25||eligible.reduce((n,f)=>n+f.size,0)>100*1024*1024){setError('Envie até 25 relatórios e 100 MB por lote.');return}
    if(!base){setError('Selecione a base de origem do lote.');return}
    if(!observed){setError('Informe a data da extração.');return}
    setFiles(eligible)
    void send(eligible)
  }
  async function send(selection:File[]) {
    if(!selection.length||sending)return
    setSending(true);setError('');setMessage('')
    try {
      const form=new FormData()
      form.append('observed',observed)
      form.append('base',base)
      selection.forEach(f=>form.append('files',f))
      const r=await fetch('/api/admin/imports',{method:'POST',body:form})
      const body=await r.json()
      if(!r.ok)throw new Error(body.error)
      setFiles([]);setCurrent(body.id);setMessage('Arquivos enviados. A atualização começa automaticamente.')
      await read()
    } catch(e){setError(e instanceof Error?e.message:'Falha ao enviar o lote.')}
    finally {setSending(false)}
  }
  return <>
    <div className="content-grid admin-grid">
      <Card title="Importar relatórios" description="Use as exportações originais do IXC, CRM e Life Tracker.">
        <div className="import-body">
          <div className="import-actions"><label>Data da extração <input type="date" aria-label="Data da extração" value={observed}
            max={today} min="2026-01-01" disabled={sending} onChange={e=>setObserved(e.target.value)}/></label>
            <label>Base de origem <select value={base} onChange={e=>setBase(e.target.value)} disabled={sending}>
              <option value="">Selecione a base</option><option value="old">{baseNames.old}</option><option value="new">{baseNames.new}</option>
            </select></label></div>
          <input type="file" ref={selector} onChange={e=>{if(e.target.files)add(e.target.files);e.target.value=''}} multiple accept=".xlsx,.xls,.pdf" hidden/>
          <div className={'dropzone '+(drag?'drag':'')} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)}
            onDrop={e=>{e.preventDefault();setDrag(false);add(e.dataTransfer.files)}}>
            <UploadCloud size={27}/><strong>Arraste seus relatórios aqui</strong><span>Excel e PDF de contratos detalhados, com vendedor ou de alterações · até 25 MB por arquivo</span>
            <button className="secondary" onClick={()=>selector.current?.click()} disabled={sending}>
              {sending?<><LoaderCircle size={15} className="spin"/>Enviando…</>:'Selecionar arquivos'}</button>
          </div>
          {!!files.length&&<ul className="chosen-files">{files.map((f,i)=><li key={f.name+i}><FileSpreadsheet size={17}/><span>{f.name}</span><small>{sizeLabel(f.size)}</small></li>)}</ul>}
          {error&&files.length>0&&!sending&&<button className="secondary" onClick={()=>send(files)}><ArrowRight size={15}/>Tentar novamente</button>}
          {message&&<div className="notice info" role="status">{message}</div>}
          {error&&<div className="notice error" role="alert">{error}</div>}
        </div>
      </Card>
      <Card title="Última carga por fonte" description="Posições e relatórios disponíveis no painel">
        {history?.sources.length?<div className="source-list">{history.sources.map(s=><div key={s.base_code+':'+s.source}><Database size={15}/><span>{sourceNames[s.source]||s.source} · {baseNames[s.base_code]}</span>
          <small>{dateLabel(s.observed_on)}</small></div>)}</div>:<Empty title={history?'Aguardando a primeira carga':'Consultando fontes'} icon={Database}/>}
      </Card>
    </div>
    <Card title="Histórico de importações" description="Relatórios identificados, registros aplicados e avisos">
      {history?.batches.length?<div className="import-history">{history.batches.map((b,i)=><details key={b.id} open={i===0||undefined}>
        <summary><History size={17}/><strong>{dateLabel(b.observed_on)} · {baseNames[b.base_code]}</strong><span>{qty(b.files.length)} arquivos</span><span className={badge(b.status)}>{stateText[b.status]||b.status}</span></summary>
        {b.error&&<div className="notice error">{b.error}</div>}
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Arquivo</th><th>Relatório</th><th>Lidos</th><th>Aplicados</th><th>Situação</th></tr></thead>
          <tbody>{b.files.map(f=><tr key={f.id}><td><strong>{f.name}</strong>{f.error&&<small className="error-text">{f.error}</small>}
            {!!f.issues.length&&<details className="issue-list"><summary>{qty(f.issues.length)} avisos</summary><ul>{f.issues.map((v,i)=><li key={i}>Linha {v.line} · {v.message}</li>)}</ul></details>}</td>
            <td>{f.source?sourceNames[f.source]||f.source:'—'}</td><td>{qty(f.rows_read)}</td><td>{qty(f.rows_applied)}</td><td><span className={badge(f.status)}>{stateText[f.status]||f.status}</span></td></tr>)}</tbody></table></div>
      </details>)}</div>:<Empty title="Nenhum lote importado" icon={ClipboardList}/>}
    </Card>
  </>
}

const split=(v:FormDataEntryValue|null)=>String(v||'').split(/[,\n]/).map(s=>s.trim()).filter(Boolean)
const strings=(value:unknown)=>Array.isArray(value)?value.join(', '):''
const ruleFields=[
  {key:'aliases',label:'Nomes e códigos de vendedores',example:'APELIDO OU CÓDIGO = identificador do vendedor'},
  {key:'plan_products',label:'Planos e produtos',example:'CÓDIGO DO PLANO = PRODUTO'},
  {key:'contract_clients',label:'Vínculos entre contrato e cliente',example:'ID DO CONTRATO = ID DO CLIENTE'},
  {key:'band_links',label:'Vínculos de circuitos',example:'CIRCUITO OU LOGIN = ID DO CONTRATO'},
]
function mapText(v:unknown){return Object.entries(v&&typeof v==='object'?v:{}).map(([a,b])=>a+' = '+b).join('\n')}
function mapValue(v:FormDataEntryValue|null) {
  return Object.fromEntries(String(v||'').split('\n').filter(s=>s.trim()).map(line=>{
    const at=line.indexOf('=')
    if(at<1||!line.slice(at+1).trim())throw new Error('Use uma associação por linha no formato chave = valor.')
    return [line.slice(0,at).trim(),line.slice(at+1).trim()]
  }))
}
type Save=(e:FormEvent<HTMLFormElement>,key:string,transform:(f:FormData)=>unknown)=>void

function SettingsPanel({today,onUpdated}:{today:string;onUpdated:()=>void}) {
  const show=useContext(FinancialVisibility),money=useMoney()
  const [data,setData]=useState<AdminData|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const [accountRole,setAccountRole]=useState<Role>('seller'),[items,setItems]=useState(1)
  const read=useCallback(async()=>{
    const r=await fetch('/api/admin/settings',{cache:'no-store'})
    const body=await r.json()
    if(!r.ok)throw new Error(body.error)
    setData(body)
  },[])
  useEffect(()=>{read().catch(e=>setError(e.message))},[read])
  const save:Save=async(e,key,transform)=>{
    e.preventDefault()
    if(!show&&e.currentTarget.querySelector('input[readonly][type=password]')){setError('Exiba os valores para salvar esta configuração.');return}
    setBusy(true);setMessage('');setError('')
    try {
      const value=transform(new FormData(e.currentTarget))
      const r=await fetch('/api/admin/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,value})})
      if(!r.ok)throw new Error((await r.json()).error)
      setMessage('Configuração salva.');await read();onUpdated()
    }catch(e){setError(e instanceof Error?e.message:'Falha ao salvar.')}
    finally{setBusy(false)}
  }
  const saveBtn=(name='Salvar')=><button type="submit" className="primary" disabled={busy}>{name}</button>
  if(!data)return <Card title="Configurações"><div className="import-body">{error?<div className="notice error">{error}</div>:<p>Carregando configurações…</p>}</div></Card>
  const limits=data.rules.expense_limits as {meal:number;lodging:number}
  const products=Array.from(new Set(data.rates.map(r=>r.product)))
  const month=today.slice(0,7)
  const sellers=<>{data.sellers.map(s=><option key={s.seller_key} value={s.seller_key}>{s.name}</option>)}</>
  return <div className="settings-stack">
    {message&&<div className="notice success" role="status"><CircleCheck size={17}/>{message}</div>}
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="content-grid equal-grid">
      <Card title="Metas por vendedor" description="As alterações valem a partir da competência selecionada.">
        <form className="settings-form" onSubmit={e=>save(e,'target',f=>({seller:f.get('seller'),month:String(f.get('month'))+'-01',amount:Number(f.get('amount'))}))}>
          <label>Vendedor<select name="seller" required>{sellers}</select></label><div className="form-pair"><label>Competência<input type="month" name="month" min="2026-01" defaultValue={month} required/></label>
          <label>Meta em reais<input name="amount" type={show?'number':'password'} readOnly={!show} title={!show?'Exiba os valores para editar':undefined} min="0" step="0.01" defaultValue="7000" required/></label></div>{saveBtn('Salvar meta')}
        </form>
      </Card>
      <Card title="Cálculo das vendas" description="Baseado no contrato mais recente do cliente.">
        <p>O realizado usa o valor total do contrato mais recente vinculado ao cliente e aplica o percentual da categoria do produto. Casos sem valor, vínculo, vendedor ou classificação aparecem na aba Correções.</p>
      </Card>
    </div>
    <div className="content-grid equal-grid">
      <Card title="Cálculo das visitas" description="Todas as atividades são consideradas."><div className="import-body"><p>Meta mensal: um registro por contrato ativo do vendedor. Realizado: quantidade de atividades registradas, independentemente do assunto ou status.</p></div></Card>
      <Card title="Limites de despesas"><form className="settings-form" onSubmit={e=>save(e,'expense_limits',f=>({meal:Number(f.get('meal')),lodging:Number(f.get('lodging'))}))}>
        <label>Almoço e jantar por refeição<input name="meal" type={show?'number':'password'} readOnly={!show} title={!show?'Exiba os valores para editar':undefined} min="0" step="0.01" defaultValue={limits?.meal} required/></label>
        <label>Hospedagem por pessoa e diária<input name="lodging" type={show?'number':'password'} readOnly={!show} title={!show?'Exiba os valores para editar':undefined} min="0" step="0.01" defaultValue={limits?.lodging} required/></label>{saveBtn()}
      </form></Card>
      <Card title="Reversões no IXC"><form className="settings-form" onSubmit={e=>save(e,'reversal_types',f=>split(f.get('types')))}>
        <label>Tipos de alteração separados por vírgula<input name="types" defaultValue={strings(data.rules.reversal_types)} placeholder="Aguardando identificação no IXC"/></label>{saveBtn()}
      </form></Card>
      <Card title="Oportunidades por uso de banda"><form className="settings-form" onSubmit={e=>save(e,'band_threshold',f=>Number(f.get('threshold')))}>
        <label>Percentual mínimo de utilização<input name="threshold" type="number" min="1" max="100" defaultValue={Number(data.rules.band_threshold||80)} required/></label>{saveBtn()}
      </form></Card>
    </div>
    <Card title="Validação da meta" description="As correções principais agora são apresentadas automaticamente na aba Correções.">
      <details className="settings-disclosure"><summary>Validar uma ativação específica</summary>
        <form className="settings-form" onSubmit={e=>save(e,'sale_review',f=>({contract:f.get('contractBase')==='legacy'?f.get('contract'):String(f.get('contractBase'))+':'+String(f.get('contract')),seller:f.get('seller'),note:f.get('note'),
          items:Array.from({length:items},(_,i)=>({product:f.get('product'+i),total:Number(f.get('total'+i))}))}))}>
          <label>Base do contrato<select name="contractBase" defaultValue="new">{Object.entries(baseNames).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>
          <div className="form-pair"><label>ID do contrato<input name="contract" required/></label><label>Vendedor da venda<select name="seller">{sellers}</select></label></div>
          {Array.from({length:items},(_,i)=><div key={i} className="form-pair"><label>Produto {i+1}<select name={'product'+i}>{products.map(p=><option key={p}>{p}</option>)}</select></label>
            <label>Valor do item<input name={'total'+i} type={show?'number':'password'} readOnly={!show} title={!show?'Exiba os valores para editar':undefined} min="0" step="0.01" required/></label></div>)}
          <button type="button" className="secondary" onClick={()=>setItems(n=>Math.min(n+1,10))}><Plus size={16}/>Adicionar item</button>
          <label>Referência da conferência<input name="note" minLength={4} required/></label>{saveBtn('Salvar conferência')}
        </form>
        <form className="settings-form" onSubmit={e=>save(e,'clear_sale_review',f=>({contract:f.get('contractBase')==='legacy'?f.get('contract'):String(f.get('contractBase'))+':'+String(f.get('contract'))}))}>
          <label>Base do contrato<select name="contractBase" defaultValue="new">{Object.entries(baseNames).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>
          <label>ID do contrato para remover a conferência<input name="contract" required/></label>{saveBtn('Remover conferência')}
        </form>
      </details>
      {ruleFields.map(({key,label,example})=><details key={key} className="settings-disclosure"><summary>{label}</summary>
        <form className="settings-form" onSubmit={e=>save(e,key,f=>mapValue(f.get('mapping')))}><label>{example}
          {key!=='aliases'&&<small>Para as novas bases, use o prefixo old: ou new: antes do código.</small>}
          <textarea rows={5} name="mapping" defaultValue={mapText(data.rules[key])}/></label>
          {key==='aliases'&&<small>{data.sellers.map(s=>s.seller_key).join(' · ')}</small>}{saveBtn()}</form></details>)}
    </Card>
    <Card title="Perfis de acesso" description="Vincule a conta corporativa cadastrada no Supabase ao perfil do painel.">
      <form className="settings-form" onSubmit={e=>save(e,'account',f=>({name:f.get('name'),email:f.get('email'),role:f.get('role'),seller:accountRole==='seller'?f.get('seller'):null,active:f.get('active')==='on'}))}>
        <div className="form-pair"><label>Nome<input name="name" required/></label><label>E-mail<input name="email" type="email" required/></label></div>
        <div className="form-pair"><label>Perfil<select name="role" value={accountRole} onChange={e=>setAccountRole(e.target.value as Role)}>
          {Object.entries(roles).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          {accountRole==='seller'&&<label>Vendedor vinculado<select name="seller">{sellers}</select></label>}</div>
        <label className="checkbox"><input name="active" type="checkbox" defaultChecked/>Acesso ativo</label>{saveBtn('Salvar perfil')}
      </form>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Usuário</th><th>Perfil</th><th>Situação</th></tr></thead>
        <tbody>{data.accounts.map(a=><tr key={a.email}><td><strong>{a.name}</strong><small>{a.email}</small></td><td>{roles[a.role]}</td><td>{a.active?'Ativo':'Inativo'}</td></tr>)}</tbody></table></div>
    </Card>
    <div className="content-grid equal-grid">

      <Card title="Metas cadastradas"><div className="simple-rows settings-target-list">{data.targets.filter(r=>r.effective_month<=today).filter((r,i,a)=>a.findIndex(v=>v.seller_key===r.seller_key)===i).map(r=><div key={r.seller_key}><span>{r.name}</span><strong>{money(Number(r.amount))}</strong></div>)}</div></Card>
    </div>
  </div>
}

