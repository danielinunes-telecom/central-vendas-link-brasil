import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

await mkdir('.local',{recursive:true})
const scratch=await mkdtemp(path.resolve('.local')+'/http-test-')
const launch=spawn(process.execPath,['scripts/demo.mjs','--port','4176'],{
  stdio:'inherit',env:{...process.env,LOCAL_DB_DIR:path.join(scratch,'pg'),LOCAL_DB_PORT:'55438',
    IMPORT_LOCAL_PATH:path.join(scratch,'files'),LB_NEXT_OUTPUT:'.next-http'},
})
const origin='http://127.0.0.1:4176'
const get=async(route,cookie,options={})=>fetch(origin+route,{...options,headers:{...options.headers,...(cookie?{cookie}:{})}})
async function login(profile){
  const response=await get('/api/auth/login',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile})})
  assert.equal(response.status,200,await response.text())
  return response.headers.get('set-cookie').split(';')[0]
}
async function data(route,cookie) {
  const response=await get(route,cookie)
  const body=await response.json()
  assert(response.ok,JSON.stringify(body))
  return body
}
async function waitForImport(cookie,id) {
  for(let attempt=0;attempt<20;attempt++){
    const batches=(await data('/api/admin/imports',cookie)).batches
    const batch=batches.find(row=>row.id===id)
    if(batch&&!['queued','processing'].includes(batch.status))return batch
    await new Promise(resolve=>setTimeout(resolve,500))
  }
  throw new Error('A importação de teste não terminou.')
}
async function uploadReports(cookie,files,base) {
  const form=new FormData()
  form.append('observed','2026-11-13')
  if(base)form.append('base',base)
  for(const [name,file] of files)form.append('files',new Blob([file]),name)
  const response=await get('/api/admin/imports',cookie,{method:'POST',body:form})
  const body=await response.json()
  assert.equal(response.status,202,JSON.stringify(body))
  return waitForImport(cookie,body.id)
}
const upload=(cookie,file,name)=>uploadReports(cookie,[[name,file]])
function report(headers,records) {
  const table=[headers.split('|'),...records].map((cells,i)=>{
    const tag=i?'td':'th'
    return '<tr>'+cells.map(cell=>'<'+tag+'>'+cell+'</'+tag+'>').join('')+'</tr>'
  }).join('')
  return '<html><table>'+table+'</table></html>'
}
function portfolioReports(company,sharedId) {
  return [
    ['Clientes.xls',report('ID|Razão social|CNPJ/CPF|Responsável|Data cadastro|Ativo',[
      [811,company,'','cayo','01/11/2026','Sim'],
      [sharedId,'Cliente nas duas bases','529.982.247-25','cayo','01/11/2026','Sim'],
    ])],
    ['Contratos.xls',report('ID|Cliente|ID Cliente|Status contrato|Data ativação|Plano de venda',[
      [1005,company,811,'Ativo','01/11/2026',1],
      [1006,'Cliente nas duas bases',sharedId,'Ativo','01/11/2026',1],
    ])],
  ]
}
try{
  let ready=false
  for(let i=0;i<100;i++){
    try{if((await get('/api/health')).ok){ready=true;break}}catch{}
    if(launch.exitCode!==null)break
    await new Promise(resolve=>setTimeout(resolve,400))
  }
  assert(ready,'A demonstração não iniciou.')
  assert.equal((await get('/api/dashboard')).status,401)
  const admin=await login('admin'),manager=await login('manager'),seller=await login('seller')
  const whole=await data('/api/dashboard?month=2026-11',admin)
  assert.equal(whole.base.contracts.end,81)
  assert.equal(whole.base.contracts.start,72)
  assert.equal(whole.goals.length,19)
  assert(whole.lines.find(row=>row.kind==='goal_sale').amount>0)
  assert.equal(whole.lines.find(row=>row.kind==='goal_sale').count,12)
  const fullSales=await data('/api/records?month=2026-11&kind=goal_sale',admin)
  assert(fullSales.rows.length>0)
  for(const row of fullSales.rows){
    assert.equal(Number(row.amount),Number(row.details.gross),'Cada venda deve contar pelo valor integral')
    assert.equal(Number(row.details.rate),1)
  }
  const firstSale=fullSales.rows[0]
  const review=await get('/api/admin/settings',admin,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    key:'sale_review',value:{contract:firstSale.details.contract,seller:firstSale.seller_key,note:'Teste de produto sem percentual cadastrado',items:[{product:'PLANO SEM MAPEAMENTO',total:3000}]},
  })})
  assert.equal(review.status,200,await review.text())
  const unweighted=await data('/api/records?month=2026-11&kind=goal_sale',admin)
  const verified=unweighted.rows.filter(row=>row.details.contract===firstSale.details.contract)
  assert.equal(verified.length,1)
  assert.equal(Number(verified[0].amount),3000,'Plano desconhecido deve contar R$ 3.000 integralmente')
  const cleared=await get('/api/admin/settings',admin,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'clear_sale_review',value:{contract:firstSale.details.contract}})})
  assert.equal(cleared.status,200)

  assert.equal(whole.lines.find(row=>row.kind==='reversal').count,2)
  assert.equal(whole.bandwidth.circuits.length,42)
  assert.equal(whole.coverage.active,81)
  assert.equal((await data('/api/dashboard?month=2026-11',manager)).base.contracts.end,81)
  assert.equal((await get('/api/admin/imports',manager)).status,403)
  assert.equal((await get('/api/admin/settings',seller,{method:'POST'})).status,403)
  const own=await data('/api/dashboard?month=2026-11&seller=thiago',seller)
  assert.deepEqual(own.goals.map(row=>row.seller_key),['cayo'])
  const detail=await data('/api/records?month=2026-11&seller=thiago&kind=active_contract',seller)
  assert(detail.rows.length>0 && detail.rows.every(row=>row.seller_key==='cayo'))
  const debt=await data('/api/records?month=2026-11&kind=debt&q=9000',admin)
  assert.equal(debt.total,1)
  assert.equal(debt.rows[0].details.title,'9000')
  assert.equal(debt.rows[0].occurred_on,'2026-08-10')
  const debtCsv=await get('/api/records?month=2026-11&kind=debt&q=9000&format=csv',admin)
  assert.equal(debtCsv.status,200)
  assert.match(await debtCsv.text(), /"ID do título";"Nº da parcela";"Cliente";"Base";"Vencimento"/)
  const changes=await data('/api/records?month=2026-11&kind=upgrade&q=3001',admin)
  assert.equal(changes.total,1)
  assert.equal(changes.rows[0].details.contract,'1001')
  const clients=await data('/api/records?month=2026-11&kind=active_client',admin)
  assert.equal(clients.total,81)
  const moved=await data('/api/records?month=2026-11&kind=visit_coverage&q=Rumo',admin)
  assert(moved.rows.some(row=>row.details.client==='1004'&&row.seller_key==='thiago'&&row.amount===1))
  const csv=await get('/api/records?month=2026-11&kind=active_contract&format=csv',seller)
  assert.equal(csv.status,200)
  assert((await csv.text()).includes('Caio Reis'))
  const csvForbidden=await get('/api/admin/settings',admin,{method:'POST',headers:{Origin:'https://outside.invalid'},body:'{}'})
  assert.equal(csvForbidden.status,403)
  const settings=await data('/api/admin/settings',admin)
  assert.equal(settings.sellers.length,19)
  const save=await get('/api/admin/settings',admin,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:'target',value:{seller:'cayo',month:'2026-11-01',amount:12345}})})
  assert.equal(save.status,200,await save.text())
  assert.equal((await data('/api/dashboard?month=2026-11',seller)).goals[0].target,12345)
  const before=whole.lines.find(row=>row.kind==='expense').count
  const exported='<html><table><tr><th>ID</th><th>Nome</th><th>Centro de Custo</th><th>Data</th><th>Equipamento</th><th>Valor</th></tr>'+
    '<tr><td>99999</td><td>cayo</td><td>Almoço</td><td>13/11/2026</td><td></td><td>42,90</td></tr></table></html>'
  const batch=await upload(admin,exported,'Despesas.xls')
  assert.equal(batch.status,'complete',JSON.stringify(batch))
  const added=(await data('/api/dashboard?month=2026-11',admin)).lines.find(row=>row.kind==='expense')
  assert.equal(added.count,1)
  assert.equal(added.excess,2.9)
  assert(before>1)
  const replay=await upload(admin,exported,'Despesas.xls')
  assert.equal(replay.files[0].status,'unchanged')
  assert.equal((await data('/api/dashboard?month=2026-11',admin)).lines.find(row=>row.kind==='expense').count,1)
  const failure=await upload(admin,'<html><table><tr><td>Desconhecido</td></tr></table></html>','Invalido.xls')
  assert.equal(failure.status,'failed')
  assert.equal((await data('/api/dashboard?month=2026-11',admin)).base.contracts.end,81)
  const oldBatch=await uploadReports(admin,portfolioReports('Cliente da Base Velha',812),'old')
  assert.equal(oldBatch.status,'complete',JSON.stringify(oldBatch))
  const newBatch=await uploadReports(admin,portfolioReports('Cliente da Base Nova',813),'new')
  assert.equal(newBatch.status,'complete',JSON.stringify(newBatch))
  const consolidated=await data('/api/dashboard?month=2026-11',admin)
  assert.equal(consolidated.base.contracts.end,4)
  assert.equal(consolidated.base.clients.end,3)
  assert.equal(consolidated.goals.length,19)
  assert.equal(consolidated.goals.find(g=>g.seller_key==='cayo').target,12345)
  const duplicatedIds=await data('/api/records?month=2026-11&kind=active_contract&q=1005',admin)
  assert.deepEqual(duplicatedIds.rows.map(row=>row.base_code).sort(),['new','old'])
  assert(duplicatedIds.rows.every(row=>row.details.contract==='1005'&&!('identity' in row.details)))
  const oldScope=await data('/api/dashboard?month=2026-11&base=old',admin)
  assert.equal(oldScope.base.clients.end,2)
  assert.equal((await data('/api/dashboard?month=2026-11&base=legacy',admin)).base.contracts.end,81)
  const oldRepeat=await uploadReports(admin,portfolioReports('Cliente da Base Velha',812),'old')
  assert(oldRepeat.files.every(file=>file.status==='unchanged'))
  assert.equal((await data('/api/dashboard?month=2026-11',admin)).base.contracts.end,4)
  const lead=report('ID|Lead viável|Responsável|Data cadastro|ID Prospecção|ID Cliente',[
    [1,'Sim','cayo','05/11/2026',1,811],
  ])
  const wrongBase=await uploadReports(admin,[['Leads.xls',lead]],'old')
  assert.equal(wrongBase.status,'failed')
  assert.match(wrongBase.files[0].error,/Base Nova/)
  const rightBase=await uploadReports(admin,[['Leads.xls',lead]],'new')
  assert.equal(rightBase.status,'complete')
  const leads=await data('/api/records?month=2026-11&kind=lead_new',admin)
  assert.deepEqual(leads.rows.map(row=>row.base_code),['new'])
  const octoberContracts=report('ID|Cliente|ID Cliente|Status contrato|Data ativação|Plano de venda',[
    [1005,'Cliente da Base Velha',811,'Ativo','01/09/2026',1],
    [1006,'Cliente nas duas bases',812,'Ativo','01/09/2026',1],
  ])
  await uploadReports(admin,[['Contratos.xls',octoberContracts]],'old')
  const activity=report('ID|Tipo|Assunto|Responsável|Status|Data/Hora início|Data|Cliente',[
    [777,'Atividade','VISITA AO CLIENTE','cayo','Agendada','20/10/2026','10/11/2026',811],
    [778,'Tarefa','VISITAS','cayo','Cancelada','21/10/2026','10/11/2026',811],
    [779,'Atividade','TELEFONEMA','cayo','Concluída','21/10/2026','10/11/2026',812],
  ])
  const relationships=report('ID|Funil|Estágio|Data vencemos|Contato|Cliente|Tipo|Responsável|Data início|Status',[
    [777,'Comercial','Atendimento','','Contato',812,'RELACIONAMENTO','cayo','22/10/2026','Perdemos'],
    [778,'Comercial','Atendimento','','Contato',811,'RELACIONAMENTO','cayo','23/10/2026','Em andamento'],
    [779,'Comercial','Atendimento','','Contato',812,'VENDA','cayo','23/10/2026','Ganhamos'],
  ])
  const visitsBatch=await uploadReports(admin,[['Atividades.xls',activity],['Negociacoes.xls',relationships]],'new')
  assert.equal(visitsBatch.status,'complete',JSON.stringify(visitsBatch))
  const october=await data('/api/dashboard?month=2026-10&base=old',admin)
  assert.equal(october.filters.month,'2026-10')
  assert.equal(october.coverage.visited,2)
  assert.equal(october.coverage.active,2)
  assert.equal(october.goals.length,19)
  assert.equal(october.goals.find(g=>g.seller_key==='adriano').target,10000)
  const visitRows=await data('/api/records?month=2026-10&base=old&kind=visit_task',admin)
  assert.equal(visitRows.total,4)
  assert.equal(visitRows.rows.filter(row=>row.details.task==='777'||row.details.deal==='777').length,2)
  assert(visitRows.rows.every(row=>row.base_code==='old'&&row.details.source_base==='new'))
  assert(visitRows.rows.some(row=>row.label==='Cliente da Base Velha'&&row.details.task==='777'))
  assert.equal((await data('/api/dashboard?month=2026-10&base=new',admin)).coverage.visited,0)
  assert.equal((await data('/api/records?month=2026-11&base=old&kind=visit_task',admin)).total,0)
  console.log('OK: filtros, autorização, meta, visitas, CSV, alteração administrativa, carga e reenvio.')
}finally{
  if(launch.exitCode===null){
    const exited=once(launch,'exit')
    launch.kill('SIGTERM')
    await exited
  }
  await rm(scratch,{recursive:true,force:true})
}

