import { authConfigured, demoMode, viewer } from '@/server/auth'
import { dashboard, filtersFrom } from '@/server/dashboard'
import { Login } from '@/components/login'
import { Workspace } from '@/components/workspace'
export const dynamic='force-dynamic'

export default async function Page({ searchParams }:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const profile=await viewer()
  if (!profile) return <Login demo={demoMode()} configured={authConfigured()} />
  const params=new URLSearchParams()
  for (const [key,value] of Object.entries(await searchParams)) if (typeof value==='string') params.set(key,value)
  const initial=await dashboard(profile,filtersFrom(params,profile))
  return <Workspace initial={initial} section={params.get('section')} />
}

