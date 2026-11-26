'use client'
import { createContext, useContext } from 'react'
import { brl } from '@/lib/format'

export const FinancialVisibility = createContext(false)
export function useMoney() {
  const visible = useContext(FinancialVisibility)
  return (value: number | null | undefined) =>
    value == null ? 'S/I' : visible ? brl(value) : 'R$ ••••••'
}
