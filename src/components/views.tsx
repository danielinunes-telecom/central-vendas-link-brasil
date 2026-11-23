'use client'
import { useState } from 'react'
import { Banknote, BriefcaseBusiness, CircleCheck, CircleDollarSign, FileBadge, FileClock, MapPinCheck, ReceiptText, Target, TrendingUp, Users } from 'lucide-react'
import type { DashboardData, Goal } from '@/lib/model'
import { brl, dateLabel, pct, qty, ratio } from '@/lib/format'
import { BandwidthCard, BaseCard, Card, Empty, ExpensesCard, GoalsChart, goalTotal, Kpi, line, MovementList, OverviewKpis, SeriesChart, TextAction, VisitsCard, type Inspect } from './indicators'

export function Overview({data,inspect,onSeller,onSales}:{data:DashboardData;inspect:Inspect;onSeller:(id:string)=>void;onSales:()=>void}) {
  const cancellationOrders=line(data,'cancellation_request').count+line(data,'cancellation_effective').count+line(data,'cancellation_reversed').count+line(data,'cancellation_pending').count
  const decisions=line(data,'cancellation_effective').count+line(data,'cancellation_reversed').count
  return <>
    <OverviewKpis data={data} inspect={inspect}/>
    <div className="content-grid equal-grid">
      <Card title="Renovações da carteira" description="Vencimento contratual; não confundir com vencimento de fatura"><div className="simple-rows">
        <button onClick={()=>inspect('expired')}><FileClock size={17}/><span>Contratos vencidos</span><strong>{qty(line(data,'expired').count)}</strong></button>
        <button onClick={()=>inspect('renewal_pending')}><FileClock size={17}/><span>Vencem nos próximos 60 dias</span><strong>{qty(line(data,'renewal_pending').count)}</strong></button>
      </div></Card>
      <Card title="Atendimentos de cancelamento" description="Contratos e atendimentos são contados separadamente"><div className="simple-rows">
        <button onClick={()=>inspect('cancellation_request')}><FileClock size={17}/><span>Solicitações identificadas</span><strong>{qty(line(data,'cancellation_request').count)}</strong></button>
        <button onClick={()=>inspect('cancellation_reversed')}><CircleCheck size={17}/><span>Reversões confirmadas</span><strong>{qty(line(data,'cancellation_reversed').count)}</strong></button>
        <button onClick={()=>inspect('cancellation_pending')}><FileBadge size={17}/><span>Pendentes de revisão</span><strong>{qty(line(data,'cancellation_pending').count)}</strong></button>
      </div><div className="card-foot">{cancellationOrders?`Taxa de reversão: ${pct(ratio(line(data,'cancellation_reversed').count,decisions))} das decisões confirmadas`:'Aguardando importação das ordens de serviço'}</div></Card>
    </div>
    <div className="content-grid main-grid">
      <GoalsChart goals={data.goals} onSeller={onSeller} onDetails={onSales}/>
      <VisitsCard data={data} inspect={inspect}/>
    </div>
    <div className="content-grid main-grid">
      <BaseCard data={data} inspect={inspect}/>
      <ExpensesCard data={data} inspect={inspect}/>
    </div>
  </>
}

