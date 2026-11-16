import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { viewer } from './auth'

export function json<T>(data: T, status=200) {
  return NextResponse.json(data,{ status, headers:{'Cache-Control':'private, no-store'} })
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export async function session(admin = false) {
  const current = await viewer()
  if (!current) throw new HttpError(401,'Entre para consultar o painel.')
  if (admin && current.role !== 'admin') throw new HttpError(403,'Acesso exclusivo da Administração.')
  return current
}
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin')
  if (!origin) return
  if (req.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403,'Origem da solicitação inválida.')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host
  if (process.env.APP_ORIGIN ? origin !== process.env.APP_ORIGIN : new URL(origin).host !== host) {
    throw new HttpError(403,'Origem da solicitação inválida.')
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ error:error.message },error.status)
  if (error instanceof ZodError) return json({ error:error.issues[0]?.message || 'Dados inválidos.' },400)
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === '42501') return json({ error:'Acesso insuficiente.' },403)
    if (error.code === 'P0001' && 'message' in error) return json({ error:String(error.message) },400)
    if (error.code === '23503') return json({ error:'O registro vinculado não está cadastrado.' },400)
  }
  console.error(error instanceof Error ? error.message : 'Falha desconhecida')
  return json({ error:'Não foi possível concluir a operação. Tente novamente.' },500)
}

