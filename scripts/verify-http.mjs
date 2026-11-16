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
async function upload(cookie,file,name) {
  const form=new FormData()
  form.append('observed','2026-11-13')
  form.append('files',new Blob([file]),name)
  const response=await get('/api/admin/imports',cookie,{method:'POST',body:form})
  const body=await response.json()
  assert.equal(response.status,202,JSON.stringify(body))
  return waitForImport(cookie,body.id)
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
  console.log('OK: filtros, autorização, meta, visitas, CSV, alteração administrativa, carga e reenvio.')
}finally{
  if(launch.exitCode===null){
    const exited=once(launch,'exit')
    launch.kill('SIGTERM')
    await exited
  }
  await rm(scratch,{recursive:true,force:true})
}

