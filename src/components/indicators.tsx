'use client'
import { useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, BriefcaseBusiness, ChartNoAxesCombined, Clock3, FileSearch, MapPinCheck, RadioTower, ReceiptText, Target, type LucideIcon } from 'lucide-react'
import { baseNames } from '@/lib/model'
import type { DashboardData, Goal, Trend } from '@/lib/model'
import { brl, compactBrl, dateLabel, dayLabel, pct, qty, ratio } from '@/lib/format'
import { Chart, gridLine, labelText, palette, tooltip } from './charts'

export type Inspect = (kind:string,status?:'all'|'pending'|'visited')=>void
export const line = (d:DashboardData,kind:string) => d.lines.find(l=>l.kind===kind) ?? {kind,count:0,amount:0,coverage:0,excess:0,missing:0}
export const goalTotal = (d:DashboardData) => ({
  target:d.goals.reduce((n,g)=>n+g.target,0),actual:line(d,'goal_sale').amount,pending:line(d,'goal_pending').count,
})

export function Empty({title,description,icon:Icon=FileSearch}:{title:string;description?:string;icon?:LucideIcon}) {
  return <div className="empty"><span><Icon size={20}/></span><strong>{title}</strong>{description&&<p>{description}</p>}</div>
}

export function Card({title,description,children,action,className=''}:{title:string;description?:string;children:ReactNode;action?:ReactNode;className?:string}) {
  return <section className={'card '+className}>
    <div className="card-heading"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{action}</div>
    {children}
  </section>
}
export function TextAction({onClick,children}:{onClick:()=>void;children:ReactNode}) {
  return <button className="text-action" onClick={onClick}>{children}<ArrowRight size={15}/></button>
}
export function Kpi({label,value,description,icon:Icon,tone='blue',badge,onClick}:{
  label:string;value:string;description:string;icon:LucideIcon;tone?:string;badge?:string;onClick?:()=>void
}) {
  const Tag=onClick?'button':'div'
  return <Tag className={'kpi '+tone} onClick={onClick}>
    <div className="kpi-top"><span className="kpi-icon"><Icon size={19}/></span>
      {onClick&&<ArrowUpRight size={16} className="kpi-arrow"/>}</div>
    <span className="kpi-label">{label}</span>
    <strong>{value}</strong>
    <span className="kpi-description">{description}</span>
    {badge&&<span className="status-badge amber">{badge}</span>}
  </Tag>
}

export function OverviewKpis({data:d,inspect}:{data:DashboardData;inspect:Inspect}) {
  const g=goalTotal(d),expense=line(d,'expense')
  const net=d.base.contracts.start!=null&&d.base.contracts.end!=null?d.base.contracts.end-d.base.contracts.start:null
  return <div className="kpis">
    <Kpi label="Ativado × meta" value={d.state.goal?pct(ratio(g.actual,g.target)):'—'} description={d.state.goal?brl(g.actual)+' de '+brl(g.target):'Aguardando dados de vendas'} icon={Target}
      badge={g.pending?'Parcial · '+qty(g.pending):undefined} onClick={()=>inspect(g.actual?'goal_sale':'goal_pending')}/>
    <Kpi label="Saldo líquido da base" value={net==null?qty(d.base.contracts.end):(net>0?'+':'')+qty(net)}
      description={net==null?'Contratos ativos · abertura pendente':qty(d.base.contracts.end)+' contratos ativos no período'} icon={BriefcaseBusiness} tone="teal" onClick={()=>inspect('active_contract')}/>
    <Kpi label="Visitas à carteira" value={d.state.visits?pct(ratio(d.coverage.visited,d.coverage.active)):'—'}
      description={d.state.visits?qty(d.coverage.visited)+' atividades para '+qty(d.coverage.active)+' contratos ativos':'Aguardando atividades'} icon={MapPinCheck} tone="violet" onClick={()=>inspect('visit_task')}/>
    <Kpi label="Despesas em campo" value={d.state.expenses?brl(expense.amount):'—'} description={d.state.expenses?qty(expense.count)+' lançamentos no período':'Aguardando Life Tracker'}
      icon={ReceiptText} tone="amber" onClick={()=>inspect('expense')}/>
  </div>
}

