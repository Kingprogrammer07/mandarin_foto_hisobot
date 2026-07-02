"""Excel exports for report views."""
from __future__ import annotations

import re
from copy import copy
from io import BytesIO

from . import config, db

TEMPLATE = config.BASE_DIR / "M232 KARGOLARGA TARQATISH.xlsx"


def _safe_sheet_name(name: str) -> str:
    name = re.sub(r"[\[\]:*?/\\]", " ", (name or "Hisobot")).strip()
    return (name[:31] or "Hisobot")


def _safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", (name or "Hisobot")).strip()
    name = re.sub(r"\s+", " ", name)
    return f"{name or 'Hisobot'} KARGOLARGA TARQATISH.xlsx"


def _num(v) -> float:
    try:
        return round(float(v or 0), 4)
    except (TypeError, ValueError):
        return 0.0


def _formula_num(v) -> str:
    return f"{_num(v):.10g}"


def _entry_value(entry: dict):
    weight = _num(entry.get("weight"))
    coef = _num(entry.get("coefficient"))
    if coef > 0:
        return f"={_formula_num(weight)}-{_formula_num(coef)}"
    return _num(entry.get("net"))


def build_kargo_excel(report_id: int) -> tuple[bytes, str]:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    report_name = db.report_name(report_id) or "Hisobot"
    entries = list(reversed(db.list_entries(report_id, "reys", limit=2000)))

    grouped: dict[str, list[dict]] = {}
    custom_types: list[str] = []
    default_set = set(db.DEFAULT_TYPES)
    for entry in entries:
        tovar_turi = str(entry.get("tovar_turi") or "").strip()
        if not tovar_turi:
            continue
        grouped.setdefault(tovar_turi, []).append(entry)
        if tovar_turi not in default_set and tovar_turi not in custom_types:
            custom_types.append(tovar_turi)

    if TEMPLATE.exists():
        wb = load_workbook(TEMPLATE)
    else:
        wb = Workbook()
        ws0 = wb.active
        thin = Side(style="thin", color="000000")
        border = Border(left=thin, right=thin, top=thin, bottom=thin)
        for r, tovar_turi in enumerate(db.DEFAULT_TYPES, start=1):
            ws0.cell(r, 1).value = tovar_turi
            ws0.cell(r, 1).fill = PatternFill("solid", fgColor="FFFF00")
            ws0.cell(r, 1).font = Font(bold=True)
            ws0.cell(r, 1).alignment = Alignment(horizontal="center", vertical="center")
            ws0.cell(r, 1).border = border
            ws0.cell(r, 2).number_format = "0.00"
            ws0.cell(r, 2).border = border
        ws0.column_dimensions["A"].width = 18
        for col in range(2, 30):
            ws0.column_dimensions[get_column_letter(col)].width = 12

    ws = wb.active
    ws.title = _safe_sheet_name(report_name)

    label_style = copy(ws["A1"]._style)
    custom_label_style = copy(ws["A13"]._style if ws["A13"].has_style else ws["A1"]._style)
    value_style = copy(ws["B1"]._style)
    blank_style = copy(ws["K1"]._style)
    label_fill = copy(ws["A1"].fill)
    value_num_format = ws["B1"].number_format

    types = list(db.DEFAULT_TYPES)
    data_rows: list[tuple[int, str, bool]] = []
    row = 1
    for tovar_turi in types:
        data_rows.append((row, tovar_turi, False))
        row += 1
    if custom_types:
        row += 1
        for tovar_turi in custom_types:
            data_rows.append((row, tovar_turi, True))
            row += 1

    max_entries = max([len(grouped.get(t, [])) for _, t, _ in data_rows] + [1])
    max_col = max(2, 1 + max_entries)
    total_start = (data_rows[-1][0] if data_rows else 1) + 6
    total_end = total_start + len(data_rows) - 1
    clear_rows = max(ws.max_row, total_end)
    clear_cols = max(ws.max_column, max_col)

    for clear_row in range(1, clear_rows + 1):
        for clear_col in range(1, clear_cols + 1):
            cell = ws.cell(clear_row, clear_col)
            cell.value = None
            cell._style = copy(blank_style)

    data_row_by_type: dict[str, int] = {}
    for data_row, tovar_turi, is_custom in data_rows:
        data_row_by_type[tovar_turi] = data_row
        cell = ws.cell(data_row, 1)
        cell.value = tovar_turi
        cell._style = copy(custom_label_style if is_custom else label_style)
        cell.fill = copy(label_fill)
        for idx, entry in enumerate(grouped.get(tovar_turi, []), start=2):
            val_cell = ws.cell(data_row, idx)
            val_cell.value = _entry_value(entry)
            val_cell._style = copy(value_style)
            val_cell.number_format = value_num_format

    total_row = total_start
    last_col = get_column_letter(max_col)
    for _, tovar_turi, is_custom in data_rows:
        a = ws.cell(total_row, 1)
        b = ws.cell(total_row, 2)
        a.value = tovar_turi
        a._style = copy(custom_label_style if is_custom else label_style)
        a.fill = copy(label_fill)
        b.value = f"=SUM(B{data_row_by_type[tovar_turi]}:{last_col}{data_row_by_type[tovar_turi]})"
        b._style = copy(value_style)
        b.number_format = value_num_format
        total_row += 1

    ws.sheet_view.showGridLines = True
    wb.calculation.fullCalcOnLoad = True
    wb.calculation.forceFullCalc = True

    out = BytesIO()
    wb.save(out)
    return out.getvalue(), _safe_filename(report_name)
