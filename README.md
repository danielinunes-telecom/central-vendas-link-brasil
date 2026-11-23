# Central de Vendas Link Brasil

Painel comercial interno com Next.js, React, TypeScript, Apache ECharts, PostgreSQL e um importador Python. O painel e o importador são processos separados. As regras dos indicadores ficam em SQL, com permissões por linha no PostgreSQL.

Para instalar o painel e o importador continuamente em uma VM, consulte [IMPLANTACAO_VM.md](IMPLANTACAO_VM.md). O arquivo `docker-compose.yml` executa os dois processos e `.env.example` documenta as variaveis sem incluir credenciais.

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

1. Em um projeto Supabase da Link Brasil, aplique as migrations de `db/001_schema.sql` até `db/011_contract_goal_activity_corrections.sql`, em ordem, e depois `db/supabase.sql`. O último cria a fila `lb_imports` e o bucket privado `link-brasil-importacoes`.
2. Crie um login PostgreSQL dedicado à aplicação e conceda a ele a função `lb_dashboard`. Esse login deve entrar como um usuário próprio e poder assumir a função por `SET ROLE`. Use a conexão desse login em `DASHBOARD_DATABASE_URL`. O serviço Python usa `DATABASE_URL` com o usuário de banco que administra o esquema `comercial` e a fila, como o papel `postgres` do projeto. Mantenha os dois segredos no Render.
3. No Supabase Auth, habilite login com e-mail e senha. Cadastre o primeiro administrador, confirme o endereço e registre o mesmo e-mail na tabela `comercial.accounts` com a função `admin`. Desative o cadastro público se o projeto for exclusivo da equipe. Depois, a tela Administração → Configurações vincula cada conta corporativa ao perfil correto.
4. No Render, use o `render.yaml` do repositório privado. Ele cria apenas o serviço web no plano Free. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVER_KEY` e `DASHBOARD_DATABASE_URL` nas variáveis de ambiente do Render, e `APP_ORIGIN` com a origem HTTPS exata do painel (sem barra final). Use a conexão Session pooler do Supabase com SSL e o login restrito do passo 2.
5. Entre com o administrador e faça a primeira carga na seção Importações. Cadastros e saldos são posições completas. Vendas, alterações, recebimentos, atividades e despesas trazem o mês corrente e o anterior. O painel começa em novembro de 2026. Uma posição de abertura de 31/10 habilita a comparação da base para a primeira competência. Cadastros de abertura devem ser carregados antes das posições mais recentes da mesma fonte.

Para cadastrar o primeiro administrador, o responsável pelo banco pode executar, com o e-mail corporativo confirmado:

```sql
insert into comercial.accounts(email,name,role,seller_key)
values ('administrador@empresa.example','Administração','admin',null);
```

### Importador em um computador Windows

Use Python 3.12. Na pasta extraída do projeto, abra o PowerShell e instale as dependências uma vez.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r worker/requirements.txt
```

Nas variáveis de ambiente do **usuário do Windows** que vai rodar o importador, configure `DATABASE_URL` com a conexão Session pooler do usuário do banco indicado no passo 2, `SUPABASE_URL` com o endereço do projeto, `SUPABASE_SERVER_KEY` com a chave de servidor e `PGSSLMODE` com `require`. Abra um novo PowerShell após salvar. Chaves e senhas ficam nas configurações do computador ou do Render.

Para processar os lotes enviados pelo painel, rode este comando na pasta do projeto.

```powershell
.\.venv\Scripts\python.exe -m worker.run
```

Com a janela aberta, o importador acompanha a fila do Supabase. Se o computador estiver desligado ou o processo estiver fechado, os lotes ficam aguardando e são processados quando o importador voltar. O painel continua consultando a última carga aplicada. No plano gratuito do Render, o primeiro acesso depois de 15 minutos sem tráfego pode demorar.

## Importação e apuração

