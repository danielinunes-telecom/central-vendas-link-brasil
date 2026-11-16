import type { Metric } from './model'

export const detailIdentifiers = [
  ['contract','ID do contrato'], ['title','ID do título'], ['client','ID do cliente'],
  ['task','ID da tarefa'], ['lead','ID do lead'], ['deal','ID da negociação'], ['circuit','Circuito'],
] as const

export const rowIdentifiers: Readonly<Record<string,string>> = {
  upgrade:'ID da alteração', downgrade:'ID da alteração', reversal:'ID da alteração',
  expense:'ID da despesa', band:'ID da medição',
}

// The importer generates these keys when a source report has no ID.
export const generatedRowKey = '^[a-f0-9]{32}(:[0-9]+)?$'
const generated = new RegExp(generatedRowKey)

export function recordIdentifiers(row: Metric) {
  const ids: {key:string; label:string; value:string}[] = detailIdentifiers.flatMap(([key,label]) => {
    const value = row.details[key]
    return value == null || value === '' ? [] : [{key:String(key),label,value:String(value)}]
  })
  const rowLabel = rowIdentifiers[row.kind]
  if (rowLabel && !generated.test(row.row_key)) {
    ids.push({key:'source',label:rowLabel,value:row.row_key})
  }
  return ids
}

export function debtInstallment(row: Metric) {
  if (row.kind !== 'debt') return null
  // The delinquency export stores the installment number in its composite key.
  const parts = row.row_key.split(':')
  return parts.length === 3 && parts[1] === String(row.details.title) && parts[2] !== '?'
    ? parts[2] : null
}
