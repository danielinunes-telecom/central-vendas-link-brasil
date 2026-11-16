import { dashboard, filtersFrom } from '@/server/dashboard'
import { errorResponse, json, session } from '@/server/http'
export const dynamic = 'force-dynamic'
export async function GET(req:Request) {
  try {
    const current=await session()
    return json(await dashboard(current,filtersFrom(new URL(req.url).searchParams,current)))
  } catch (error) { return errorResponse(error) }
}

