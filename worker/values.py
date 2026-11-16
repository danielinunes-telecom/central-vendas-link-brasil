from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re
import unicodedata


def norm(value):
    raw = unicodedata.normalize("NFKD", text(value))
    raw = "".join(char for char in raw if not unicodedata.combining(char))
    return " ".join(raw.upper().split())


def text(value):
    return "" if value is None else str(value).strip()


def ident(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == int(value):
        value = str(int(value))
    value = str(value).strip()
    if re.fullmatch(r"\d+\.0+", value):
        value = value.split(".")[0]
    if value.isdigit():
        value = value.lstrip("0") or "0"
    return None if value in {"", "0", "-"} else value


def decimal(value):
    if value is None or value == "":
        return None
    raw = re.sub(r"[\sR$]", "", str(value))
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        result = Decimal(raw)
        if result.is_finite() and abs(result) <= 999_999_999_999:
            return str(result.quantize(Decimal(".0001"), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        pass
    return None


def day(value):
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat() if 1990 <= value.year <= 2100 else None
    raw = text(value)
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return day(datetime.strptime(raw, fmt))
        except ValueError:
            continue
    return None

