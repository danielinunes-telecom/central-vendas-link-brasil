import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
export async function proxy(req:NextRequest) {
  const url=process.env.SUPABASE_URL, key=process.env.SUPABASE_PUBLISHABLE_KEY
  let response=NextResponse.next({request:req})
  if (!url || !key || process.env.LB_DEMO==='1' || !req.cookies.getAll().some(c=>c.name.startsWith('sb-'))) return response
  const auth=createServerClient(url,key,{
    cookies:{
      getAll:()=>req.cookies.getAll(),
      setAll:(updates)=>{
        updates.forEach(({name,value})=>req.cookies.set(name,value))
        response=NextResponse.next({request:req})
        updates.forEach(({name,value,options})=>response.cookies.set(name,value,options))
      },
    },
  })
  await auth.auth.getClaims()
  return response
}
export const config={matcher:['/((?!api/admin/imports|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|woff2|webp)$).*)']}

