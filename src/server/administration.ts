import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { AdminData, ImportBatch, SourceStatus, Viewer } from '@/lib/model'
import { localDay } from '@/lib/format'
import { asUser } from './db'
import { demoMode } from './auth'
import { HttpError } from './http'

export const maxFileBytes = 25 * 1024 * 1024
export const maxBatchBytes = 100 * 1024 * 1024
const extension = /^\.(xlsx|xls|pdf)$/i
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/).refine(v=>v>='2026-10-01')
const text = z.string().trim().min(1).max(160)
const entry = z.object({ product:text,total:z.number().nonnegative().max(999_999_999) })
const jsonMap = z.record(z.string().min(1).max(180),text).refine(o=>Object.keys(o).length<=10000)

const updates = z.discriminatedUnion('key',[
  z.object({ key:z.literal('target'), value:z.object({seller:text,month,amount:z.number().nonnegative().max(999_999_999)}) }),
  z.object({ key:z.literal('rate'), value:z.object({product:text,month,rate:z.number().min(0).max(1)}) }),
  z.object({ key:z.literal('sale_review'), value:z.object({contract:text,seller:text,note:z.string().trim().min(4).max(500),items:z.array(entry).min(1).max(100)}) }),
  z.object({ key:z.literal('clear_sale_review'),value:z.object({contract:text}) }),
  z.object({ key:z.literal('account'), value:z.object({
    name:text,email:z.email().max(250),role:z.enum(['admin','manager','seller']),
    active:z.boolean(),seller:text.nullable(),
  }).refine(v=>(v.role==='seller')===!!v.seller,'Selecione o vendedor vinculado ao perfil.') }),
  z.object({ key:z.literal('visit_rules'),value:z.object({visit:z.array(text).min(1).max(50),prospect:z.array(text).max(50)}) }),
  z.object({ key:z.literal('reversal_types'),value:z.array(text).max(100) }),
  z.object({ key:z.literal('sales_doc_types'),value:z.array(text).max(100) }),
  z.object({ key:z.literal('expense_limits'),value:z.object({meal:z.number().min(0).max(10000),lodging:z.number().min(0).max(100000)}) }),
  z.object({ key:z.literal('band_threshold'),value:z.number().min(1).max(100) }),
  z.object({ key:z.enum(['aliases','plan_products','contract_clients','band_links']),value:jsonMap }),
])

export async function importsFor(current:Viewer) {
  return asUser(current.email,async db=>{
    const batches = (await db.query<{data:ImportBatch[]}>('select comercial.import_status() data')).rows[0].data
    const sources = (await db.query<SourceStatus>('select * from comercial.base_source_status()')).rows
    return { batches,sources }
  })
}

export async function settingsFor(current:Viewer) {
  return asUser(current.email,async db=>{
    const result=(await db.query<{data:AdminData|null}>('select comercial.admin_settings() data')).rows[0].data
    if (!result) throw new HttpError(403,'Acesso insuficiente.')
    return result
  })
}

export async function saveSetting(current:Viewer,body:unknown) {
  const update=updates.parse(body)
  if (update.key==='aliases') {
    update.value=Object.fromEntries(Object.entries(update.value).map(([key,val])=>[
      key.normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toUpperCase().replace(/\s+/g,' '),val,
    ]))
  }
  return asUser(current.email,db=>db.query('select comercial.save_setting($1,$2::jsonb)',[update.key,JSON.stringify(update.value)]))
}

function storageClient() {
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVER_KEY
  if (!url || !key) throw new HttpError(503,'O armazenamento privado precisa ser configurado.')
  return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
    .storage.from(process.env.IMPORT_BUCKET||'link-brasil-importacoes')
}

export async function submitFiles(current:Viewer,form:FormData) {
  const files=form.getAll('files').filter((f):f is File=>f instanceof File)
  if (!files.length || files.length>25) throw new HttpError(400,'Selecione até 25 relatórios por envio.')
  if (files.reduce((sum,f)=>sum+f.size,0)>maxBatchBytes) throw new HttpError(413,'O lote ultrapassa 100 MB.')
  if (files.some(f=>!extension.test(path.extname(f.name)) || f.size===0 || f.size>maxFileBytes)) {
    throw new HttpError(400,'Use arquivos .xlsx, .xls ou o PDF de alterações, com até 25 MB por arquivo.')
  }
  const selectedBase=form.get('base')
  if (selectedBase!=='old'&&selectedBase!=='new'&&!(demoMode()&&selectedBase==null)) {
    throw new HttpError(400,'Selecione a Base Velha ou a Base Nova.')
  }
  const observed=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(form.get('observed')||localDay())
  const parsed=new Date(observed+'T12:00:00Z')
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10)!==observed ||
      observed>'9999-12-31' || observed<'2026-10-01' || observed>localDay()) {
    throw new HttpError(400,'Informe uma data de extração válida.')
  }
  const group=randomUUID(), local=demoMode()?process.env.IMPORT_LOCAL_PATH:undefined
  const storage=local?null:storageClient()
  const manifest:{name:string;key:string;bytes:number;sha256:string}[]=[]
  try {
    if (local) await mkdir(path.join(local,group),{recursive:true,mode:0o700})
    for (const file of files) {
      const body=Buffer.from(await file.arrayBuffer())
      const key=group+'/'+randomUUID()+path.extname(file.name).toLowerCase()
      if (local) await writeFile(path.join(local,key),body,{flag:'wx',mode:0o600})
      else {
        const {error}=await storage!.upload(key,body,{contentType:'application/octet-stream',upsert:false})
        if (error) throw new HttpError(502,'Falha ao salvar um dos arquivos. Tente reenviar o lote.')
      }
      manifest.push({name:path.basename(file.name).slice(0,230),key,bytes:file.size,sha256:createHash('sha256').update(body).digest('hex')})
    }
  } catch (error) {
    if (local) await rm(path.join(local,group),{recursive:true,force:true}).catch(()=>{})
    else if (manifest.length) await storage!.remove(manifest.map(f=>f.key)).catch(()=>{})
    throw error
  }
  return asUser(current.email,async db=>{
    const params=[observed,JSON.stringify(manifest),process.env.IMPORT_QUEUE!=='local']
    const result=selectedBase
      ? await db.query<{id:string}>('select comercial.submit_base_import($1,$2::jsonb,$3,$4) id',[...params,selectedBase])
      : await db.query<{id:string}>('select comercial.submit_import($1,$2::jsonb,$3) id',params)
    return result.rows[0].id
  })
}