const shortName=(name:string)=>{const w=name.split(' ');return w.length>2?w[0]+' '+w.at(-1):name}
export function GoalsChart({goals,onSeller,onDetails}:{goals:Goal[];onSeller:(id:string)=>void;onDetails:()=>void}) {
  const visible=goals.slice(0,6).reverse()
  const option={
    grid:{left:112,right:24,top:9,bottom:31},
    tooltip:{...tooltip,trigger:'axis',axisPointer:{type:'shadow'}},
    xAxis:{type:'value',axisLabel:{...labelText,formatter:(n:number)=>n===0?'0':compactBrl(n)},splitLine:gridLine},
    yAxis:{type:'category',data:visible.map(g=>shortName(g.name)),axisLine:{show:false},axisTick:{show:false},axisLabel:labelText},
    series:[
      {name:'Meta',type:'bar',barWidth:15,itemStyle:{color:'#e7edfa',borderRadius:[0,5,5,0]},data:visible.map(g=>g.target)},
      {name:'Realizado',type:'bar',barWidth:15,barGap:'-100%',itemStyle:{color:'#2164ed',borderRadius:[0,5,5,0]},data:visible.map(g=>g.actual)},
    ],
  }
  return <Card title="Ativado × meta por vendedor" description="Vendas pela competência de ativação"
    action={<TextAction onClick={onDetails}>Ver análise</TextAction>}>
    {visible.length?<><div className="chart-legend"><span><i style={{background:'#2164ed'}}/>Realizado validado</span><span><i style={{background:'#e7edfa'}}/>Meta</span></div>
      <Chart height={226} option={option} label="Gráfico de barras de realizado e meta por vendedor" onClick={e=>{const g=visible[e.dataIndex];if(g)onSeller(g.seller_key)}}/>
      {goals.length>6&&<div className="card-foot">{visible.length} vendedores de {goals.length} · ordenado pelo realizado</div>}</>:
      <Empty title="Aguardando a primeira carga" description="As metas individuais aparecem após a primeira importação." icon={Target}/>}
  </Card>
}

export function VisitsCard({data:d,inspect}:{data:DashboardData;inspect:Inspect}) {
  const c=d.coverage, rate=ratio(c.visited,c.active)
  const option={
    tooltip:{...tooltip,trigger:'item'},
    series:[{type:'pie',radius:['70%','88%'],center:['50%','49%'],label:{show:false},
      itemStyle:{borderWidth:2,borderColor:'#fff',borderRadius:4},data:[
        {name:'Visitados',value:c.visited,itemStyle:{color:'#2563eb'}},{name:'Pendentes',value:c.pending,itemStyle:{color:'#e8effb'}},
      ]}],
    graphic:{type:'text',left:'center',top:'middle',style:{text:pct(rate),fill:'#152846',font:'800 29px Manrope Variable, sans-serif',textAlign:'center'}},
  }
  return <Card title="Cobertura de atividades" description="Uma atividade por contrato ativo na competência"
    action={<button className="icon-button subtle" aria-label="Abrir atividades" onClick={()=>inspect('visit_task')}><ArrowUpRight size={18}/></button>}>
    {d.state.visits&&c.active?<><Chart height={153} option={option} label={'Cobertura de atividades '+pct(rate)} onClick={()=>inspect('visit_task')}/>
      <div className="visit-breakdown">
        <button onClick={()=>inspect('visit_task')}><span><i className="dot blue"/>Atividades registradas</span><strong>{qty(c.visited)}</strong></button>
        <div><span><i className="dot pale"/>Atividades restantes</span><strong>{qty(c.pending)}</strong></div>
      </div>
    </>:<Empty title={d.state.visits?'Sem contratos ativos identificados':'Aguardando atividades'} description="Toda atividade registrada conta, sem filtro de assunto ou status." icon={MapPinCheck}/>}
    {d.state.visits&&c.active>0&&<div className="card-foot"><Clock3 size={14}/>{qty(c.active)} contratos ativos · cobertura {pct(rate)}</div>}
  </Card>
}

