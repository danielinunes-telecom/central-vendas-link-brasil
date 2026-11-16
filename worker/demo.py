"""Repeatable synthetic data for the product walkthrough. No source attachments are used."""
import argparse
from datetime import date
import os
from pathlib import Path
from random import Random
import tempfile

import psycopg
from openpyxl import Workbook

from .run import cli_import


def workbook(directory, name, header, data):
    path = directory / (name + ".xlsx")
    sheet = Workbook()
    sheet.active.append(header.split("|"))
    for record in data:
        sheet.active.append(record)
    sheet.save(path)
    return path


CLIENT = "ID|Razão social|Nome Fantasia/Social|CNPJ/CPF|Responsável|Data cadastro|Ativo|Cidade|Filial"
CONTRACT = "ID|Cliente|ID Cliente|Status contrato|Status acesso|Data ativação|Data cancelamento|Data de expiração|Data primeira assinatura|Status assinatura|Plano de venda|Descrição|Cidade|Filial"
SALE = "ID|Data da emissão|Vendedor|Contrato R|Contrato A|Valor|Status|Tipo doc."
ITEM = "ID Item|ID Contrato|ID Venda|Produto|Tipo de cobrança|Valor Item|Vendedor"
TITLE = "ID|Cliente|ID Cliente|Status|Vencimento|Valor|Valor aberto|Valor recebido|Data pagamento|ID Contrato Recorrente|Parcela proporcional|Tipo"
LEAD = "ID|Lead viável|Responsável|Data cadastro|ID Prospecção|Cliente|Nome|Cidade"
ACT = "ID|Tipo|Assunto|Responsável|Status|Data/hora inicio|Data hora fim|Data|Cliente"
DEAL = "ID|Funil|Estágio|Data vencemos|Contato|Cliente|Responsável|Status|Data inicio|Data perdemos"
EXPENSE = "ID|Nome|Centro de Custo|Data|Equipamento|Valor|Pessoas|Diárias"
CHANGE = "ID|Contrato|Data alteração|Tipo alt.|Vendedor|Valor anterior|Valor novo|Diferença|Plano anterior|Plano novo"
BAND = "ID|ID Contrato|Circuito|Data|Consumo Mbps|Capacidade Mbps"
DEBT = "ID Devedor|Nº Título|Nº Parcela|Data vencimento|Valor aberto|Cliente|Cidade|CNPJ Empresa Credora"
GROUP = ("adriano","cayo","thiago","fabiana","natalia","luiz","gustavo","odeyr","douglas","pamela","flavio","thais")
PRODUCT = ("LINK","TRANSPORTE","MITIGAÇÃO","CDNTV","PNI","GLOBAL CROSS")
CITIES = ("Araçatuba","Birigui","Barueri","Penápolis","São José do Rio Preto","Presidente Prudente")
CONNECTIONS = ("Órbita","Pórtico","Rota Sul","Camada 7","Rumo","Plano Norte","Entre Redes","Rede Leste","Polo","Atlântico","Fibra Central")


