if (!process.env.DASHBOARD_DATABASE_URL && !process.env.SUPABASE_URL) {
  await import('./demo.mjs')
} else {
  const { spawn } = await import('node:child_process')
  const args = process.argv.slice(2).filter(arg=>arg!=='--strictPort').map(arg=>arg==='--host'?'--hostname':arg)
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next','dev',...args], { stdio:'inherit' })
  app.on('exit', code=>{ process.exitCode=code||0 })
  process.once('SIGTERM',()=>app.kill('SIGTERM'))
  process.once('SIGINT',()=>app.kill('SIGINT'))
}
