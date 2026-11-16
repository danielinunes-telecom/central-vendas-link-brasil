const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const compactCurrency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 })
const number = new Intl.NumberFormat('pt-BR')
const percent = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
const short = new Intl.DateTimeFormat('pt-BR', {day:'2-digit',month:'short',timeZone:'UTC'})
const long = new Intl.DateTimeFormat('pt-BR', {month:'long',year:'numeric',timeZone:'UTC'})
export const brl = (n: number | null | undefined) => n == null ? '—' : currency.format(n)
export const compactBrl = (n: number) => compactCurrency.format(n)
export const qty = (n: number | null | undefined) => n == null ? '—' : number.format(n)
export const pct = (n: number | null | undefined) => n == null ? '—' : percent.format(n) + '%'
export const ratio = (value: number, total: number) => total > 0 ? 100 * value / total : null
export const dateLabel = (s: string | null | undefined) => s ? s.slice(0,10).split('-').reverse().join('/') : '—'
export const dayLabel = (s: string) => short.format(new Date(s.slice(0,10)+'T00:00:00Z')).replace('.','')
export const monthLabel = (s: string) => {
  const label = long.format(new Date(s.slice(0,7)+'-01T00:00:00Z'))
  return label.charAt(0).toUpperCase() + label.slice(1)
}
export function localDay() {
  if (process.env.LB_DEMO === '1' && process.env.LB_DEMO_DAY) return process.env.LB_DEMO_DAY
  return new Intl.DateTimeFormat('sv-SE',{ timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit' }).format()
}

