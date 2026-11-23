"""Read the original IXC, CRM and Life Tracker exports as tabular values."""
from collections import defaultdict
from io import BytesIO
from pathlib import PurePath
from zipfile import ZipFile, is_zipfile
from dataclasses import dataclass
from decimal import Decimal
import re

import defusedxml  # Enable hardened XML parsing in openpyxl.
from lxml import html
from openpyxl import load_workbook
import pdfplumber
import xlrd

from .values import day, decimal, norm


class ReportError(ValueError):
    pass


@dataclass
class Table:
    headers: list[str]
    rows: list[tuple[int, dict]]
    window: tuple | None = None


def as_table(header, rows, window=None):
    names = [norm(value) for value in header]
    values = []
    for row_number, row in rows:
        if any(cell not in (None, "") for cell in row):
            values.append((row_number, {k: v for k, v in zip(names, row) if k}))
        if len(values) > 150_000:
            raise ReportError("O relatório ultrapassa 150 mil registros por arquivo.")
    return Table(names, values, window)


def read_excel(data):
    if is_zipfile(BytesIO(data)):
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 5000 or sum(e.file_size for e in entries) > 250 * 1024**2:
                raise ReportError("A estrutura interna da planilha é maior que o limite de leitura.")
        workbook = load_workbook(BytesIO(data), read_only=True, data_only=True, keep_links=False)
        try:
            for sheet in workbook:
                sheet.reset_dimensions()
                rows = iter(sheet.values)
                header = next(rows, None)
                if header and sum(bool(c) for c in header) >= 2:
                    return as_table(header, enumerate(rows, 2))
        finally:
            workbook.close()
        raise ReportError("A planilha está sem cabeçalho.")
    if data.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
        book = xlrd.open_workbook(file_contents=data, on_demand=True)
        try:
            sheet = book.sheet_by_index(0)
            def row(i):
                return [
                    xlrd.xldate_as_datetime(cell.value, book.datemode)
                    if cell.ctype == xlrd.XL_CELL_DATE else cell.value
                    for cell in sheet.row(i)
                ]
            return as_table(row(0), ((i + 1, row(i)) for i in range(1, sheet.nrows)))
        finally:
            book.release_resources()
    if re.search(rb"<(?:html|table|!doctype)\b", data[:4096], re.I):
        try:
            source = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            source = data.decode("cp1252", errors="replace")
        tree = html.fromstring(source, parser=html.HTMLParser(no_network=True))
        table = tree.xpath("descendant-or-self::table")
        if table:
            rows = table[0].xpath("./tr|./thead/tr|./tbody/tr|./tfoot/tr")
            cells = lambda r: [" ".join(c.text_content().split()) for c in r.xpath("./th|./td")]
            if rows:
                return as_table(cells(rows[0]), ((i, cells(r)) for i, r in enumerate(rows[1:], 2)))
    raise ReportError("Formato não reconhecido. Envie .xlsx, .xls ou o PDF de alterações do IXC.")


