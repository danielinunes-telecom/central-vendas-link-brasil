# Implantacao em VM com Docker Compose

Esta instalacao executa dois containers independentes:

- `web`: painel Next.js, publicado na porta local `3000`;
- `importer`: importador Python que acompanha continuamente a fila `lb_imports`.

Os arquivos e dados permanecem no Supabase. Nenhum volume persistente e necessario na VM.

## 1. Recursos da VM

Configuracao inicial recomendada para compartilhar a VM com outras aplicacoes:

- 1 vCPU disponivel;
- 1 GB de RAM disponivel para a Central de Vendas;
- 4 GB livres em disco para imagens, builds e logs do Docker;
- Docker Engine com o plugin Docker Compose;
- Git;
- relogio do servidor sincronizado.

Os limites iniciais definidos no Compose sao 0,5 CPU e 384 MB para o painel, e 0,5 CPU e 512 MB para o importador. Ajuste somente depois de observar os logs e o consumo real, especialmente durante a leitura de PDFs grandes.

## 2. Rede necessaria

Saidas da VM:

| Destino | Porta | Uso |
|---|---:|---|
| Supabase HTTPS | TCP 443 | autenticacao, arquivos e APIs |
| Session Pooler do Supabase | TCP 5432 | banco PostgreSQL e fila pgmq |
| GitHub e registros Docker/NPM/PyPI | TCP 443 | instalacao e atualizacoes |

Entradas:

- TCP 22, restrita aos IPs da administracao, para SSH;
- TCP 443 no proxy HTTPS da empresa;
- TCP 80 apenas se o proxy utilizar redirecionamento ou emissao de certificado.

Por seguranca, o Compose publica o painel somente em `127.0.0.1:3000`. O Nginx, Traefik ou outro proxy existente na VM deve encaminhar o dominio HTTPS para esse endereco. Nao abra a porta 3000 na internet.

## 3. Preparar o Supabase

Em uma instalacao nova, execute no SQL Editor, uma vez e na ordem:

1. `db/001_schema.sql` ate `db/011_contract_goal_activity_corrections.sql`;
2. `db/supabase.sql`.

Em uma instalacao existente, aplique apenas as migrations ainda nao executadas. Antes de uma migration, faca backup. Nao repita scripts antigos sem conferir o historico da instalacao.

Use dois acessos PostgreSQL:

- `DATABASE_URL`: usuario do importador, autorizado a administrar o esquema `comercial` e consumir a fila `pgmq`;
- `DASHBOARD_DATABASE_URL`: usuario restrito do painel, membro de `lb_dashboard`.

Use o endereco **Session Pooler** completo fornecido pelo Supabase. A chave `SUPABASE_SERVER_KEY` nao substitui a senha PostgreSQL.

## 4. Instalar na VM

Exemplo para uma VM Linux:

```sh
sudo mkdir -p /opt/central-vendas
sudo chown "$USER":"$USER" /opt/central-vendas
git clone https://github.com/danielinunes-telecom/central-vendas-link-brasil.git /opt/central-vendas/app
cd /opt/central-vendas/app
cp .env.example .env
chmod 600 .env
nano .env
```

Preencha todas as credenciais e substitua `APP_ORIGIN` pelo dominio HTTPS real, sem barra ao final. Se a senha do banco contiver caracteres como `@`, `:`, `/`, `#`, `%` ou `?`, aplique percent-encoding antes de inseri-la na URL.

Valide a configuracao sem iniciar containers:

```sh
docker compose config --quiet
```

Construa e inicie:

```sh
docker compose build --pull
docker compose up -d
docker compose ps
```

## 5. Publicar pelo proxy HTTPS

No proxy que ja atende os outros sistemas da VM, encaminhe o dominio definido em `APP_ORIGIN` para:

```text
http://127.0.0.1:3000
```

O proxy precisa preservar os cabecalhos `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` e `X-Forwarded-For`. O certificado TLS deve ser valido e o acesso externo deve ocorrer somente por HTTPS.

## 6. Conferir a instalacao

```sh
curl --fail http://127.0.0.1:3000/api/health
docker compose exec importer python -m worker.run --check
docker compose logs --tail=100 web
docker compose logs --tail=100 importer
```

Resultados esperados:

- saude do painel: `{"ok":true}`;
- importador: mensagem `Importer connected` sem erro de banco ou fila;
- `docker compose ps`: os dois servicos em execucao e saudaveis.

Envie um lote pequeno pelo painel e acompanhe:

```sh
docker compose logs -f importer
```

Depois de confirmar o processamento, encerre com `Ctrl+C`; isso fecha somente a visualizacao dos logs, nao o importador.

## 7. Operacao diaria

Os containers iniciam com a VM e reiniciam automaticamente em caso de falha. Comandos uteis:

```sh
# Situacao
docker compose ps

# Logs recentes
docker compose logs --tail=200

# Reiniciar somente o importador
docker compose restart importer

# Parar toda a aplicacao
docker compose down

# Iniciar novamente
docker compose up -d
```

## 8. Atualizar a aplicacao

Antes da atualizacao, confira se existe nova migration e faca backup do Supabase. Depois:

```sh
cd /opt/central-vendas/app
git pull --ff-only
docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps
curl --fail http://127.0.0.1:3000/api/health
```

O `.env` nao e substituido pelo Git. Nao use `docker compose down -v`; a instalacao nao precisa de volumes e esse parametro pode afetar outros arquivos caso a configuracao seja alterada no futuro.

## 9. Seguranca e backup

- nunca versionar `.env`, senhas, chaves ou URLs com credenciais;
- permitir acesso SSH somente aos administradores;
- manter Docker e o sistema operacional atualizados;
- usar usuarios PostgreSQL separados para painel e importador;
- manter backups e recuperacao pontual do Supabase habilitados conforme a politica da empresa;
- revisar periodicamente os logs sem copiar segredos para chamados ou mensagens.

Se o importador ficar indisponivel, os arquivos permanecem na fila e serao processados quando o container voltar. O painel continua mostrando a ultima carga valida.
