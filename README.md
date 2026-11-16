# Central de Vendas Link Brasil

Painel comercial interno com Next.js, React, TypeScript, Apache ECharts, PostgreSQL e um importador Python. O painel e o importador são processos separados. As regras dos indicadores ficam em SQL, com permissões por linha no PostgreSQL.

## Demonstração local

Requer Node.js 22 ou mais recente, Python 3.12 e as dependências abaixo. O PostgreSQL de demonstração é iniciado pelo projeto.

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt
npm run demo
```

Abra http://localhost:3000. A demonstração usa novembro de 2026, planilhas fictícias geradas localmente e três perfis selecionáveis. No Windows, use `.venv\Scripts\pip.exe`. Use `LB_PYTHON` para indicar outro executável Python. A pasta `.local` contém as planilhas geradas e o banco local. A demonstração e o ambiente corporativo devem usar bancos distintos.

## Implantação corporativa

1. Em um projeto Supabase da Link Brasil, aplique `db/001_schema.sql` até `db/004_administration.sql`, em ordem, e depois `db/supabase.sql`. O último cria a fila `lb_imports` e o bucket privado `link-brasil-importacoes`.
2. Crie um login PostgreSQL dedicado à aplicação e conceda a ele a função `lb_dashboard`. Esse login deve entrar como um usuário próprio e poder assumir a função por `SET ROLE`. Use a conexão desse login em `DASHBOARD_DATABASE_URL`. O serviço Python usa `DATABASE_URL` com o usuário de banco que administra o esquema `comercial` e a fila, como o papel `postgres` do projeto. Mantenha os dois segredos no Render.
3. No Supabase Auth, habilite login com e-mail e senha. Cadastre o primeiro administrador, confirme o endereço e registre o mesmo e-mail na tabela `comercial.accounts` com a função `admin`. Desative o cadastro público se o projeto for exclusivo da equipe. Depois, a tela Administração → Configurações vincula cada conta corporativa ao perfil correto.
4. Em um repositório privado, configure os dois serviços de `render.yaml` no Render. Preencha `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVER_KEY`, as conexões PostgreSQL e `APP_ORIGIN` com a origem exata do serviço web. Use SSL nas conexões ao Supabase. O serviço web e o importador têm Dockerfiles independentes.
5. Entre com o administrador e faça a primeira carga na seção Importações. Cadastros e saldos são posições completas. Vendas, alterações, recebimentos, atividades e despesas trazem o mês corrente e o anterior. O painel começa em novembro de 2026. Uma posição de abertura de 31/10 habilita a comparação da base para a primeira competência. Cadastros de abertura devem ser carregados antes das posições mais recentes da mesma fonte.

Para cadastrar o primeiro administrador, o responsável pelo banco pode executar, com o e-mail corporativo confirmado:

```sql
insert into comercial.accounts(email,name,role,seller_key)
values ('administrador@empresa.example','Administração','admin',null);
```

## Importação e apuração

- A Administração aceita o envio em lote de .xlsx, .xls, HTML com extensão .xls e do PDF de alterações do IXC. O importador reconhece cabeçalhos, guarda origem e linha, valida o lote e informa rejeições. O mesmo arquivo reenviado atualiza a data de referência sem dobrar totais.
- O Colaborador Responsável define o dono da carteira. Cadastros com nomes duplicados ficam pendentes até existir um vínculo por ID ou uma associação conferida na Administração. Esse tratamento se aplica à contagem de clientes, ao detalhamento por vendedor e aos leads efetivados. Grafias e códigos de vendedor podem ser vinculados nas configurações.
- As metas individuais iniciais são R$ 10.000 para Adriano, Cayo e Thiago, R$ 5.000 para Natália e R$ 7.000 para os demais. A competência é a data de ativação e o vendedor é o da venda. O painel mostra o realizado validado, o percentual atingido e os contratos pendentes. Para usar o total de um documento, confirme os códigos elegíveis e cadastre o vínculo entre plano e produto na Administração. Itens identificados por venda ou uma conferência específica permitem validar contratos com vários produtos.
- A receita recorrente usa itens recorrentes quando disponíveis. Para a estimativa, exige um título recorrente sem cobrança proporcional elegível por contrato e mês. A cobertura aparece no painel.
- Uma visita à carteira é uma tarefa concluída com assunto reconhecido, vinculada ao cliente. Para transferências, o crédito da visita já feita fica com o responsável da data. Uma pendência acompanha o novo responsável se o cliente ainda não tiver sido visitado na competência. A primeira carga registra a posição conhecida e o responsável da tarefa ajuda a atribuir visitas anteriores ao histórico.
- O Life Tracker usa o campo Nome para identificar o vendedor. Almoço e jantar usam o limite de R$ 40 por refeição. Hospedagem usa R$ 180 por pessoa e diária. Lançamentos que não trazem pessoas ou diárias entram no total e ficam pendentes para cálculo do excedente.
- Reversões aguardam o nome do tipo de alteração do IXC. A análise de banda aguarda o primeiro arquivo. O importador aceita uma planilha com Data, Consumo Mbps, Capacidade Mbps e ID Contrato, Circuito ou Login. O administrador pode vincular circuitos e ajustar o percentual de oportunidade, com referência inicial de 80%. Confirme cabeçalhos e granularidade quando chegar a exportação real.
- Os arquivos das fontes ficam privados. Os perfis restringem o detalhamento e o CSV. O gestor só consulta. A fila de importação, o armazenamento e a base corporativa usam as credenciais do ambiente implantado.
- A integração por API é a próxima etapa após validar as cargas da equipe. O importador e a apuração usam o mesmo modelo de registros para os futuros conectores.

## Verificação

```sh
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Para executar os testes de navegador, instale o Chromium do Playwright com `npx playwright install chromium`, ou defina `LB_CHROMIUM` com o caminho do executável instalado. Os testes iniciam um banco de demonstração isolado. Cada implantação precisa validar o login corporativo, a fila e o armazenamento no projeto Supabase de destino.

