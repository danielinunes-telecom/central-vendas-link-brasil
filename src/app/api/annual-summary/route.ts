import { annualSummary, saveJustification } from '@/server/annual-summary'
import { errorResponse,json,session } from '@/server/http'
export const dynamic='force-dynamic'
export async function GET(req:Request){try{const current=await session();return json(await annualSummary(current,new URL(req.url).searchParams))}catch(e){return errorResponse(e)}}
export async function POST(req:Request){try{const current=await session();return json(await saveJustification(current,await req.json()))}catch(e){return errorResponse(e)}}
