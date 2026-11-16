import { importsFor, maxBatchBytes, submitFiles } from '@/server/administration'
import { errorResponse, HttpError, json, sameOrigin, session } from '@/server/http'
export const dynamic = 'force-dynamic'
export async function GET() {
  try { return json(await importsFor(await session(true))) }
  catch (error) { return errorResponse(error) }
}
export async function POST(req:Request) {
  try {
    const current=await session(true)
    sameOrigin(req)
    if (Number(req.headers.get('content-length')) > maxBatchBytes + 65536) throw new HttpError(413,'O lote ultrapassa 100 MB.')
    return json({id:await submitFiles(current,await req.formData())},202)
  } catch (error) { return errorResponse(error) }
}

