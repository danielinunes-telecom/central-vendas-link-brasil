export type Role = 'admin' | 'manager' | 'seller'
export type Viewer = { email: string; name: string; role: Role; seller_key: string | null }
export type Seller = { seller_key: string; name: string; team: string; active: boolean }
export const baseNames = {old:'Base Velha',new:'Base Nova',legacy:'Histórico sem base'} as const
export type BaseCode = keyof typeof baseNames
export type Filters = { base: string; month: string; seller: string; branch: string; city: string; product: string }
export type Metric = {
  kind: string; row_key: string; base_code: BaseCode; seller_key: string | null; seller: string | null
  occurred_on: string | null; label: string; amount: number | null
  city: string | null; branch: string | null; product: string | null
  details: Record<string, string | number | boolean | null>
}
export type Line = { kind: string; count: number; amount: number; coverage: number; excess: number; missing: number }
export type Goal = { seller_key: string; name: string; team: string; target: number; actual: number; pending: number }
export type Trend = { day: string; value: number }
export type Category = { name: string; amount: number; count: number }
export type Usage = { base_code: BaseCode; circuit: string; label: string; last: number; peak: number; used: number; capacity: number; day: string }
export type MonthState = {
  opening?: boolean; closing?: boolean; reversal?: boolean; band?: boolean; visits?: boolean; expenses?: boolean
  debts?: boolean; receipts?: boolean; leads?: boolean; signatures?: boolean; overdue?: boolean; changes?:boolean; goal?:boolean
  threshold?: number; meal?: number; lodging?: number
  debt_as_of?: string|null; contract_as_of?: string|null
}
export type BaseChange = { start: number | null; entries: number | null; exits: number | null; end: number | null }
export type DashboardData = {
  viewer: Viewer
  filters: Filters
  options: { sellers: Seller[]; branches: string[]; cities: string[]; products: string[] }
  lines: Line[]
  goals: Goal[]
  daily: Trend[]
  expenses: Category[]
  pipeline: Category[]
  base: { clients: BaseChange; contracts: BaseChange; mrr: BaseChange; unresolved: number }
  coverage: { active: number; visited: number; pending: number; older: number }
  bandwidth: { trend: Trend[]; circuits: Usage[] }
  state: MonthState
  observed: string | null
  lastUpdate: string | null
  demo: boolean
  today: string
  basePositions: {code:BaseCode; observed:string; contracts:boolean; debts:boolean; expenses:boolean}[]
}
export type ImportFile = {
  id: string; name: string; source: string | null; status: string
  rows_read: number; rows_applied: number; issues: { line: number; message: string }[]; error: string | null
}
export type ImportBatch = {
  id: string; base_code: BaseCode; status: string; observed_on: string; submitted_at: string; submitted_by: string
  finished_at: string | null; error: string | null; files: ImportFile[]
}
export type SourceStatus = { source: string; base_code: BaseCode; observed_on: string; loaded_at: string; rows_loaded: number }
export type AdminData = {
  rules: Record<string, unknown>
  targets: { seller_key: string; name: string; effective_month: string; amount: number }[]
  rates: { product: string; effective_month: string; rate: number }[]
  sellers: Seller[]
  accounts: (Viewer & { active: boolean })[]
  changes: { setting: string; changed_by: string; changed_at: string }[]
}

export const earliestMonth = '2026-11'
export const roles: Record<Role, string> = { admin: 'Administrador', manager: 'Gestor', seller: 'Vendedor' }
export const sections = [
  { key: 'overview', label: 'Visão geral' },
  { key: 'portfolio', label: 'Carteira' },
  { key: 'sales', label: 'Vendas e metas' },
  { key: 'crm', label: 'Leads e visitas' },
  { key: 'expenses', label: 'Despesas' },
  { key: 'admin', label: 'Administração' },
] as const
export type Section = typeof sections[number]['key']
export const sourceNames: Record<string, string> = {
  customers: 'Cadastro de clientes', contracts: 'Contratos', contract_details: 'Contratos detalhados (PDF)', sales: 'Vendas',
  titles: 'Títulos', open_titles: 'Títulos em aberto', payments: 'Recebimentos',
  debts: 'Inadimplência', leads: 'Leads', activities: 'Atividades e visitas',
  negotiations: 'Negociações', changes: 'Alterações de contrato', expenses: 'Life Tracker',
  items: 'Itens do contrato', band: 'Uso de banda', seller_directory: 'Cadastro de vendedores (IXC)',
}
export const metricNames: Record<string,string> = {
  target:'Metas individuais', goal_sale:'Vendas contabilizadas na meta', goal_pending:'Ativações pendentes de validação',
  active_contract:'Contratos ativos', active_client:'Clientes ativos', opening_contract:'Contratos na abertura', mrr:'Receita recorrente estimada',
  activation:'Ativações', cancellation:'Cancelamentos', upgrade:'Upgrades', downgrade:'Downgrades',
  reversal:'Reversões', receipt:'Recebimentos', debt:'Inadimplência de 60 dias', expired:'Contratos vencidos',
  unsigned:'Contratos com assinatura pendente', band:'Medições de banda', lead_new:'Leads cadastrados',
  lead_won:'Leads efetivados', negotiation:'Negociações', prospect_visit:'Visitas de prospecção',
  visit_coverage:'Visitas à carteira', visit_task:'Tarefas de visita concluídas',
  visit_overdue:'Clientes com 60 dias sem visita', opening_mrr:'Receita recorrente na abertura', expense:'Despesas em campo',
}