def seed(conn, observed, folder):
    rnd = Random(101)
    opening_people, opening_contracts, opening_items, opening_titles = [], [], [], []
    persons, contracts, items, sales, titles, debts, activities, leads, deals, expenses, changes, band = ([] for _ in range(12))
    previous, current = date(2026,10,31), observed
    build = lambda name, header, data: workbook(folder,name,header,data)
    for i in range(84):
        key = 1000+i
        name = CONNECTIONS[i%len(CONNECTIONS)]+" Telecom "+str(i//len(CONNECTIONS)+1)
        city=CITIES[i%len(CITIES)]
        seller=GROUP[i%len(GROUP)]
        owner = "thiago" if i in (2, 4) else seller
        product=PRODUCT[i%len(PRODUCT)]
        branch="Araçatuba" if i%4 else "Barueri"
        base_value=1600+rnd.randrange(0,3800,20)
        activation=date(2026,9,2+i%20)
        opening_people.append((key,name,name,None,owner,activation,"Sim",city,branch))
        opening_contracts.append((key,name,key,"Ativo","Ativo",activation,None,date(2027,9,1),activation,"Assinado",key,product,city,branch))
        opening_items.append((key,key,None,product,"Recorrente",base_value,seller))
        opening_titles.append((key,name,key,"Recebido",date(2026,10,21),base_value,0,base_value,date(2026,10,21),key,"N","Boleto"))
        new = i>=72
        if new:
            activation=date(2026,11,1+(i%11))
            amount=2100+rnd.randrange(0,8200,20)
            sales.append((8000+i,activation,seller,key,None,amount,"Finalizado","SALE"))
            items.append((key,key,8000+i,product,"Recorrente",amount,seller))
            leads.append((100+i,"Sim",seller,date(2026,10,28),None,key,name,city))
            base_value=amount
        elif i in (1,17,35,58,64,69):
            difference=250+i*4
            changes.append((3000+i,key,date(2026,11,7),"Upgrade de plano",seller,base_value,base_value+difference,difference,product,product))
            base_value+=difference
        elif i in (3,29,65):
            changes.append((3000+i,key,date(2026,11,8),"Downgrade",seller,base_value,base_value-140,-140,product,product))
            base_value-=140
        if not any(a[1]==key for a in items):
            items.append((key,key,None,product,"Recorrente",base_value,seller))
        cancelled=date(2026,11,8) if i in (5,36,67) else None
        if i in (6,34):
            changes.append((3000+i,key,date(2026,11,9),"Reversão",seller,base_value,base_value,0,product,product))
        expires=date(2026,11,2) if i in (10,32,76) else date(2027,9,1)
        persons.append((key,name,name,None,seller,activation,"Sim",city,branch))
        contracts.append((key,name,key,"Inativo" if cancelled else "Ativo","Bloqueado" if i%17==0 else "Ativo",activation,cancelled,expires,
                          None if i%37==0 else activation,"Pendente" if i%37==0 else "Assinado",key,product,city,branch))
        paid=i%4!=0
        titles.append((5000+i,name,key,"Recebido" if paid else "A receber",date(2026,11,10),base_value,
                       0 if paid else base_value,base_value if paid else 0,date(2026,11,10) if paid else None,key,"N","Boleto"))
        if i%8==0:
            debts.append((key,9000+i,1,date(2026,8,10),360+i*9,name,city,"Demonstração"))
        if i%3!=0 and not cancelled:
            visit_day=date(2026,11,1+i%10)
            activities.append((7000+i,"Tarefa","VISITAS",owner,"Concluída",visit_day,visit_day,visit_day,key))
        if i%4==0:
            day=date(2026,11,2+i%9)
            deals.append((2000+i,"Comercial",("Proposta","Viabilidade","Aguardando ativação")[i%3],None,None,name,seller,"Negociando",day,None))
            leads.append((400+i,"Sim",seller,day,None,None,"Provedor "+str(i+1),city))
            if i%8==0:
                activities.append((7700+i,"Tarefa","Visita de prospecção",seller,"Concluída",day,day,day,key))
        if i%2==0:
            for j in range(1,12,2):
                capacity=1000 if i%4==0 else 500
                used=round(capacity*(.32+rnd.random()*.65),2)
                band.append((i*100+j,key,"CIR-"+str(key),date(2026,11,j),used,capacity))
    for j,seller in enumerate(GROUP):
        for i in range(6):
            category=("Combustível","Almoço","Jantar","Hospedagem","Pedágios","Extras")[i]
            value=(340+j*12,36+j*2,29+j*3,155+j*6,36+j*4,65+j*7)[i]
            expenses.append((j*10+i+1,seller,category,date(2026,11,2+i*2),"Veículo "+str(j+1),value,1,1))
    # The opening position must represent only contracts present before November.
    cli_import(conn,[build("Clientes abertura",CLIENT,opening_people[:72]),build("Contratos abertura",CONTRACT,opening_contracts[:72]),
                     build("Itens abertura",ITEM,opening_items[:72]),build("Títulos abertura",TITLE,opening_titles[:72])],previous)
    cli_import(conn,[build("Clientes",CLIENT,persons),build("Contratos",CONTRACT,contracts),build("Itens",ITEM,items),
                     build("Vendas",SALE,sales),build("Títulos",TITLE,titles),build("Inadimplência",DEBT,debts),
                     build("Contatos",LEAD,leads),build("Tarefas",ACT,activities),build("Negociações",DEAL,deals),
                     build("Despesas",EXPENSE,expenses),build("Alterações",CHANGE,changes),build("Banda",BAND,band)],current)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--day",type=date.fromisoformat,required=True)
    args=parser.parse_args()
    with psycopg.connect(os.environ["DATABASE_URL"],autocommit=True) as conn:
        if conn.execute("select 1 from comercial.source_loads limit 1").fetchone():
            return
        names = {
            "adriano":"André Oliveira","cayo":"Caio Reis","thiago":"Tiago Costa","fabiana":"Flora Ribeiro",
            "natalia":"Beatriz Martins","luiz":"Lucas Santos","gustavo":"Gabriel Almeida","odeyr":"Otávio Nunes",
            "douglas":"Diego Lima","pamela":"Paula Carvalho","flavio":"Felipe Rocha","thais":"Tânia Vidal",
            "marcos":"Mateus Melo","ygor":"Igor Silva","vinicios":"Vítor Barros","flavio-novato":"Rafael Assis",
            "daniel-novato":"Leonardo Freitas","julio-novato":"João Rezende","andreza-novato":"Cecília Lopes",
        }
        with conn.cursor() as cursor:
            cursor.executemany("update comercial.sellers set name=%s where seller_key=%s",
                               [(name,key) for key,name in names.items()])
        conn.execute("update comercial.accounts set name='Caio Reis' where email='cayo@linkbrasil.test'")
        conn.execute("update comercial.settings set value='{}' where setting='aliases'")
        conn.execute("update comercial.settings set value='[\"Reversão\"]' where setting='reversal_types'")
        conn.execute("update comercial.settings set value='[\"SALE\"]' where setting='sales_doc_types'")
        with tempfile.TemporaryDirectory() as folder:
            seed(conn,args.day,Path(folder))


if __name__=="__main__":
    main()