const baseTypes=[['contracts','Contratos'],['clients','Clientes'],['mrr','Receita recorrente']] as const
export function BaseCard({data:d,inspect}:{data:DashboardData;inspect:Inspect}) {
  const [mode,setMode]=useState<typeof baseTypes[number][0]>('contracts')
  const b=d.base[mode],change=b.start!=null&&b.end!=null?b.end-b.start:null
  const money=mode==='mrr',format=money?brl:qty
  const option={
    grid:{left:money?88:46,right:22,top:14,bottom:32},
    tooltip:{...tooltip,trigger:'item',formatter:(v:{name:string;value:number})=>v.name+'  '+format(v.value)},
    xAxis:{type:'category',data:['Abertura','Entradas','Saídas','Posição final'],axisTick:{show:false},axisLine:{show:false},axisLabel:labelText},
    yAxis:{type:'value',axisLabel:{...labelText,formatter:(v:number)=>money?compactBrl(v):qty(v)},splitLine:gridLine},
    series:[
      {type:'bar',stack:'base',silent:true,itemStyle:{color:'transparent'},tooltip:{show:false},data:[0,b.start,b.end,0]},
      {type:'bar',stack:'base',barMaxWidth:46,itemStyle:{borderRadius:[5,5,0,0]},data:[
        {value:b.start,itemStyle:{color:'#7494d6'}},{value:b.entries,itemStyle:{color:'#20a888'}},
        {value:b.exits,itemStyle:{color:'#e3a15f'}},{value:b.end,itemStyle:{color:'#2164ed'}},
      ]},
    ],
  }
  return <Card title="Movimentação da base" description="Abertura, entradas, saídas e posição do período"
    action={<TextAction onClick={()=>inspect(mode==='mrr'?'mrr':mode==='clients'?'active_client':'active_contract')}>Ver base</TextAction>}>
    <div className="base-totals">
      {baseTypes.map(([key,label])=><button key={key} aria-pressed={mode===key} className={mode===key?'selected':''} onClick={()=>setMode(key)}>
        <span>{label==='Receita recorrente'?'Receita recorrente estimada':label+' ativos'}</span>
        <strong>{key==='mrr'?brl(d.base[key].end):qty(d.base[key].end)}</strong>
      </button>)}
    </div>
    {b.start!=null&&b.end!=null?<Chart height={199} option={option} label={'Gráfico de cascata da base em '+mode}
      onClick={e=>inspect(mode==='mrr'?'mrr':(['opening_contract','activation','cancellation','active_contract'][e.dataIndex]||'active_contract'))}/>
      :b.end==null?<Empty title="Aguardando posição da carteira" icon={BriefcaseBusiness}/>
      :<div className="base-missing"><strong>{format(b.end)}</strong><span>Posição da carteira</span><small>Abertura indisponível para esta competência.</small></div>}
    <div className="card-foot">{money?'Valores recorrentes estimados':mode==='clients'?qty(d.base.unresolved)+' contratos sem vínculo de cliente confirmado':
      d.state.contract_as_of?'Posição de '+dateLabel(d.state.contract_as_of):'Contratos ativos no IXC'}{change!=null&&<span className="foot-emphasis">Saldo {change>0?'+':''}{format(change)}</span>}</div>
  </Card>
}

export function ExpensesCard({data:d,inspect}:{data:DashboardData;inspect:Inspect}) {
  const summary=line(d,'expense'),cats=d.expenses
  return <Card title="Despesas em campo" description="Distribuição por categoria" action={<TextAction onClick={()=>inspect('expense')}>Ver lançamentos</TextAction>}>
    {cats.length?<div className="expense-breakdown">
      {cats.map((cat,i)=><div className="expense-category" key={cat.name}>
        <div><span><i className="dot" style={{background:palette[i%palette.length]}}/>{cat.name}</span><strong>{brl(cat.amount)}</strong></div>
        <div className="micro-track"><span style={{width:Math.max(0,Math.min(100,ratio(cat.amount,summary.amount)||0))+'%',background:palette[i%palette.length]}}/></div>
      </div>)}
    </div>:<Empty title={d.state.expenses?'Sem despesas no período':'Aguardando despesas'} icon={ReceiptText}/>}
    {d.state.expenses&&<div className="card-foot"><span>Excedente apurado</span><strong className="foot-emphasis">{brl(summary.excess)}</strong></div>}
  </Card>
}

