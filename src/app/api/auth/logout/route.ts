import { signOut } from '@/server/auth'
import { errorResponse, json, sameOrigin } from '@/server/http'
export async function POST(req:Request) {
  try { sameOrigin(req); await signOut(); return json({ok:true}) }
  catch (error) { return errorResponse(error) }
}

