import EmbeddedPostgres from 'embedded-postgres'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'

const data = path.resolve(process.env.LOCAL_DB_DIR || '.local/postgres')
await mkdir(path.dirname(data), { recursive: true })
const port = Number(process.env.LOCAL_DB_PORT || 55432)
const db = new EmbeddedPostgres({
  databaseDir: data, user: 'lb_local', password: 'lb_local', port,
  persistent: true, authMethod: 'scram-sha-256', autoRehydrateSymlinks: true,
  postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='],
  onLog: message => { if (message.includes('FATAL')) console.error(message) },
  onError: console.error,
})
try { await stat(path.join(data, 'PG_VERSION')) } catch { await db.initialise() }
await db.start()
const client = new Client({ connectionString: 'postgres://lb_local:lb_local@127.0.0.1:' + port + '/postgres' })
await client.connect()
try {
  await client.query('create table if not exists public.lb_schema_migrations (name text primary key)')
  for (const file of (await readdir('db')).filter(name => /^\d.*\.sql$/.test(name)).sort()) {
    if ((await client.query('select 1 from public.lb_schema_migrations where name=$1', [file])).rowCount) continue
    await client.query(await readFile(path.join('db', file), 'utf8'))
    await client.query('insert into public.lb_schema_migrations values ($1)', [file])
  }
  await client.query(await readFile('db/demo-accounts.sql','utf8'))
} catch (error) {
  await client.end()
  await db.stop()
  throw error
}
await client.end()
console.log('PostgreSQL local pronto na porta ' + port)
let close
const done = new Promise(resolve => { close = resolve })
process.once('SIGINT', close)
process.once('SIGTERM', close)
await done
await db.stop()