- A Administração aceita o envio em lote de .xlsx, .xls, HTML com extensão .xls e do PDF de alterações do IXC. O importador reconhece cabeçalhos, guarda origem e linha, valida o lote e informa rejeições. O mesmo arquivo reenviado atualiza a data de referência sem dobrar totais.
- O Colaborador Responsável define o dono da carteira. Cadastros com nomes duplicados ficam pendentes até existir um vínculo por ID ou uma associação conferida na Administração. Esse tratamento se aplica à contagem de clientes, ao detalhamento por vendedor e aos leads efetivados. Grafias e códigos de vendedor podem ser vinculados nas configurações.
- As metas individuais iniciais são R$ 10.000 para Adriano, Cayo e Thiago, R$ 5.000 para Natália e R$ 7.000 para os demais. A competência é a data de ativação e o vendedor é o da venda. O painel mostra o realizado validado, o percentual atingido e os contratos pendentes. Todos os planos e tipos de documento finalizados contam pelo valor integral da venda, sem pesos por serviço. Itens identificados por venda ou uma conferência específica permitem validar contratos com vários produtos.
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


### Atualização de múltiplas bases em uma instalação existente

1. Deixe o PowerShell aberto e pare o importador com Ctrl+C. Em uma janela de manutenção,
   faça backup do banco. Se a atualização anterior ainda não foi aplicada, execute
   `db/005_contract_details.sql`. Depois execute `db/006_multiple_bases.sql` no SQL Editor
   do Supabase. Aplique cada migration nova uma única vez, na ordem indicada.
2. Publique a atualização web no Render por meio do GitHub. Substitua pelos arquivos da
   mesma versão os módulos `worker/ingest.py`, `worker/readers.py`, `worker/reports.py`
   e `worker/run.py` no Windows.
3. Na mesma janela do PowerShell, reinicie com `.\.venv\Scripts\python.exe -m worker.run`.
4. Envie um lote por base, com a data real da extração. Se tiver fotografias de abertura,
   importe essas antes das posições mais recentes da mesma base.

| Lote | Relatórios |
|---|---|
| Base Velha | Contratos, clientes, contas a receber, vendas, despesas, inadimplência, alterações e PDF de contratos detalhados |
| Base Nova | Os mesmos relatórios, mais leads, negociações e atividades |

Lotes antigos ficam em **Histórico sem base**. Enquanto não houver cargas identificadas em
uma competência, o painel mostra os dados históricos disponíveis nessa visão. Assim que
houver uma carga identificada, a visão consolidada usa apenas Base Velha e Base Nova.
O histórico permanece acessível pelo filtro para evitar soma duplicada. Carregue as duas
bases identificadas para conferir o consolidado.

O painel exibe os IDs originais e a base. A carteira consolidada conta um único cliente
quando o mesmo CPF ou CNPJ numérico válido estiver em ambas as bases. Os contratos
continuam separados. O documento não aparece no detalhamento. O CRM cruza os IDs com
a Base Nova. A meta é global por vendedor. O PDF detalhado fornece renovação e valor
total complementar, sem entrar na apuração da meta ou da receita recorrente. Para
configurar exceções por código nas novas bases, use `old:ID` e `new:ID`.


### Outubro e visitas — atualização 007

Com as migrations 005 e 006 já aplicadas, execute apenas `db/007_october_visits.sql`
uma vez e publique os arquivos desta atualização. Atualize `worker/reports.py` no Windows
e reenvie Atividades e Negociações da Base Nova para reprocessar os campos novos.
O importador usa Data/Hora início nas atividades e Data início nas negociações.

Visitas são atividades com assunto começando com VISITA, incluindo VISITAS, e negociações
com tipo RELACIONAMENTO, em qualquer status. Os IDs de clientes desses registros apontam
para a Base Velha. A cobertura mensal deduplica por cliente e os detalhes guardam os IDs
originais de cada tarefa ou negociação. Uma exportação de negociações sem coluna Tipo
gera aviso e mantém essas visitas pendentes até receber o campo. Leads continuam com
os vínculos já configurados para a Base Nova.

Metas de outubro herdam os primeiros valores vigentes, preservando valores de
outubro já configurados. Posições históricas da carteira precisam de suas fotografias.
Datas de eventos e vínculos de clientes podem ser recuperados de uma exportação posterior,
com a posição histórica marcada como indisponível. Visitas em status de agendamento também
contam na cobertura de acordo com a regra aprovada.


