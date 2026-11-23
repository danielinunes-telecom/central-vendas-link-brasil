import { saveCorrection,settingsFor } from '@/server/administration'
import { errorResponse,json,sameOrigin,session } from '@/server/http'
export const dynamic='force-dynamic'
export async function GET(){try{return json(await settingsFor(await session(true)))}catch(e){return errorResponse(e)}}
export async function POST(req:Request){try{const current=await session(true);sameOrigin(req);await saveCorrection(current,await req.json());return json({ok:true})}catch(e){return errorResponse(e)}}
