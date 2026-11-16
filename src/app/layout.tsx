import type { Metadata } from 'next'
import './globals.css'
export const metadata: Metadata = {
  title:'Central de Vendas | Link Brasil',
  description:'Carteira, metas, visitas e despesas da Link Brasil.',
  icons:{ icon:'/favicon.svg' },
  robots:{index:false,follow:false},
}
export default function RootLayout({ children }: Readonly<{children:React.ReactNode}>) {
  return <html lang="pt-BR"><body>{children}</body></html>
}