### PDFs com vendedor — atualização 008

Após a migration 007, execute `db/008_contract_values.sql` uma única vez. Atualize
`worker/readers.py`, `worker/reports.py` e `worker/run.py` no Windows, reinicie o
importador e reenvie os dois PDFs na Base Nova. O painel é publicado pelo GitHub/Render.

O relatório "Detalhado com Instalador Responsável" traz ID do cliente, plano,
ativação, renovação, vendedor, líquido mensal e instalação. Seu ID pertence ao
cliente. A importação confere a quantidade de linhas e a soma dos valores com o
rodapé. O painel mostra quantidade e líquido mensal do próprio relatório por vendedor.
O vínculo com um contrato exige cliente, plano e ativação compatíveis e uma única
correspondência na mesma base. Vínculos ambíguos permanecem pendentes. A meta comercial
continua usando os produtos e valores elegíveis da venda.

O leitor de alterações preserva linhas como "Alteração de venc." cujos textos
invadem a faixa horizontal da data. Os três modelos de PDF são identificados
pelo conteúdo, independentemente do nome do arquivo.


## Valor integral das vendas — atualização 009

Execute `db/009_full_sales_value.sql` no SQL Editor do Supabase, após as migrações anteriores. O script pode ser executado novamente e recalcula os meses já importados. Todas as vendas finalizadas contam pelo valor integral, independentemente do serviço, do plano ou do tipo de documento. Não é necessário cadastrar pesos nem mapear planos para apurar a meta. As metas mensais por vendedor e a competência pela ativação permanecem.

A conferência manual e os itens vinculados continuam tendo prioridade. Sem itens, uma única venda finalizada vinculada ao contrato fornece seu total; vários documentos para o mesmo contrato continuam pendentes de conferência para evitar duplicidade. O valor mensal do PDF de contratos permanece complementar e não substitui silenciosamente um valor divergente do relatório de vendas.


## Importador independente do Windows

O site e o importador são serviços diferentes. Publicar o site não inicia o processamento da fila.
O arquivo `render.worker.yaml` define apenas o novo serviço `central-vendas-importador`, sem alterar o site existente. O Dockerfile já inclui o leitor atualizado dos PDFs e as dependências Python.

1. No Render, crie um Blueprint deste repositório com o caminho `render.worker.yaml` e revise o plano antes de ativá-lo.
2. Configure `DATABASE_URL` no Environment do novo importador com a conexão **Session pooler** completa e a senha atual do banco. Use uma conta com permissão para importar no esquema comercial e consumir a fila pgmq. Não use a conexão de consulta restrita do dashboard nem uma chave de API no lugar da conexão PostgreSQL.
3. `SUPABASE_URL` e `SUPABASE_SERVER_KEY` são referenciadas do serviço web já existente. A fila é `pgmq` e o bucket é `link-brasil-importacoes`.
4. Após a ativação, confirme nos logs `Importer connected` e a conclusão de um lote enviado pelo painel. Então feche o importador local e repita o envio com o computador local fora do processamento.

O serviço contínuo usa inicialmente 0,5 CPU e 512 MB (plano pago). Valide o custo no plano do Render antes de aprovar. Caso um arquivo exceda a memória, avalie os logs antes de mudar o plano.

Os arquivos originais e a fila permanecem no Supabase; o importador não precisa de disco persistente. Recebendo SIGTERM, ele termina o lote atual antes de parar de consumir a fila, com até 300 segundos de encerramento no Render. Se houver interrupção forçada, a transação é revertida e a mensagem volta após o prazo de visibilidade de 15 minutos. Lotes já marcados como falhos não são reenviados automaticamente; o histórico informa a falha e o arquivo corrigido deve ser anexado novamente.

Para diagnóstico, `python -m worker.run --check` confere a configuração, a conexão, a existência da fila e informa quantidades de lotes aguardando, em processamento e falhos, sem consumir mensagens. Isso não verifica os valores comerciais de cada contrato. O caso COREVAULT (contrato 1005 da Base Nova) continua exigindo a consulta das vendas vinculadas: a última informação disponível é uma pendência de confirmação de valor.