def read_alterations_pdf(document):
    result = []
    window = None
    recognized = False
    total = None
    headers = ["Contrato", "Data alteração", "Tipo alt.", "Vendedor", "Valor anterior",
               "Valor novo", "Diferença", "Plano anterior", "Plano novo"]
    if len(document.pages) > 150:
        raise ReportError("O PDF de alterações ultrapassa 150 páginas.")
    for page in document.pages:
        page_text = page.extract_text() or ""
        recognized |= "RELATORIO DE ALTERACOES DE CONTRATO" in norm(page_text)
        count = re.search(r"Total de altera[çc][õo]es:\s*([\d.]+)", page_text, re.I)
        if count:
            total = int(count.group(1).replace(".", ""))
        if not window:
            found = re.search(r"De:\s*(\d{2}/\d{2}/\d{4})(?:\s+At[eé]:\s*(\d{2}/\d{2}/\d{4}))?", page_text, re.I)
            window = found.groups() if found else None
        by_line = defaultdict(list)
        page_words = page.extract_words(x_tolerance=1, y_tolerance=1)
        for word in page_words:
            by_line[round(word["top"], 1)].append(word)
        header = next((line for line in by_line.values()
            if {"CONTRATO", "DATA", "TIPO", "VENDEDOR", "DIFERENCA"} <= {norm(w["text"]) for w in line}), None)
        if header is None:
            continue
        anchors = []
        for label in ("CONTRATO", "DATA", "TIPO", "VENDEDOR", "VALOR", "DIFERENCA", "PLANO", "COBRANCA"):
            anchors.extend(w["x0"] for w in header if norm(w["text"]) == label)
        anchors = sorted(anchors)
        # Contrato, data, tipo, vendedor, dois valores, diferença, dois planos e duas cobranças.
        if len(anchors) != 11:
            continue
        # IXC aligns data inside the header bands (and shrinks long names).  The
        # offsets below follow the actual left edges of those bands, not the
        # midpoint between header labels, so a long seller/plan is not cut.
        offsets = (-12,-3,-16,-12,-6,-6,-5,-22,-26,-13)
        bounds = [a+offset for a,offset in zip(anchors[:10],offsets)] + [page.width]
        for _, line in sorted(by_line.items()):
            fields = [" ".join(word["text"] for word in line if lo <= word["x0"] < hi)
                      for lo,hi in zip(bounds,bounds[1:])]
            if re.fullmatch(r"\d+", fields[0]) and day(fields[1]):
                result.append(tuple(fields[:9]))
    if window and window[1] is None and result:
        latest = max(day(row[1]) for row in result if day(row[1]))
        window = (window[0], latest)
    if not recognized or not window or (total is not None and len(result) != total):
        raise ReportError("Não foi possível conferir a estrutura do PDF de alterações do IXC.")
    return as_table(headers, enumerate(result, 1), window)


def read_contract_details_pdf(document):
    header = ("ID CLIENTE", "CLIENTE", "ID CONTRATO", "CONTRATO", "ATIVACAO", "RENOVACAO", "VALOR TOTAL CONTRATO")
    columns = "ID CLIENTE ID CONTRATO ATIVACAO RENOVACAO VALOR"
    rows, count, total = [], None, None
    for page in document.pages:
        lines = page.extract_text_lines(return_chars=False)
        page_text = " ".join(line["text"] for line in lines)
        footer = re.search(r"Totais:\s+Contratos:\s+([\d.]+)\s+Valor:\s+([\d.,-]+)", page_text, re.I)
        if footer:
            count = int(footer[1].replace(".", ""))
            total = decimal(footer[2])
        header_line = next((line for line in lines if norm(line["text"]) == columns), None)
        if header_line is None:
            raise ReportError("Cabeçalho de contratos detalhados ausente em uma das páginas.")
        words = page.extract_words(x_tolerance=1, y_tolerance=1)
        column_positions = [word["x0"] for word in words if abs(word["top"]-header_line["top"]) < 1]
        if len(column_positions) != len(header):
            raise ReportError("Colunas do PDF de contratos detalhados não reconhecidas.")
        left, client, contract_id, description, activation, renewal, value = column_positions
        bounds = [left-13, client-3, contract_id-15, description-3, activation-3, renewal-3, value-35, page.width]
        groups = defaultdict(list)
        for word in words:
            if word["top"] > header_line["bottom"]:
                groups[round(word["top"], 1)].append(word)
        for _, group in sorted(groups.items()):
            fields = [" ".join(w["text"] for w in group if lo <= w["x0"] < hi)
                      for lo, hi in zip(bounds, bounds[1:])]
            if not fields[0].isdigit():
                continue
            if not (fields[2].isdigit() and day(fields[4]) and (not fields[5] or day(fields[5]))
                    and decimal(fields[6]) is not None):
                raise ReportError("Uma linha do PDF de contratos detalhados não pôde ser validada.")
            rows.append(fields)
    if count != len(rows) or total is None or sum(Decimal(decimal(row[6])) for row in rows) != Decimal(total):
        raise ReportError("A quantidade ou o valor dos contratos difere do total informado no PDF.")
    return as_table(header, enumerate(rows, 1))


