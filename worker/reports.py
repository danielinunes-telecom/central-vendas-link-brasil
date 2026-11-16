"""Recognize source schemas independently of export filenames."""
from dataclasses import dataclass
from collections import Counter
from datetime import date
from decimal import Decimal
import hashlib
import json

from .readers import ReportError, read_table
from .values import norm, text, ident, day, decimal


@dataclass
class Record:
    key: str
    day: str | None
    data: dict
    line: int


@dataclass
class Report:
    source: str
    records: list[Record]
    issues: list[dict]
    count: int
    mode: str
    window: tuple[str, str] | None = None


def labels(row, **fields):
    return {key: text(row.get(label)) or None for key, label in fields.items()}


def keys(row, **fields):
    return {key: ident(row.get(label)) for key, label in fields.items()}


def dates(row, **fields):
    return {key: day(row.get(label)) for key, label in fields.items()}


def amounts(row, **fields):
    return {key: decimal(row.get(label)) for key, label in fields.items()}


def first(row, *columns):
    return next((row[col] for col in columns if row.get(col) not in (None, "", 0)), None)


def seller_directory(row):
    return keys(row, user_key="ID USUARIO", seller_id="ID VENDEDOR", collaborator_id="ID COLABORADOR") | labels(
        row, name="NOME"
    )


def customer(row):
    return keys(row, customer_key="ID") | labels(
        row, name="RAZAO SOCIAL", document="CNPJ/CPF", trading_name="NOME FANTASIA/SOCIAL", seller="RESPONSAVEL",
        city="CIDADE", branch="FILIAL", address="ENDERECO", address_number="NUMERO", postal="CEP"
    ) | {"active": norm(row.get("ATIVO")) == "SIM"}


def contract(row):
    return keys(row, contract_key="ID", plan_key="PLANO DE VENDA") | labels(
        row, client="CLIENTE", status="STATUS CONTRATO", access="STATUS ACESSO", description="DESCRICAO",
        seller_activation="VENDEDOR ATIVACAO", seller="VENDEDOR", seller_responsible="RESPONSAVEL/VENDEDOR",
        city="CIDADE", branch="FILIAL", cancellation_reason="MOTIVO CANCELAMENTO",
        address="ENDERECO", address_number="NUMERO", postal="CEP"
    ) | dates(row, activated="DATA ATIVACAO", cancelled="DATA CANCELAMENTO",
              expires="DATA DE EXPIRACAO", signed="DATA PRIMEIRA ASSINATURA") | {
        "client_key": ident(first(row,"ID CLIENTE","ID DO CLIENTE","CODIGO CLIENTE","CODIGO DO CLIENTE")),
        "signed_state": text(first(row,"STATUS ASSINATURA","ASSINADO")) or None,
    }


def contract_details(row):
    return keys(row, contract_key="ID CONTRATO", client_key="ID CLIENTE") | dates(
        row, activated="ATIVACAO", renewal="RENOVACAO"
    ) | amounts(row, total="VALOR TOTAL CONTRATO")


def sale(row):
    return keys(row, sale_key="ID", recurring="CONTRATO R", one_time="CONTRATO A", doc_type="TIPO DOC.") | labels(
        row, seller="VENDEDOR", client="CLIENTE", status="STATUS", branch="FILIAL"
    ) | dates(row, issued="DATA DA EMISSAO", cancelled="DATA CANCELAMENTO") | amounts(row, total="VALOR") | {
        "contract_key": ident(first(row,"CONTRATO R","CONTRATO A")),
        "client_key": ident(first(row,"ID CLIENTE","ID DO CLIENTE")),
    }


def financial(row):
    return keys(row, title_key="ID", sale_key="ID VENDA", recurring="ID CONTRATO RECORRENTE",
                one_time="ID CONTRATO AVULSO") | labels(row, client="CLIENTE", status="STATUS", city="CIDADE",
                    branch="FILIAL", proportional="PARCELA PROPORCIONAL", type="TIPO") | dates(
        row, due="VENCIMENTO", paid="DATA PAGAMENTO"
    ) | amounts(row, nominal="VALOR", balance="VALOR ABERTO", received="VALOR RECEBIDO") | {
        "contract_key": ident(first(row,"ID CONTRATO RECORRENTE","ID CONTRATO PRINCIPAL","ID CONTRATO AVULSO")),
        "client_key": ident(first(row,"ID CLIENTE","ID DO CLIENTE")),
    }


def debt(row):
    return keys(row, title_key="NO TITULO", client_key="ID DEVEDOR", installment="NO PARCELA") | labels(
        row, client="CLIENTE", city="CIDADE", creditor="CNPJ EMPRESA CREDORA"
    ) | dates(row, due="DATA VENCIMENTO") | amounts(row, balance="VALOR ABERTO")