export function Portfolio({data,inspect,financialVisible}:{data:DashboardData;inspect:Inspect;financialVisible:boolean}) {
  const [tab,setTab]=useState<'base'|'finance'|'band'>('base')
  const {base}=data
  const reported=line(data,'contract_values')
  return <>
    <div className="kpis">
      <Kpi label="Clientes ativos" value={qty(base.clients.end)} description={qty(base.unresolved)+' contratos com vínculo pendente'} icon={Users} onClick={()=>inspect('active_client')}/>
      <Kpi label="Contratos ativos" value={qty(base.contracts.end)} description="Inclui bloqueados e suspensos ativos" icon={BriefcaseBusiness} tone="teal" onClick={()=>inspect('active_contract')}/>
      <Kpi label="Receita mensal recorrente" value={financialVisible?brl(base.mrr.end):'R$ ••••••'} description={qty(line(data,'mrr').count)+' de '+qty(base.contracts.end)+' contratos · estimativa'} icon={Banknote} tone="violet" onClick={()=>inspect('mrr')}/>
      <Kpi label="Inadimplência de 60 dias" value={data.state.debts?(financialVisible?brl(line(data,'debt').amount):'R$ ••••••'):'—'} description={data.state.debts?
        qty(line(data,'debt').count)+' títulos'+(data.state.debt_as_of?' · posição de '+dateLabel(data.state.debt_as_of):' no período'):'Aguardando títulos'} icon={CircleDollarSign} tone="amber" onClick={()=>inspect('debt')}/>
    </div>
    {reported.count>0&&<Card title="Contratos e valores do PDF com vendedor" description="Quantidade de registros e valor líquido mensal informado pelo IXC">
      <div className="simple-rows">
        <button onClick={()=>inspect('contract_values')}><BriefcaseBusiness size={17}/><span>Contratos no relatório</span><strong>{qty(reported.count)}</strong></button>
        <button onClick={()=>inspect('contract_values')}><Banknote size={17}/><span>Valor líquido mensal do relatório</span><strong>{brl(reported.amount)}</strong></button>
      </div>
      <div className="card-foot">O detalhamento sinaliza os registros cujo ID do contrato ainda precisa ser confirmado.</div>
    </Card>}
    <div className="view-tabs" aria-label="Análises da carteira">
      {([['base','Movimentação'],['finance','Financeiro e contratos'],['band','Uso de banda']] as const).map(([key,label])=><button key={key} className={tab===key?'active':''} onClick={()=>setTab(key)}>{label}</button>)}
    </div>
    {tab==='base'&&<div className="content-grid main-grid"><BaseCard data={data} inspect={inspect}/><MovementList data={data} inspect={inspect}/></div>}
    {tab==='finance'&&<div className="content-grid equal-grid">
      <Card title="Recebimentos da carteira" description="Apuração pela data do pagamento">
        <div className="finance-value"><strong>{data.state.receipts?brl(line(data,'receipt').amount):'—'}</strong><span>{qty(line(data,'receipt').count)} títulos com pagamento identificado</span></div>
        <div className="card-foot"><TextAction onClick={()=>inspect('receipt')}>Ver recebimentos</TextAction></div>
      </Card>
      <Card title="Pendências contratuais" description="Contratos ativos com situação pendente">
        <div className="simple-rows">
          <button onClick={()=>inspect('expired')}><FileClock size={17}/><span>Contratos vencidos</span><strong>{qty(line(data,'expired').count)}</strong></button>
          <button onClick={()=>inspect('renewal_pending')}><FileClock size={17}/><span>Pendentes de renovação</span><strong>{qty(line(data,'renewal_pending').count)}</strong></button>
          <button onClick={()=>inspect('unsigned')}><FileBadge size={17}/><span>Assinatura pendente</span><strong>{data.state.signatures?qty(line(data,'unsigned').count):'—'}</strong></button>
        </div>
        {!data.state.signatures&&<div className="card-foot">Aguardando situação de assinatura no IXC.</div>}
      </Card>
    </div>}
    {tab==='band'&&<BandwidthCard data={data} inspect={inspect}/>}
  </>
}

export function Sales({data,inspect,onSeller}:{data:DashboardData;inspect:Inspect;onSeller:(id:string)=>void}) {
  const goals=goalTotal(data)
  let cumulative=0
  const series=data.daily.map(row=>({day:row.day,value:cumulative+=row.value}))
  const [sort,setSort]=useState<'actual'|'target'|'name'>('actual')
  const displayed=data.goals.slice().sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'pt-BR'):b[sort]-a[sort])
  return <>
    <div className="kpis three">
      <Kpi label="Meta da competência" value={brl(goals.target)} description={qty(data.goals.length)+' vendedores'} icon={Target} onClick={()=>inspect('target')}/>
      <Kpi label="Realizado validado" value={data.state.goal?brl(goals.actual):'—'} description={(data.state.goal?pct(ratio(goals.actual,goals.target))+' de atingimento':'Aguardando dados de vendas')} icon={TrendingUp} tone="teal" onClick={()=>inspect('goal_sale')}/>
      <Kpi label="Ativações pendentes" value={qty(goals.pending)} description="Produto, valor ou vendedor a confirmar" icon={FileClock} tone="amber" onClick={()=>inspect('goal_pending')}/>
    </div>
    <div className="content-grid equal-grid">
      <GoalsChart goals={data.goals} onSeller={onSeller} onDetails={()=>inspect('goal_sale')}/>
      <Card title="Evolução do realizado" description="Valor acumulado pelas datas de ativação"><SeriesChart values={series} label="Realizado acumulado"/></Card>
    </div>
    <Card title="Atingimento por vendedor" description={goals.pending?'Apuração parcial enquanto houver ativações pendentes.':'Vendas apuradas no mês da ativação.'}>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th><button onClick={()=>setSort('name')}>Vendedor</button></th><th>Equipe</th><th><button onClick={()=>setSort('target')}>Meta</button></th>
          <th><button onClick={()=>setSort('actual')}>Realizado</button></th><th>Atingimento</th><th>Pendentes</th></tr></thead>
        <tbody>{displayed.map((g:Goal)=><tr key={g.seller_key}><td><button className="table-link" onClick={()=>onSeller(g.seller_key)}>{g.name}</button></td>
          <td>{g.team}</td><td>{brl(g.target)}</td><td>{brl(g.actual)}</td>
          <td><div className="table-progress"><span>{pct(ratio(g.actual,g.target))}</span><div className="micro-track"><i style={{width:Math.min(100,ratio(g.actual,g.target)||0)+'%'}}/></div></div></td>
          <td>{g.pending?<button className="status-badge amber" onClick={()=>inspect('goal_pending')}>{qty(g.pending)}</button>:'—'}</td></tr>)}</tbody>
      </table></div>
      {!displayed.length&&<Empty title="Sem metas disponíveis para esta competência" icon={Target}/>}
    </Card>
  </>
}