def read_contract_values_pdf(document):
    header = ("ID CLIENTE", "CLIENTE", "PLANO RELATORIO", "ATIVACAO", "RENOVACAO",
              "VALOR MENSAL RELATORIO", "VENDEDOR", "TAXA INSTALACAO")
    rows, expected_count, expected_total = [], None, None
    for page in document.pages:
        lines = page.extract_text_lines(return_chars=False)
        title = next((line for line in lines if "VLR LIQ (MENS)" in norm(line["text"])
                      and "VENDEDOR" in norm(line["text"])), None)
        if title is None:
            raise ReportError("Cabeçalho do relatório de contratos com vendedor ausente.")
        words = page.extract_words(x_tolerance=1, y_tolerance=1)
        header_words = [word for word in words if abs(word["top"]-title["top"]) < 1]
        anchor = lambda label: next(word["x0"] for word in header_words if norm(word["text"]) == label)
        date_start, renewal, identifier, client = (anchor(label) for label in ("ATIVACAO", "RENOVACAO", "ID", "CLIENTE"))
        plan, value, seller, fee, terms = (anchor(label) for label in ("PLANO", "VLR", "VENDEDOR", "TAXA", "CONDICOES"))
        groups = defaultdict(list)
        for word in words:
            if word["top"] > title["bottom"]:
                groups[round(word["top"], 1)].append(word)
        for _, group in sorted(groups.items()):
            text = " ".join(word["text"] for word in group)
            footer = re.search(r"Totais:\s+Contratos:\s+([\d.]+)\s+([\d.,-]+)", text, re.I)
            if footer:
                expected_count = int(footer[1].replace(".", ""))
                expected_total = decimal(footer[2])
            get = lambda a, b: " ".join(word["text"] for word in group if a <= word["x0"] < b)
            client_id = get(identifier-10, client-3)
            if not client_id.isdigit():
                continue
            activated, renewed = get(date_start-5,renewal-3), get(renewal-3,identifier-10)
            monthly, installation = get(value-3,seller-3), get(fee-3,terms-3)
            if ((activated and not day(activated)) or (renewed and not day(renewed))
                    or decimal(monthly) is None or decimal(installation) is None):
                raise ReportError("Data ou valor inválido no relatório de contratos com vendedor.")
            rows.append((client_id,get(client-3,plan-3),get(plan-3,value-3),
                         activated,renewed,monthly,get(seller-3,fee-3),installation))
    if expected_count != len(rows) or expected_total is None or sum(Decimal(decimal(row[5])) for row in rows) != Decimal(expected_total):
        raise ReportError("Quantidade ou valor mensal difere dos totalizadores do relatório com vendedor.")
    return as_table(header, enumerate(rows, 1))


def read_table(filename, data):
    if PurePath(filename).suffix.lower() == ".pdf" or data.startswith(b"%PDF-"):
        with pdfplumber.open(BytesIO(data)) as document:
            if not document.pages or len(document.pages) > 150:
                raise ReportError("O PDF deve conter entre 1 e 150 páginas.")
            first_page = norm(document.pages[0].extract_text())
            if "VLR LIQ (MENS)" in first_page and "VENDEDOR" in first_page and "PLANO DE VENDA" in first_page:
                return read_contract_values_pdf(document)
            if "RELATORIO DETALHADO" in first_page and "ID CLIENTE ID CONTRATO ATIVACAO RENOVACAO VALOR" in first_page:
                return read_contract_details_pdf(document)
            if "RELATORIO DE ALTERACOES DE CONTRATO" in first_page:
                return read_alterations_pdf(document)
            raise ReportError("Modelo de PDF não reconhecido. Envie o relatório de contratos detalhados, com vendedor ou de alterações do IXC.")
    return read_excel(data)
