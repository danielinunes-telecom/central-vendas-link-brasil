import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Client } from 'pg'

const root=path.resolve('.local')
await mkdir(root,{recursive:true})
let python=process.env.LB_PYTHON
if(!python) {
  const installed=process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'
  try { await stat(installed); python=path.resolve(installed) } catch { python=process.platform==='win32'?'python':'python3' }
}
const port=Number(process.env.LOCAL_DB_PORT||55435)
const database='postgres://lb_local:lb_local@127.0.0.1:'+port+'/postgres'
const day=process.env.LB_DEMO_DAY||'2026-11-13'
const env={
  ...process.env,
  DATABASE_URL:database,
  DASHBOARD_DATABASE_URL:database,
  LOCAL_DB_DIR:process.env.LOCAL_DB_DIR || path.join(root,'demo-postgres'),
  LOCAL_DB_PORT:String(port),
  IMPORT_QUEUE:'local',
  IMPORT_LOCAL_PATH:process.env.IMPORT_LOCAL_PATH||path.join(root,'demo-originais'),
  LB_DEMO:'1',
  LB_DEMO_DAY:day,
  LB_DEMO_SECRET:randomBytes(48).toString('hex'),
  LB_SECURE_COOKIE:'0',
  NEXT_TELEMETRY_DISABLED:'1',
}
const processes=[]
let ending=false
const launch=(cmd,args)=>{
  const child=spawn(cmd,args,{stdio:'inherit',env})
  processes.push(child)
  return child
}
function finish(code=0) {
  if(ending)return
  ending=true
  process.exitCode=code
  for(const c of processes) if(c.exitCode==null)c.kill('SIGTERM')
}
process.on('SIGINT',()=>finish())
process.on('SIGTERM',()=>finish())
const db=launch(process.execPath,['scripts/local-db.mjs'])
db.once('exit',code=>{if(!ending)finish(code||1)})

async function waitForDb() {
  for(let i=0;i<80&&!ending;i++) {
    const c=new Client({connectionString:database,connectionTimeoutMillis:500})
    try {
      await c.connect()
      if((await c.query("select to_regclass('comercial.metric_rows') as ready")).rows[0].ready)return
    }catch{ /* The demo database is starting. */ }
    finally{await c.end().catch(()=>{})}
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  throw new Error('O banco de demonstração não ficou disponível.')
}
try {
  await waitForDb()
  const seed=launch(python,['-m','worker.demo','--day',day])
  const result=await new Promise((resolve,reject)=>{
    seed.once('error',reject)
    seed.once('exit',resolve)
  })
  if(result!==0)throw new Error('Instale as dependências de worker/requirements.txt para rodar a demonstração.')
  const job=launch(python,['-m','worker.run'])
  job.once('exit',code=>{if(!ending)finish(code||1)})
  job.once('error',error=>{console.error(error.message);finish(1)})
  const args=process.argv.slice(2).filter(arg=>arg!=='--strictPort').map(arg=>arg==='--host'?'--hostname':arg)
  if(!args.includes('--hostname')&&!args.includes('-H'))args.push('--hostname','127.0.0.1')
  const next=launch(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack',...args])
  next.once('exit',code=>finish(code||0))
}catch(error){
  console.error(error.message)
  finish(1)
}