export function Crm({data,inspect}:{data:DashboardData;inspect:Inspect}) {
  const funnel=[
    ['lead_new','Leads prospectados',line(data,'lead_new').count,Users],
    ['prospect_visit','Visitas de prospecção',line(data,'prospect_visit').count,MapPinCheck],
    ['lead_won','Leads efetivados',line(data,'lead_won').count,CircleCheck],
  ] as const
  return <>
    <div className="kpis three">{funnel.map(([key,name,count,icon],i)=>
      <Kpi key={key} label={name} value={(key==='prospect_visit'?data.state.visits:data.state.leads)?qty(count):'—'} description={key==='lead_won'?'Cliente vinculado com contrato ativado':'Na competência selecionada'}
        icon={icon} tone={i===1?'violet':i===2?'teal':'blue'} onClick={()=>inspect(key)}/>)}</div>
    <div className="content-grid equal-grid">
      <VisitsCard data={data} inspect={inspect}/>
      <Card title="Negociações por etapa" description="Negócios iniciados na competência" action={<TextAction onClick={()=>inspect('negotiation')}>Ver negócios</TextAction>}>
        {data.pipeline.length?<div className="simple-rows">{data.pipeline.map(item=><button key={item.name} onClick={()=>inspect('negotiation')}><TrendingUp size={17}/><span>{item.name}</span><strong>{qty(item.count)}</strong></button>)}</div>
          :<Empty title="Sem negociações no período" icon={Users}/>}
      </Card>
    </div>
    <Card title="Acompanhamento da carteira" description="Cobertura por cliente da Base Velha. Visitas e relacionamentos contam pela data de início, em todos os status.">
      <div className="simple-rows">
        <button onClick={()=>inspect('visit_coverage','pending')}><MapPinCheck size={17}/><span>Clientes pendentes de visita no mês</span><strong>{qty(data.coverage.pending)}</strong></button>
        <button onClick={()=>inspect('visit_coverage','visited')}><CircleCheck size={17}/><span>Clientes visitados na competência</span><strong>{qty(data.coverage.visited)}</strong></button>
        <button onClick={()=>inspect('visit_overdue')}><FileClock size={17}/><span>Clientes com 60 dias sem visita</span><strong>{data.state.overdue?qty(data.coverage.older):'—'}</strong></button>
      </div>
    </Card>
  </>
}

export function Expenses({data,inspect}:{data:DashboardData;inspect:Inspect}) {
  const total=line(data,'expense')
  return <>
    <div className="kpis three">
      <Kpi label="Total em campo" value={data.state.expenses?brl(total.amount):'—'} description={qty(total.count)+' lançamentos'} icon={ReceiptText} onClick={()=>inspect('expense')}/>
      <Kpi label="Excedente apurado" value={data.state.expenses?brl(total.excess):'—'} description="Conforme os limites configurados" icon={CircleDollarSign} tone="teal" onClick={()=>inspect('expense')}/>
      <Kpi label="Hospedagem a validar" value={data.state.expenses?qty(total.missing):'—'} description="Quantidade de pessoas ou diárias pendente" icon={FileClock} tone="amber" onClick={()=>inspect('expense')}/>
    </div>
    <div className="content-grid equal-grid">
      <ExpensesCard data={data} inspect={inspect}/>
      <Card title="Limites de viagem" description="Valores por lançamento elegível">
        <div className="simple-rows">
          <div><ReceiptText size={17}/><span>Almoço</span><strong>{brl(data.state.meal??40)} / refeição</strong></div>
          <div><ReceiptText size={17}/><span>Jantar</span><strong>{brl(data.state.meal??40)} / refeição</strong></div>
          <div><ReceiptText size={17}/><span>Hospedagem</span><strong>{brl(data.state.lodging??180)} / pessoa por diária</strong></div>
        </div>
      </Card>
    </div>
  </>
}

