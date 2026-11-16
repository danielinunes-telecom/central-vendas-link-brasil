'use client'
import { useState } from 'react'
import { ArrowRight, ChartNoAxesCombined, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import type { Role } from '@/lib/model'
import { roles } from '@/lib/model'

export function Login({demo,configured}:{demo:boolean;configured:boolean}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  async function enter(body:{profile:Role}|{email:string;password:string}) {
    setBusy(true);setError('')
    try {
      const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      if (!r.ok) throw new Error((await r.json()).error)
      location.href='/'
    } catch (err) { setError(err instanceof Error?err.message:'Falha ao entrar.');setBusy(false) }
  }
  return <main className="login-layout">
    <section className="login-brand">
      <div className="login-mark"><img src="/link-brasil.png" width={170} height={39} alt="Link Brasil" /></div>
      <div className="login-brand-text"><span className="login-emblem"><ChartNoAxesCombined size={34}/></span>
        <h1>Central de Vendas</h1><p>Carteira, metas e desempenho comercial da Link Brasil.</p></div>
    </section>
    <section className="login-panel">
      <div className="login-form">
        <span className="login-lock"><LockKeyhole size={22}/></span>
        <h2>{demo?'Conheça o painel':'Acesse sua conta'}</h2>
        <p>{demo?'Ambiente de demonstração com dados fictícios.':'Use o acesso corporativo da Link Brasil.'}</p>
        {demo?<div className="login-profiles">{(['admin','manager','seller'] as Role[]).map(profile=>
          <button key={profile} disabled={busy} onClick={()=>enter({profile})}>{profile==='admin'?<ShieldCheck size={19}/>:<UserRound size={19}/>}
            <span>{roles[profile]}</span><ArrowRight size={17}/></button>)}</div>
        : <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);enter({email:String(f.get('email')),password:String(f.get('password'))})}}>
          <label>E-mail <input autoComplete="username" required name="email" type="email" placeholder="nome@linkbrasil.net.br"/></label>
          <label>Senha <input autoComplete="current-password" required name="password" type="password" placeholder="Sua senha"/></label>
          <button className="primary" type="submit" disabled={busy||!configured}>{busy?'Entrando…':'Entrar'}<ArrowRight size={16}/></button>
        </form>}
        {!configured && <p className="form-error" role="status">A conexão corporativa precisa ser configurada antes do primeiro acesso.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </section>
  </main>
}

