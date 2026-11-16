import 'server-only'
import { Pool, type PoolClient } from 'pg'

let pool: Pool | undefined
export async function asUser<T>(email: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const connectionString = process.env.DASHBOARD_DATABASE_URL || (process.env.LB_DEMO === '1' ? process.env.DATABASE_URL : undefined)
  if (!connectionString) throw new Error('A conexão de consulta não está configurada.')
  if (!pool) {
    pool = new Pool({ connectionString, max:8, connectionTimeoutMillis:8000, idleTimeoutMillis:30_000 })
    pool.on('error',error=>console.error('Conexão ociosa do painel encerrada.',error.message))
  }
  const db = await pool.connect()
  try {
    await db.query('begin')
    await db.query('set local role lb_dashboard')
    await db.query("select set_config('app.user_email', $1, true), set_config('statement_timeout','25000',true)", [email])
    const data = await fn(db)
    await db.query('commit')
    return data
  } catch (error) {
    await db.query('rollback').catch(()=>{})
    throw error
  } finally {
    db.release()
  }
}

