'use client'
import { useCallback, useEffect, useState } from 'react'
import { Activity, BriefcaseBusiness, CalendarDays, ChevronDown, CircleUserRound, Filter, LayoutDashboard, LogOut, MapPinned, Menu, ReceiptText, RefreshCw, Settings2, Target, X, type LucideIcon } from 'lucide-react'
import { earliestMonth, roles, sections, type DashboardData, type Filters, type Section } from '@/lib/model'
import { dateLabel, monthLabel } from '@/lib/format'
import { Administration } from './admin'
import { Records, type DetailRequest } from './records'
import { Crm, Expenses, Overview, Portfolio, Sales } from './views'

const icons:Record<Section,LucideIcon>={overview:LayoutDashboard,portfolio:BriefcaseBusiness,sales:Target,crm:MapPinned,expenses:ReceiptText,admin:Settings2}
const headings:Record<Section,[string,string]>={
  overview:['Visão geral','Acompanhe a carteira, as metas e a operação comercial.'],
  portfolio:['Carteira','Consulte a base ativa, as movimentações e a saúde da carteira.'],
  sales:['Vendas e metas','Acompanhe o atingimento pela data de ativação do contrato.'],
  crm:['Leads e visitas','Monitore a prospecção, as conversões e a cobertura da carteira.'],
  expenses:['Despesas em campo','Acompanhe os gastos de viagem e os limites da operação.'],
  admin:['Administração','Importe os relatórios e configure as regras do painel.'],
}
const toQuery=(f:Filters)=>new URLSearchParams(Object.entries(f).filter(([,v])=>v))
function initials(name:string){return name.split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase()}
function monthsTo(day:string) {
  const result=[]
  const cursor=new Date(earliestMonth+'-01T00:00:00Z')
  while(cursor.toISOString().slice(0,7)<=day.slice(0,7)) {
    result.unshift(cursor.toISOString().slice(0,7))
    cursor.setUTCMonth(cursor.getUTCMonth()+1)
  }
  return result
}
function validSection(value:string|null,admin:boolean):Section {
  return sections.some(s=>s.key===value)&&(value!=='admin'||admin)?value as Section:'overview'
}
export function Workspace({initial,section}:{initial:DashboardData;section:string|null}) {
  const admin=initial.viewer.role==='admin'
  const [view,setView]=useState<Section>(()=>validSection(section,admin)),[data,setData]=useState(initial)
  const [filters,setFilters]=useState(initial.filters),[revision,setRevision]=useState(0)
  const [drawer,setDrawer]=useState(false),[more,setMore]=useState(false),[loading,setLoading]=useState(false)
  const [request,setRequest]=useState<DetailRequest|null>(null),[error,setError]=useState('')
  const [profileMenu,setProfileMenu]=useState(false)
  const current=initial.viewer, today=initial.today
  const showSeller=current.role!=='seller'
  const update=useCallback(()=>setRevision(n=>n+1),[])
  useEffect(()=>{
    const q=toQuery(filters)
    if(view!=='overview')q.set('section',view)
    history.replaceState(null,'','?'+q)
  },[filters,view])
  useEffect(()=>{
    if(filters===initial.filters&&!revision)return
    const controller=new AbortController()
    setLoading(true);setError('')
    fetch('/api/dashboard?'+toQuery(filters),{signal:controller.signal,cache:'no-store'}).then(async r=>{
      const body=await r.json()
      if(!r.ok)throw new Error(body.error)
      if(!controller.signal.aborted)setData(body)
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message||'Falha ao atualizar os indicadores.')})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return ()=>controller.abort()
  },[filters,initial.filters,revision])
  function navigate(next:Section){setView(next);setDrawer(false);setRequest(null)}
  function choose(key:keyof Filters,value:string){setFilters(old=>({...old,[key]:value}))}
  function inspect(kind:string,status?:DetailRequest['status']){if(!loading)setRequest({kind,status})}
  function sellerFilter(id:string){if(showSeller)choose('seller',filters.seller===id?'':id)}
  async function logout(){
    try{const r=await fetch('/api/auth/logout',{method:'POST'});if(r.ok)location.href='/';else setError('Falha ao sair da conta.')}
    catch{setError('Falha ao sair da conta.')}
  }
  const [heading,subheading]=headings[view]
  const extras=Number(!!filters.city)+Number(!!filters.branch)+Number(!!filters.product)
  const allowPortfolioFilters=view==='portfolio'||view==='sales'||view==='crm'
  return <div className="app-layout">
    <a href="#main" className="skip-link">Ir para o conteúdo</a>
    {drawer&&<button className="mobile-overlay" aria-label="Fechar navegação" onClick={()=>setDrawer(false)}/>}
    <aside className={'sidebar '+(drawer?'sidebar-open':'')}>
      <div className="sidebar-brand">
        <a href="/" aria-label="Link Brasil, visão geral" onClick={e=>{e.preventDefault();navigate('overview')}}><img src="/link-brasil.png" width={143} height={33} alt="Link Brasil"/></a>
        <span>Central de Vendas</span>
      </div>
      <nav aria-label="Navegação principal">
        {sections.filter(s=>s.key!=='admin'||admin).map(({key,label})=>{const Icon=icons[key];return <button key={key} className={view===key?'selected':''} aria-current={view===key?'page':undefined} onClick={()=>navigate(key)}>
          <Icon size={18}/><span>{label}</span>{view===key&&<i/>}</button>})}
      </nav>
      <div className="sidebar-bottom">
        {data.demo&&<div className="demo-indicator"><span className="dot blue"/>Ambiente de demonstração</div>}
        <button className="profile" aria-expanded={profileMenu} onClick={()=>setProfileMenu(v=>!v)}>
          <span className="avatar">{initials(current.name)}</span><span><strong>{current.name}</strong><small>{roles[current.role]}</small></span><ChevronDown size={15}/>
        </button>
        {profileMenu&&<div className="profile-menu"><button onClick={logout}><LogOut size={16}/>{data.demo?'Trocar perfil':'Sair da conta'}</button></div>}
      </div>
    </aside>
    <main className="workspace" id="main">
      <header className="topbar">
        <button className="icon-button mobile-toggle" aria-label="Abrir navegação" onClick={()=>setDrawer(true)}><Menu size={21}/></button>
        <div className="crumb"><span>Central de Vendas</span><b>/</b><strong>{sections.find(s=>s.key===view)?.label}</strong></div>
        <div className="topbar-right">
          <span className="data-freshness"><i className={'dot '+(data.lastUpdate?'green':'pale')}/>{data.observed?'Dados de '+dateLabel(data.observed):'Aguardando importação'}</span>
          <button className="icon-button subtle" aria-label="Atualizar indicadores" onClick={update} disabled={loading}><RefreshCw className={loading?'spin':''} size={16}/></button>
          <button className="top-avatar" onClick={()=>setDrawer(true)} aria-label="Perfil"><CircleUserRound size={19}/></button>
        </div>
      </header>
      <div className="main-content">
        <div className="page-title"><div><h1>{heading}</h1><p>{subheading}</p></div></div>
        {view!=='admin'&&<div className="filter-bar" aria-label="Filtros do painel">
          <label className="filter-control"><CalendarDays size={15}/><span>Competência</span>
            <select aria-label="Competência" value={filters.month} onChange={e=>choose('month',e.target.value)}>
              {monthsTo(today).map(m=><option value={m} key={m}>{monthLabel(m)}</option>)}</select></label>
          {showSeller&&<label className="filter-control"><span>Vendedor</span><select aria-label="Vendedor" value={filters.seller} onChange={e=>choose('seller',e.target.value)}>
            <option value="">Todos os vendedores</option>{data.options.sellers.map(s=><option key={s.seller_key} value={s.seller_key}>{s.name}</option>)}</select></label>}
          {(allowPortfolioFilters||extras>0)&&<button className={'secondary filter-toggle '+(more?'on':'')} aria-expanded={more} onClick={()=>setMore(v=>!v)}>
            <Filter size={15}/> Filtros {extras>0&&<span>{extras}</span>}</button>}
          {(filters.seller&&showSeller||extras>0)&&<button className="clear-filter" onClick={()=>setFilters(f=>({...f,seller:current.seller_key||'',branch:'',city:'',product:''}))}><X size={15}/>Limpar filtros</button>}
          {loading&&<span className="filter-status" role="status">Atualizando…</span>}
          {more&&<div className="more-filters">
            {([['branch','Filial','branches'],['city','Cidade','cities'],['product','Produto','products']] as const).map(([key,label,options])=>
              <label key={key}>{label}<select value={filters[key]} onChange={e=>choose(key,e.target.value)}>
                <option value="">Todas as opções</option>{data.options[options].map(v=><option key={v}>{v}</option>)}</select></label>)}
          </div>}
        </div>}
        {error&&<div className="notice error" role="alert">{error}</div>}
        <div className={'page-sections '+(loading?'loading':'')} aria-busy={loading}>
          {view==='overview'&&<Overview data={data} inspect={inspect} onSeller={sellerFilter} onSales={()=>navigate('sales')}/>}
          {view==='portfolio'&&<Portfolio data={data} inspect={inspect}/>}
          {view==='sales'&&<Sales data={data} inspect={inspect} onSeller={sellerFilter}/>}
          {view==='crm'&&<Crm data={data} inspect={inspect}/>}
          {view==='expenses'&&<Expenses data={data} inspect={inspect}/>}
          {view==='admin'&&admin&&<Administration today={today} onUpdated={update}/>}
        </div>
        <footer className="workspace-footer"><Activity size={14}/><span>Link Brasil · Central de Vendas</span>{data.demo&&<span>Dados fictícios</span>}</footer>
      </div>
    </main>
    {request&&<Records request={request} filters={filters} onClose={()=>setRequest(null)}/>}
  </div>
}