export function BandwidthCard({data:d,inspect}:{data:DashboardData;inspect:Inspect}) {
  const [mode,setMode]=useState<'trend'|'opportunities'>('trend')
  const threshold=d.state.threshold??80,opps=d.bandwidth.circuits.filter(c=>c.peak>=threshold)
  return <Card title="Uso de banda" description="Consumo da carteira e oportunidades de upgrade" action={<TextAction onClick={()=>inspect('band')}>Ver medições</TextAction>}>
    <div className="segmented"><button onClick={()=>setMode('trend')} className={mode==='trend'?'selected':''}>Evolução do consumo</button>
      <button onClick={()=>setMode('opportunities')} className={mode==='opportunities'?'selected':''}>Oportunidades</button></div>
    {!d.state.band?<Empty title="Aguardando dados de banda" description="A primeira exportação libera a evolução e a análise de capacidade." icon={RadioTower}/>
      :mode==='trend'?<SeriesChart values={d.bandwidth.trend} label="Utilização média da capacidade" unit="percent"/>
      :opps.length?<div className="table-scroll"><table className="data-table"><thead><tr><th>Cliente / circuito</th><th>Última leitura</th><th>Pico no mês</th><th>Capacidade</th></tr></thead>
        <tbody>{opps.map(c=><tr key={c.base_code+':'+c.circuit}><td><strong>{c.label}</strong><small>{c.circuit} · {baseNames[c.base_code]}</small></td><td>{pct(c.last)}</td>
          <td><span className="status-badge amber">{pct(c.peak)}</span></td><td>{qty(c.capacity)} Mbps</td></tr>)}</tbody></table></div>
      :<Empty title="Sem circuitos acima do limite" description={'Oportunidades aparecem a partir de '+pct(threshold)+' de utilização.'} icon={RadioTower}/>}
    <div className="card-foot">Limite de oportunidade de {pct(threshold)}</div>
  </Card>
}

export function SeriesChart({values,label,unit='money'}:{values:Trend[];label:string;unit?:'money'|'percent'}) {
  if(!values.length) return <Empty title="Sem registros no período" icon={ChartNoAxesCombined}/>
  const form=unit==='money'?compactBrl:pct
  const option={
    grid:{left:65,right:24,top:16,bottom:35},
    tooltip:{...tooltip,trigger:'axis',valueFormatter:(v:number)=>unit==='money'?brl(v):pct(v)},
    xAxis:{type:'category',boundaryGap:false,data:values.map(i=>dayLabel(i.day)),axisTick:{show:false},axisLine:{show:false},axisLabel:labelText},
    yAxis:{type:'value',axisLabel:{...labelText,formatter:form},splitLine:gridLine},
    series:[{type:'line',name:label,data:values.map(i=>i.value),showSymbol:true,symbolSize:7,smooth:0.18,
      lineStyle:{width:3,color:'#1763f6'},itemStyle:{color:'#1763f6'},areaStyle:{color:'#edf4ff'}}],
  }
  return <Chart height={220} option={option} label={label}/>
}

export function MovementList({data:d,inspect}:{data:DashboardData;inspect:Inspect}) {
  const movements=[
    ['activation','Ativações',true],['upgrade','Upgrades',true],['downgrade','Downgrades',false],
    ['cancellation','Cancelamentos',false],['reversal','Reversões',true],
  ] as const
  return <Card title="Movimentos de contrato" description="Registros do período selecionado">
    <div className="movement-list">{movements.map(([key,label,positive])=><button key={key} onClick={()=>inspect(key)}>
      <span className={'movement-icon '+(positive?'positive':'negative')}>{positive?<ArrowUpRight size={16}/>:<ArrowDownLeft size={16}/>}</span>
      <span>{label}</span><strong>{key==='reversal'&&!d.state.reversal||(['upgrade','downgrade'].includes(key)&&!d.state.changes)?'—':qty(line(d,key).count)}</strong>
      <small>{key==='reversal'&&!d.state.reversal?'Aguardando configuração':key==='upgrade'||key==='downgrade'?d.state.changes?brl(line(d,key).amount):'Aguardando alterações':'Contratos'}</small>
    </button>)}</div>
  </Card>
}

