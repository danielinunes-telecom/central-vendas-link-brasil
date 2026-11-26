import PG from 'embedded-postgres'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const db=new PG({databaseDir:fs.mkdtempSync('/tmp/lb-hist-')+'/pg',port:55573,postgresFlags:['-c','unix_socket_directories='],initdbFlags:['--locale=C','--encoding=UTF8'],persistent:false,onLog:()=>{}})
await db.initialise();await db.start();const c=db.getPgClient()
try {
await c.connect()
for(const f of fs.readdirSync('db').filter(x=>/^0(0[1-9]|1[0-4])_/.test(x)).sort())await c.query(fs.readFileSync('db/'+f,'utf8'))
const owner='ops@example.test'
await c.query("insert into comercial.accounts(email,name,role) values ($1,'Test','admin')",[owner])
for(const base of ['new','old']){
const {rows:[batch]}=await c.query("insert into comercial.import_batches(submitted_by,observed_on,base_code)values($1,'2026-11-17',$2) returning id",[owner,base])
for(const [source,payload,day] of [
 ['contracts',{activated:'2026-02-12',status:'ATIVO',client_key:'17',seller:'Luiz Henrique Fontanetti Roldi',description:'LINK TESTE',total:3000,client:'Cliente'},null],
 ['changes',{contract_key:'1',type:'UPGRADE',difference:400},'2026-03-06'],
 ['titles',{contract_key:'1',paid:'2026-04-03',status:'RECEBIDO',received:234},null],
 ['expenses',{category:'COMBUSTIVEL',total:120},'2026-01-08'],
 ['negotiations',{type:'RELACIONAMENTO',stage:'Contato'},'2026-05-10'],
 ['band',{contract_key:'1',capacity:100,used:12},'2026-07-03']
]){
if(source==='negotiations'&&base==='old')continue
const {rows:[file]}=await c.query("insert into comercial.import_files(batch_id,name,object_key,bytes,sha256,source) values($1,$2,$3,15,repeat('a',64),$2) returning id",[batch.id,source,base+source])
await c.query("insert into comercial.source_loads(base_code,source,file_id,sha256,observed_on,rows_loaded) values($1,$2,$3,repeat('a',64),'2026-11-17',1)",[base,source,file.id])
await c.query("insert into comercial.source_observations(base_code,source,observed_on,file_id,scope_start,scope_end) values($1,$2,'2026-11-17',$3,'2026-01-01','2026-11-17')",[base,source,file.id])
await c.query("insert into comercial.records(base_code,source,external_key,valid_from,event_day,payload,file_id,row_number)values($1,$2,'1','2026-11-17',$3,$4,$5,1)",[base,source,day,payload,file.id])
}}
await c.query(fs.readFileSync('db/015_historico_por_lancamento.sql','utf8'))
const check=async()=>{for(const [kind,month,count] of [['activation',2,2],['upgrade',3,2],['receipt',4,2],['negotiation',5,1],['expense',1,2],['band',7,2]]){
const {rows:[r]}=await c.query("select count(*)::int n from comercial.metric_rows where kind=$1 and extract(month from month)=$2",[kind,month]);assert.equal(r.n,count,kind)
}}
await check();await c.query("select comercial.refresh_all('2026-11-17')");await check()
await c.query("set role lb_dashboard");await c.query("select set_config('app.user_email',$1,false)",[owner])
const api={};new Function('exports','require',ts.transpileModule(fs.readFileSync('src/server/annual-summary.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(api,s=>s==='server-only'?{}:s==='./db'?{asUser:(_e,f)=>f(c)}:require(s))
const annual=await api.annualSummary({email:owner,seller_key:null},new URLSearchParams({year:'2026',seller:'',base:''}))
assert.equal(annual.rows[1].activations,2);assert.equal(annual.rows[2].upgrades,2);assert.equal(annual.rows[3].receipts,468);assert.equal(annual.rows[11].activations,null)
console.log('validated annual counts, monthly event dates, two bases, no future data, repeat refresh')
} finally {await c.end();await db.stop()}

