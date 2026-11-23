"""Process the import queue. Hosted originals are read from a private bucket."""
import argparse
from datetime import date
import hashlib
import logging
import os
import signal
from threading import Event
from pathlib import Path
from urllib.parse import quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .ingest import apply_report, refresh
from .readers import ReportError
from .reports import parse_report

MAX_BYTES = 25 * 1024**2
ORDER = ("seller_directory","customers","contracts","contract_links","contract_details","contract_values","items","sales","titles","open_titles","payments",
         "debts","leads","negotiations","activities","changes","expenses","band","cancellation_orders")


def original(key):
    local = os.environ.get("IMPORT_LOCAL_PATH")
    if local:
        base = Path(local).resolve()
        path = (base / key).resolve()
        if base not in path.parents:
            raise ReportError("Origem do arquivo inválida.")
        return path.read_bytes()
    url = os.environ["SUPABASE_URL"].rstrip("/")
    bucket = os.environ.get("IMPORT_BUCKET","link-brasil-importacoes")
    secret = os.environ["SUPABASE_SERVER_KEY"]
    headers = {"apikey": secret}
    if secret.count(".") == 2:
        headers["Authorization"] = f"Bearer {secret}"
    req = Request(f"{url}/storage/v1/object/authenticated/{quote(bucket)}/{quote(key)}",headers=headers)
    with urlopen(req, timeout=45) as response:
        return response.read(MAX_BYTES + 1)


def mark_file(conn, file_id, state, *, source=None, read=0, applied=0, issues=(), error=None):
    conn.execute("""update comercial.import_files set status=%s,source=%s,rows_read=%s,rows_applied=%s,issues=%s,error=%s
        where id=%s""", (state,source,read,applied,Jsonb(list(issues)[:500]),error,file_id))


def handle(conn, batch_id):
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(211687)")
        observed, state, base_code = conn.execute("select observed_on,status,base_code from comercial.import_batches where id=%s", (batch_id,)).fetchone()
        if state in {"complete","partial","failed"}:
            return
        files = conn.execute("""select id,name,object_key,sha256 from comercial.import_files
            where batch_id=%s and status='queued' order by name""", (batch_id,)).fetchall()
        ready = []
        for file_id, name, key, checksum in files:
            try:
                data = original(key)
            except FileNotFoundError:
                mark_file(conn,file_id,"failed",error="O arquivo original está indisponível. Anexe-o novamente.")
                continue
            except HTTPError as err:
                if err.code != 404:
                    raise
                mark_file(conn,file_id,"failed",error="O arquivo original está indisponível. Anexe-o novamente.")
                continue
            try:
                if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != checksum:
                    raise ReportError("O arquivo está incompleto ou mudou desde o envio. Anexe-o novamente.")
                report = parse_report(name,data,observed)
                if base_code == "old" and report.source in {"leads", "negotiations", "activities"}:
                    raise ReportError("Leads, negociações e atividades devem ser enviados na Base Nova.")
                ready.append((report,file_id,checksum))
            except ReportError as err:
                mark_file(conn,file_id,"failed",error=str(err))
            except (OSError, ValueError, KeyError, IndexError, TypeError):
                mark_file(conn,file_id,"failed",error="Não foi possível ler o arquivo original. Verifique se abre no sistema de origem.")
            except Exception:
                logging.exception("Could not read import file %s", file_id)
                mark_file(conn,file_id,"failed",error="Não foi possível ler a estrutura do arquivo.")
        by_source = {}
        for report,file_id,checksum in ready:
            by_source.setdefault(report.source,[]).append((report,file_id,checksum))
        for source in ORDER:
            candidates = by_source.get(source,[])
            if not candidates:
                continue
            if len({checksum for _,_,checksum in candidates}) > 1:
                for report,file_id,_ in candidates:
                    mark_file(conn,file_id,"failed",source=source,read=report.count,
                        error="Foram enviados arquivos diferentes da mesma fonte. Envie a extração completa mais recente em um único arquivo.")
                continue
            for report,file_id,checksum in candidates:
                try:
                    with conn.transaction():
                        applied, status = apply_report(conn,report,file_id,observed,checksum,base_code)
                        mark_file(conn,file_id,status,source=source,read=report.count,
                                  applied=applied,issues=report.issues)
                except (ValueError, psycopg.DataError) as err:
                    reason = str(err) if isinstance(err,ValueError) else "Algum valor da extração está fora do formato esperado."
                    mark_file(conn,file_id,"failed",source=source,read=report.count,error=reason)

        states = conn.execute("""select count(*) filter(where status='failed'),count(*) filter(where status in ('applied','unchanged')),
          count(*) filter(where jsonb_array_length(issues)>0) from comercial.import_files where batch_id=%s""",(batch_id,)).fetchone()
        bad, good, warnings = states
        if good:
            day = conn.execute("select max(observed_on) from comercial.source_loads").fetchone()[0]
            refresh(conn,day)
        batch_state = "partial" if good and (bad or warnings) else ("complete" if good else "failed")
        conn.execute("""update comercial.import_batches set status=%s,finished_at=now(),lease_until=null,error=null where id=%s""",
                     (batch_state,batch_id))


