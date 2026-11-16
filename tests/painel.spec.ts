import { test, expect, type Page } from '@playwright/test'

async function signIn(page:Page,role:string) {
  await page.goto('/')
  await page.getByRole('button',{name:role,exact:true}).click()
  await expect(page.getByRole('heading',{name:'Visão geral',exact:true})).toBeVisible()
}
test('gestor consulta gráficos, filtra vendedor e abre os registros',async({page})=>{
  await signIn(page,'Gestor')
  await expect(page.getByRole('button',{name:'Administração',exact:true})).toHaveCount(0)
  await expect(page.getByRole('img',{name:/Gráfico de barras/})).toBeVisible()
  const topline=page.getByRole('button',{name:/Ativado × meta/}).first()
  await expect(topline).not.toContainText('R$ 0,00 de')
  await page.getByLabel('Vendedor',{exact:true}).selectOption('cayo')
  await expect(topline).toContainText('10.000,00')
  await page.getByRole('button',{name:/Abrir registros de visitas/}).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog').getByText(/registros com os filtros/)).toBeVisible()
  await page.getByRole('button',{name:'Fechar registros'}).click()
  await page.getByRole('button',{name:'Carteira',exact:true}).click()
  await page.getByRole('button',{name:'Uso de banda',exact:true}).click()
  await expect(page.getByRole('img',{name:'Utilização média da capacidade'})).toBeVisible()
  await page.getByRole('button',{name:'Oportunidades',exact:true}).click()
  await expect(page.getByRole('columnheader',{name:'Pico no mês'})).toBeVisible()
})

test('vendedor só recebe seus dados e o servidor bloqueia alterações',async({page})=>{
  await signIn(page,'Vendedor')
  const r=await page.request.get('/api/dashboard?month=2026-11&seller=thiago')
  expect(r.ok()).toBeTruthy()
  const data=await r.json()
  expect(data.goals.map((g:{seller_key:string})=>g.seller_key)).toEqual(['cayo'])
  const result=await page.request.get('/api/records?month=2026-11&seller=thiago&kind=active_contract')
  const records=await result.json()
  expect(records.rows.length).toBeGreaterThan(0)
  expect(records.rows.every((row:{seller_key:string})=>row.seller_key==='cayo')).toBeTruthy()
  expect((await page.request.get('/api/admin/settings')).status()).toBe(403)
  expect((await page.request.post('/api/admin/settings',{data:{}})).status()).toBe(403)
})

test('admin envia arquivos e a última carga válida é preservada',async({page})=>{
  await signIn(page,'Administrador')
  await page.getByRole('button',{name:'Administração',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Histórico de importações'})).toBeVisible()
  const file={name:'relatorio-ignorado.xls',mimeType:'application/vnd.ms-excel',buffer:Buffer.from('<html><table><tr><td>Relatório não reconhecido</td></tr></table></html>')}
  await page.getByLabel('Base de origem').selectOption('new')
  await page.locator('input[type=file]').setInputFiles(file)
  await expect(page.getByText('Cabeçalhos não reconhecidos. Use o relatório original exportado.',{exact:true})).toBeVisible({timeout:15000})
  const approved=await page.request.get('/api/admin/imports')
  expect(approved.ok()).toBeTruthy()
  expect((await approved.json()).sources.length).toBeGreaterThan(5)
  const data=await page.request.get('/api/dashboard?month=2026-11')
  expect((await data.json()).base.contracts.end).toBe(81)
})