def lead(row):
    client_value = first(row,"ID CLIENTE","ID DO CLIENTE","CLIENTE")
    return keys(row, lead_key="ID", negotiation_key="ID PROSPECCAO") | labels(
        row, name="NOME", seller="RESPONSAVEL", city="CIDADE"
    ) | dates(row, registered="DATA CADASTRO") | {
        "client_key": ident(client_value) if (ident(client_value) or "").isdigit() else None,
        "client": None if (ident(client_value) or "").isdigit() else (text(client_value) or None),
    }


def activity(row):
    raw_client = first(row, "ID CLIENTE", "ID DO CLIENTE", "CLIENTE")
    return keys(row, task_key="ID") | labels(row, seller="RESPONSAVEL", subject="ASSUNTO", type="TIPO", status="STATUS") | dates(
        row, planned="DATA/HORA INICIO", finished="DATA", end="DATA HORA FIM"
    ) | {"client_key": ident(raw_client) if (ident(raw_client) or "").isdigit() else None}


def negotiation(row):
    return keys(row, deal_key="ID") | labels(row, client="CLIENTE", contact="CONTATO", seller="RESPONSAVEL",
        status="STATUS", funnel="FUNIL", stage="ESTAGIO") | dates(row, opened="DATA INICIO", won="DATA VENCEMOS", lost="DATA PERDEMOS")


def expense(row):
    return keys(row, expense_key="ID") | labels(
        row, seller="NOME", category="CENTRO DE CUSTO", equipment="EQUIPAMENTO", vendor="FORNECEDOR",
        observation="OBSERVACAO", reason="MOTIVO", trip="VIAGEM"
    ) | dates(row, spent="DATA") | amounts(row, total="VALOR", people="PESSOAS", nights="DIARIAS")


def change(row):
    return keys(row, contract_key="CONTRATO", change_key="ID") | dates(row, changed="DATA ALTERACAO") | labels(
        row, type="TIPO ALT.", seller="VENDEDOR", old_plan="PLANO ANTERIOR", new_plan="PLANO NOVO"
    ) | amounts(row, old_value="VALOR ANTERIOR", new_value="VALOR NOVO", difference="DIFERENCA")


def band(row):
    return keys(row, band_key="ID", contract_key="ID CONTRATO", circuit="CIRCUITO") | dates(
        row, measured="DATA"
    ) | amounts(row, used="CONSUMO MBPS", capacity="CAPACIDADE MBPS") | labels(row, login="LOGIN")


def item(row):
    return keys(row, item_key="ID ITEM", contract_key="ID CONTRATO", sale_key="ID VENDA") | labels(
        row, product="PRODUTO", billing="TIPO DE COBRANCA", seller="VENDEDOR"
    ) | amounts(row, total="VALOR ITEM")


# (name, signature columns, key, event date, load strategy, transform)
SCHEMAS = (
    ("seller_directory", {"ID USUARIO","NOME","ID VENDEDOR","ID COLABORADOR"}, "user_key", None, "snapshot", seller_directory),
    ("customers", {"ID","RAZAO SOCIAL","CNPJ/CPF","RESPONSAVEL","DATA CADASTRO"}, "customer_key", None, "snapshot", customer),
    ("contract_details", {"ID CLIENTE","ID CONTRATO","ATIVACAO","RENOVACAO","VALOR TOTAL CONTRATO"}, "contract_key", None, "snapshot", contract_details),
    ("contracts", {"ID","STATUS CONTRATO","DATA ATIVACAO","PLANO DE VENDA"}, "contract_key", None, "snapshot", contract),
    ("items", {"ID CONTRATO","PRODUTO","VALOR ITEM","TIPO DE COBRANCA"}, "item_key", None, "snapshot", item),
    ("sales", {"ID","DATA DA EMISSAO","VENDEDOR","CONTRATO R","VALOR"}, "sale_key", "issued", "merge", sale),
    ("titles", {"ID","VALOR ABERTO","VALOR RECEBIDO","VENCIMENTO","ID CONTRATO RECORRENTE"}, "title_key", "due", "merge", financial),
    ("debts", {"ID DEVEDOR","NO TITULO","DATA VENCIMENTO","VALOR ABERTO"}, None, None, "snapshot", debt),
    ("leads", {"ID","LEAD VIAVEL","RESPONSAVEL","DATA CADASTRO","ID PROSPECCAO"}, "lead_key", "registered", "snapshot", lead),
    ("activities", {"ID","TIPO","ASSUNTO","RESPONSAVEL","STATUS","DATA/HORA INICIO"}, "task_key", None, "merge", activity),
    ("negotiations", {"ID","FUNIL","ESTAGIO","DATA VENCEMOS","CONTATO"}, "deal_key", "opened", "snapshot", negotiation),
    ("expenses", {"NOME","CENTRO DE CUSTO","DATA","EQUIPAMENTO","VALOR"}, "expense_key", "spent", "period", expense),
    ("changes", {"CONTRATO","DATA ALTERACAO","TIPO ALT.","VALOR ANTERIOR","VALOR NOVO","DIFERENCA"}, "change_key", "changed", "period", change),
    ("band", {"DATA","CONSUMO MBPS","CAPACIDADE MBPS"}, "band_key", "measured", "merge", band),
)