def claim(conn, mode):
    with conn.transaction():
        if mode == "pgmq":
            message = conn.execute("select msg_id,message from pgmq.read('lb_imports',900,1)").fetchone()
            if message is None:
                return None
            msg_id, content = message
            batch = content["batch"]
            row = conn.execute("""update comercial.import_batches set status='processing',attempt=attempt+1,
                lease_until=now()+interval '15 min'
                where id=%s and (status='queued' or (status='processing' and lease_until<=now()))
                returning attempt""",(batch,)).fetchone()
            if row is None:
                state = conn.execute("select status from comercial.import_batches where id=%s",(batch,)).fetchone()
                if state is None or state[0] in {"complete","partial","failed"}:
                    conn.execute("select pgmq.archive('lb_imports',%s)",(msg_id,))
                return None
            return batch,msg_id,row[0]
        row = conn.execute("""with job as (
            select id from comercial.import_batches
            where (status='queued' and available_at<=now()) or (status='processing' and lease_until<=now())
            order by submitted_at for update skip locked limit 1
            ) update comercial.import_batches b set status='processing',attempt=b.attempt+1,
              lease_until=now()+interval '15 min' from job where b.id=job.id returning b.id,b.attempt""").fetchone()
        return (row[0],None,row[1]) if row else None


def poll(conn, mode):
    job = claim(conn,mode)
    if not job:
        return False
    batch, message, attempt = job
    try:
        handle(conn,batch)
    except Exception:
        logging.exception("Import processing failed for %s (attempt %s)",batch,attempt)
        with conn.transaction():
            if attempt >= 3:
                conn.execute("""update comercial.import_batches set status='failed',finished_at=now(),
                    error='A carga falhou após três tentativas. Os dados da última carga válida foram preservados.'
                    where id=%s""",(batch,))
                conn.execute("""update comercial.import_files set status='failed',
                    error='O processamento do lote foi interrompido.' where batch_id=%s and status='queued'""",(batch,))
            else:
                conn.execute("""update comercial.import_batches set status='queued',lease_until=null,available_at=now()+interval '15 seconds'
                    where id=%s""",(batch,))
                if mode=="pgmq":
                    conn.execute("select pgmq.send('lb_imports',%s,15)",(Jsonb({"batch":str(batch)}),))
            if message is not None:
                conn.execute("select pgmq.archive('lb_imports',%s)",(message,))
        return True
    if message is not None:
        conn.execute("select pgmq.archive('lb_imports',%s)",(message,))
    logging.info("Processed import %s",batch)
    return True


def cli_import(conn, paths, observed, base_code='legacy'):
    base = Path(os.environ["IMPORT_LOCAL_PATH"])
    batch = uuid4()
    with conn.transaction():
        conn.execute("insert into comercial.import_batches(id,submitted_by,observed_on,base_code) values(%s,%s,%s,%s)",
                     (batch,"local@linkbrasil.test",observed,base_code))
        for path in paths:
            data = path.read_bytes()
            key = f"{batch}/{uuid4()}{path.suffix.lower()}"
            out = base / key
            out.parent.mkdir(parents=True,exist_ok=True)
            out.write_bytes(data)
            conn.execute("""insert into comercial.import_files(batch_id,name,object_key,bytes,sha256)
                values(%s,%s,%s,%s,%s)""",(batch,path.name,key,len(data),hashlib.sha256(data).hexdigest()))
    handle(conn,batch)
    print(batch)


def configuration_error(mode):
    required = ["DATABASE_URL"]
    if not os.environ.get("IMPORT_LOCAL_PATH"):
        required += ["SUPABASE_URL", "SUPABASE_SERVER_KEY"]
    missing = [key for key in required if not os.environ.get(key, "").strip()]
    if missing:
        return "Configure as variáveis do importador: " + ", ".join(missing)
    if mode not in {"pgmq", "local"}:
        return "IMPORT_QUEUE deve ser pgmq ou local."
    return None


def queue_status(conn, mode):
    if mode == "pgmq" and not conn.execute(
        "select exists(select from pgmq.list_queues() where queue_name='lb_imports')"
    ).fetchone()[0]:
        raise RuntimeError("Fila lb_imports ausente. Execute db/supabase.sql no Supabase.")
    rows = conn.execute("""select status,count(*) from comercial.import_batches
        where status in ('queued','processing','failed') group by status""").fetchall()
    counts = dict(rows)
    latest = conn.execute("select max(loaded_at) from comercial.source_loads").fetchone()[0]
    logging.info("Importer connected: queued=%s processing=%s failed=%s last_load=%s",
        counts.get("queued",0),counts.get("processing",0),counts.get("failed",0),latest or "none")


def run_queue(conn, mode, once, stopping):
    while not stopping.is_set():
        worked = poll(conn,mode)
        if once:
            return
        if not worked:
            stopping.wait(2)


def main():
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--once",action="store_true")
    parser.add_argument("--check",action="store_true",help="Conferir configuração, banco e fila sem processar arquivos")
    parser.add_argument("--base",choices=("old","new","legacy"),default="legacy")
    parser.add_argument("--observed",type=date.fromisoformat)
    parser.add_argument("--load",nargs="+",type=Path)
    args=parser.parse_args()
    mode = os.environ.get("IMPORT_QUEUE","pgmq")
    problem = configuration_error(mode)
    if problem:
        parser.error(problem)
    stopping = Event()
    def stop(signum, frame):
        logging.info("Shutdown requested; finishing the current import before exiting")
        stopping.set()
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    logging.info("Starting importer; queue=%s",mode)
    while not stopping.is_set():
        try:
            with psycopg.connect(os.environ["DATABASE_URL"],autocommit=True,connect_timeout=10) as conn:
                queue_status(conn,mode)
                if args.check:
                    return
                if args.load:
                    cli_import(conn,args.load,args.observed or date.today(),args.base)
                    return
                run_queue(conn,mode,args.once,stopping)
                return
        except psycopg.OperationalError as err:
            if args.once or args.load or args.check:
                raise
            logging.warning("Database unavailable; retrying in 5 seconds (sqlstate=%s)",err.sqlstate or "connection")
            stopping.wait(5)
    logging.info("Importer stopped")


if __name__ == "__main__":
    main()
