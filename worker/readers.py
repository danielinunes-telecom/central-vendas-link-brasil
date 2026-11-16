"""Read the original IXC, CRM and Life Tracker exports as tabular values."""
from collections import defaultdict
from io import BytesIO
from pathlib import PurePath
from zipfile import ZipFile, is_zipfile
from dataclasses import dataclass
import re

import defusedxml  # Enable hardened XML parsing in openpyxl.
from lxml import html
from openpyxl import load_workbook
import pdfplumber
import xlrd

from .values import norm


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


def read_alterations_pdf(data):
    result = []
    window = None
    recognized = False
    total = None
    headers = ["Contrato", "Data alteração", "Tipo alt.", "Vendedor", "Valor anterior",
               "Valor novo", "Diferença", "Plano anterior", "Plano novo"]
    with pdfplumber.open(BytesIO(data)) as document:
        if len(document.pages) > 150:
            raise ReportError("O PDF de alterações ultrapassa 150 páginas.")
        for page in document.pages:
            page_text = page.extract_text() or ""
            recognized |= "RELATORIO DE ALTERACOES DE CONTRATO" in norm(page_text)
            count = re.search(r"Total de altera[çc][õo]es:\s*([\d.]+)", page_text, re.I)
            if count:
                total = int(count.group(1).replace(".", ""))
            if not window:
                found = re.search(r"De:\s*(\d{2}/\d{2}/\d{4})\s+At[eé]:\s*(\d{2}/\d{2}/\d{4})", page_text, re.I)
                window = found.groups() if found else None
            by_line = defaultdict(list)
            for word in page.extract_words(x_tolerance=1, y_tolerance=1):
                by_line[round(word["top"], 1)].append(word)
            for _, line in sorted(by_line.items()):
                def words(a, b):
                    return " ".join(word["text"] for word in line if a <= word["x0"] < b)
                contract, event_date = words(15, 83), words(83, 160)
                if re.fullmatch(r"\d+", contract) and re.fullmatch(r"\d{2}/\d{2}/\d{4}", event_date):
                    result.append((contract, event_date, words(160, 220), words(220, 266),
                                   words(266, 328), words(328, 397), words(397, 455),
                                   words(455, 565), words(565, 649)))
    if not recognized or not window or (total is not None and len(result) != total):
        raise ReportError("Não foi possível conferir a estrutura do PDF de alterações do IXC.")
    return as_table(headers, enumerate(result, 1), window)


def read_table(filename, data):
    if PurePath(filename).suffix.lower() == ".pdf" or data.startswith(b"%PDF-"):
        return read_alterations_pdf(data)
    return read_excel(data)