def stable_key(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:32]


def parse_report(name, data, observed_on):
    table = read_table(name, data)
    schema = next((s for s in SCHEMAS if s[1] <= set(table.headers)), None)
    if schema is None:
        raise ReportError("Cabeçalhos não reconhecidos. Use o relatório original exportado.")
    source, _, key_field, event_field, mode, transform = schema
    if source == "titles" and "CONTAS A RECEBER" in norm(name) and not any(
        norm(row.get("STATUS")) != "RECEBIDO" for _, row in table.rows
    ):
        source, event_field = "payments", "paid"
    if source == "titles" and not any(
        norm(row.get("STATUS")) == "RECEBIDO" for _, row in table.rows
    ):
        source, mode = "open_titles", "snapshot"
    issues, result, counts, seen = [], [], Counter(), {}
    for line, raw in table.rows:
        values = transform(raw)
        if source == "activities":
            event = values["finished"] or values["end"] or values["planned"]
        else:
            event = values.get(event_field) if event_field else None
        key = values.get(key_field) if key_field else None
        required_key = key_field and source not in {"band","changes","items","expenses"}
        if required_key and key is None:
            issues.append({"line": line, "message": "Identificador de origem ausente."})
            continue
        if source == "contract_details" and not (values["client_key"] and values["activated"] and values["total"] is not None):
            issues.append({"line": line, "message": "Cliente, ativação ou valor total inválido ou ausente."})
            continue
        if source == "seller_directory" and not (values["name"] and values["collaborator_id"]):
            issues.append({"line": line, "message": "Nome ou ID de colaborador ausente."})
            continue
        if event_field and not event and source not in {"payments","leads","negotiations","sales"}:
            issues.append({"line": line, "message": "Data do registro inválida ou ausente."})
            continue
        if source == "expenses" and (event > observed_on.isoformat() or
                date.fromisoformat(event).year < observed_on.year - 2):
            issues.append({"line": line, "message": "Data de despesa fora do intervalo esperado."})
            continue
        if source == "expenses" and values["total"] is None:
            issues.append({"line": line, "message": "Valor da despesa inválido."})
            continue
        if source == "expenses" and not values["category"]:
            issues.append({"line": line, "message": "Centro de custo ausente. A despesa aparece como Sem categoria."})
        if source == "debts" and (not values["title_key"] or not values["client_key"]
                or not values["due"] or values["balance"] is None):
            issues.append({"line": line, "message": "Título, devedor, vencimento ou saldo inválido em inadimplência."})
            continue
        if source == "band" and (not (values["contract_key"] or values["circuit"] or values["login"])
                or values["capacity"] is None or values["used"] is None
                or Decimal(values["capacity"]) <= 0 or Decimal(values["used"]) < 0):
            issues.append({"line": line, "message": "Circuito, capacidade ou consumo inválido."})
            continue
        if source in {"changes","items"} and not values["contract_key"]:
            issues.append({"line": line, "message": "Contrato do registro ausente."})
            continue
        if source == "items" and (not values["product"] or values["total"] is None):
            issues.append({"line": line, "message": "Produto ou valor por item ausente."})
            continue
        if not key:
            if source == "debts":
                key = ":".join(values[field] or "?" for field in ("creditor","title_key","installment"))
            elif source == "band":
                key = stable_key([values["contract_key"],values["circuit"],values["login"],event])
            else:
                hash_key = stable_key(values)
                counts[hash_key] += 1
                key = f"{hash_key}:{counts[hash_key]}"
        record = Record(key, event, values, line)
        if key in seen:
            if seen[key].data != values:
                raise ReportError(f"Linha {line}: identificador repetido com dados diferentes.")
            issues.append({"line": line, "message": "Registro idêntico com o mesmo ID, contado uma vez."})
            continue
        seen[key] = record
        result.append(record)
    if table.rows and not result:
        raise ReportError("Todas as linhas falharam na validação. A última carga válida foi preservada.")
    window = tuple(day(v) for v in table.window) if table.window else None
    if mode == "period" and not window:
        event_days = [r.day for r in result if r.day]
        if source == "expenses":
            first_this_month = observed_on.replace(day=1)
            first_previous_month = date.fromordinal(first_this_month.toordinal()-1).replace(day=1).isoformat()
            window = (min(first_previous_month, *event_days) if event_days else first_previous_month,
                      observed_on.isoformat())
        elif event_days:
            window = (date.fromisoformat(min(event_days)).replace(day=1).isoformat(),max(event_days))
    if source == "activities":
        first_this_month = observed_on.replace(day=1)
        first_previous_month = date.fromordinal(first_this_month.toordinal()-1).replace(day=1).isoformat()
        window = (first_previous_month, observed_on.isoformat())
    return Report(source, result, issues, len(table.rows), mode, window)

