import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { asUser } from './db'
import type { Viewer } from '@/lib/model'

export const demoMode = () => process.env.LB_DEMO === '1' && !!process.env.LB_DEMO_SECRET
export const demoAccounts = { admin:'admin@linkbrasil.test', manager:'gestao@linkbrasil.test', seller:'cayo@linkbrasil.test' } as const
export function authConfigured() {
  return demoMode() || Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.DASHBOARD_DATABASE_URL)
}

export async function authClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) throw new Error('Login não configurado.')
  const jar = await cookies()
  return createServerClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: { getAll: () => jar.getAll(), setAll: (items) => {
      try { items.forEach(({name,value,options}) => jar.set(name,value,options)) } catch { /* Server components cannot write cookies. */ }
    } },
  })
}

function signature(value: string) {
  return createHmac('sha256',process.env.LB_DEMO_SECRET || '').update(value).digest('hex')
}

export async function setDemoSession(role: keyof typeof demoAccounts) {
  if (!demoMode()) return false
  const cookie = await cookies()
  const value = demoAccounts[role] + ':' + (Math.floor(Date.now()/1000) + 8*60*60)
  cookie.set('lb_demo',value+':'+signature(value),{
    path:'/', httpOnly:true, sameSite:'lax', secure:process.env.LB_SECURE_COOKIE==='1', maxAge:8*60*60,
  })
  return true
}

export const viewer = cache(async (): Promise<Viewer | null> => {
  if (!authConfigured()) return null
  let email: string | undefined
  if (demoMode()) {
    const cookie = (await cookies()).get('lb_demo')?.value
    if (!cookie) return null
    const [raw, expiry, tag] = cookie.split(':')
    if (!raw || !expiry || !tag || !/^[0-9a-f]{64}$/.test(tag) || Number(expiry) <= Date.now()/1000) return null
    if (!timingSafeEqual(Buffer.from(tag,'hex'), Buffer.from(signature(raw+':'+expiry),'hex'))) return null
    email = raw
  } else {
    const auth = await authClient()
    const { data } = await auth.auth.getUser()
    email = data.user?.email_confirmed_at ? data.user.email?.toLowerCase() : undefined
  }
  if (!email) return null
  return asUser(email, async db => (await db.query<Viewer>('select * from comercial.profile()')).rows[0] ?? null)
})

export async function signOut() {
  if (demoMode()) (await cookies()).delete('lb_demo')
  else if (authConfigured()) await (await authClient()).auth.signOut()
}

