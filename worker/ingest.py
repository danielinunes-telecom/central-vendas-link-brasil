from datetime import date
from psycopg.types.json import Jsonb


def apply_report(conn, report, file_id, observed_on, checksum, base_code='legacy'):
    """Version a validated source atomically and keep the input row reference."""
    source = report.source
    latest = conn.execute(
        """select s.sha256,s.observed_on,b.submission_order from comercial.source_loads s
           join comercial.import_files f on f.id=s.file_id
           join comercial.import_batches b on b.id=f.batch_id where s.base_code=%s and s.source=%s for update of s""", (base_code, source)
    ).fetchone()
    if latest:
        sequence = conn.execute("""select b.submission_order from comercial.import_batches b
            join comercial.import_files f on f.batch_id=b.id where f.id=%s""", (file_id,)).fetchone()[0]
        if (observed_on, sequence) < (latest[1], latest[2]):
            raise ValueError("Já existe uma carga mais recente para essa fonte.")
    conn.execute("""create temporary table if not exists lb_import
        (external_key text primary key,event_day date,payload jsonb,row_number integer) on commit drop""")
    conn.execute("truncate lb_import")
    with conn.cursor().copy("copy lb_import (external_key,event_day,payload,row_number) from stdin") as copy:
        for row in report.records:
            copy.write_row((row.key, row.day, Jsonb(row.data), row.line))

    scope = report.window or (None, None)
    conn.execute("""insert into comercial.source_observations(base_code,source,observed_on,file_id,scope_start,scope_end)
        values(%s,%s,%s,%s,%s,%s)
        on conflict(base_code,source,observed_on) do update set file_id=excluded.file_id,
            scope_start=excluded.scope_start,scope_end=excluded.scope_end""", (base_code, source, observed_on, file_id, *scope))
    if latest and latest[0] == checksum:
        conn.execute("update comercial.source_loads set file_id=%s,observed_on=%s,loaded_at=now() where base_code=%s and source=%s",
                     (file_id, observed_on, base_code, source))
        return 0, "unchanged"

    # A report with rejected rows can still contribute valid records. Preserve prior
    # entries omitted from that report until a complete, valid position arrives.
    loss = any("ausente" in issue["message"] or "inválid" in issue["message"] or
               "intervalo esperado" in issue["message"] for issue in report.issues
               if "Centro de custo" not in issue["message"])
    remove_scope = "false"
    params = [base_code, source, observed_on, observed_on]
    if not loss and report.mode == "snapshot":
        remove_scope = "true"
    elif not loss and report.mode == "period" and all(scope):
        remove_scope = "r.event_day between %s::date and %s::date"
        params.extend(scope)
    missing = f"(({remove_scope}) and not exists (select from lb_import i where i.external_key=r.external_key))"
    conn.execute(f"""delete from comercial.records r
        where r.base_code=%s and r.source=%s and r.valid_until is null and r.valid_from=%s and r.valid_from <= %s and {missing}""", params)
    conn.execute(f"""update comercial.records r set valid_until=%s
        where r.base_code=%s and r.source=%s and r.valid_until is null and r.valid_from < %s and r.valid_from <= %s and {missing}""",
        [observed_on, *params])

    conn.execute("""update comercial.records r set valid_until=%s
        from lb_import i where r.base_code=%s and r.source=%s and r.external_key=i.external_key and r.valid_until is null
          and r.valid_from < %s and (r.payload,r.event_day) is distinct from (i.payload,i.event_day)""",
        (observed_on, base_code, source, observed_on))
    applied = conn.execute("""insert into comercial.records(base_code,source,external_key,valid_from,event_day,payload,file_id,row_number)
        select %s,%s,i.external_key,%s,i.event_day,i.payload,%s,i.row_number
        from lb_import i where not exists(
          select from comercial.records r where r.base_code=%s and r.source=%s and r.external_key=i.external_key
          and r.valid_until is null and (r.payload,r.event_day) is not distinct from (i.payload,i.event_day))
        on conflict(base_code,source,external_key,valid_from) do update
        set event_day=excluded.event_day,payload=excluded.payload,file_id=excluded.file_id,
          row_number=excluded.row_number,valid_until=null""", (base_code, source, observed_on, file_id, base_code, source)).rowcount
    conn.execute("""insert into comercial.source_loads(base_code,source,file_id,sha256,observed_on,rows_loaded)
        values(%s,%s,%s,%s,%s,(select count(*) from comercial.records where base_code=%s and source=%s and valid_until is null))
        on conflict(base_code,source) do update set file_id=excluded.file_id,sha256=excluded.sha256,
          observed_on=excluded.observed_on,rows_loaded=excluded.rows_loaded,loaded_at=now()""",
        (base_code, source, file_id, checksum, observed_on, base_code, source))
    return applied, "applied"


def refresh(conn, day: date):
    conn.execute("select comercial.refresh_all(%s)", (day,))

