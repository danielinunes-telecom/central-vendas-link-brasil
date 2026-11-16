import { z } from 'zod'
import { authClient, authConfigured, demoMode, setDemoSession } from '@/server/auth'
import { errorResponse, HttpError, json, sameOrigin } from '@/server/http'
const schema=z.union([
  z.object({ profile:z.enum(['admin','manager','seller']) }),
  z.object({ email:z.email(),password:z.string().min(1).max(250) }),
])
export async function POST(req:Request) {
  try {
    sameOrigin(req)
    const input=schema.parse(await req.json())
    if ('profile' in input) {
      if (!await setDemoSession(input.profile)) throw new HttpError(403,'A demonstração está desativada.')
    } else {
      if (!authConfigured() || demoMode()) throw new HttpError(503,'O login corporativo ainda precisa ser configurado.')
      const auth=await authClient()
      const {error}=await auth.auth.signInWithPassword(input)
      if (error) throw new HttpError(401,'Confira o e-mail e a senha.')
    }
    return json({ok:true})
  } catch (error) { return errorResponse(error) }
}

