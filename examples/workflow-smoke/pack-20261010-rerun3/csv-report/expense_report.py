"""Stand-alone CSV expense summary CLI (disposable workflow smoke artefact).

Issue #761 (``pack-20261010-rerun3``): an isolated baseline rerun. This module
is independent from every other smoke pack; it reads a CSV whose header is
``date,category,amount`` and prints a stable JSON summary of totals overall,
per category, and per month. Standard library only.

Documented policy choices
-------------------------
* Empty input, whitespace-only input, and header-only input are valid and
  produce a zero summary (``row_count == 0``, ``total == "0.00"``, empty maps).
* Wholly blank rows are ignored and reported as ``ignored_blank_rows``. Row
  numbers in errors still refer to the original 1-based line number, so blank
  rows are counted in those numbers too.
* Amounts use :class:`decimal.Decimal` end to end, never ``float``. Nothing is
  rounded per row; each aggregate is rounded once with ``ROUND_HALF_UP`` and
  rendered as a fixed two-decimal string (a rounded negative zero renders as
  ``"0.00"``).
* Negative amounts are credits: they subtract from the totals.
* The header comparison trims each field but is exact and case sensitive; no
  BOM is stripped. Rows with fewer or more than three fields are rejected.
* Dates must be exactly ``YYYY-MM-DD``; no relative, locale, or time-zone
  handling.
* The input file is opened read only and is never rewritten.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any

EXPECTED_HEADER = ("date", "category", "amount")
CENTS = Decimal("0.01")
MONTH_PATTERN = "YYYY-MM"


class ExpenseReportError(ValueError):
    """Raised for every invalid header, row, or field."""


def _money(value: Decimal) -> str:
    """Render *value* as a fixed two-decimal string, rounding half up once."""
    quantized = value.quantize(CENTS, rounding=ROUND_HALF_UP)
    if quantized == 0:
        quantized = Decimal("0.00")
    return str(quantized)


def _month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def _parse_date(value: str, line: int) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ExpenseReportError(f"line {line}: invalid date {value!r}") from None


def _parse_amount(value: str, line: int) -> Decimal:
    try:
        amount = Decimal(value)
    except InvalidOperation:
        raise ExpenseReportError(f"line {line}: invalid amount {value!r}") from None
    if not amount.is_finite():
        raise ExpenseReportError(f"line {line}: amount must be finite, got {value!r}")
    try:
        amount.quantize(CENTS)
    except InvalidOperation:
        raise ExpenseReportError(
            f"line {line}: amount out of range for two decimals, got {value!r}"
        ) from None
    return amount


def _parse_row(row: list[str], line: int) -> tuple[date, str, Decimal]:
    if len(row) != len(EXPECTED_HEADER):
        raise ExpenseReportError(
            f"line {line}: expected {len(EXPECTED_HEADER)} fields, got {len(row)}"
        )
    day_value, category_value, amount_value = (field.strip() for field in row)
    if not day_value:
        raise ExpenseReportError(f"line {line}: missing date")
    if not category_value:
        raise ExpenseReportError(f"line {line}: missing category")
    day = _parse_date(day_value, line)
    return day, category_value, _parse_amount(amount_value, line)


def _check_header(row: list[str], line: int) -> None:
    fields = [field.strip() for field in row]
    if tuple(fields) != EXPECTED_HEADER:
        raise ExpenseReportError(
            f"line {line}: expected header {','.join(EXPECTED_HEADER)}, got {','.join(fields)}"
        )


def _is_blank(row: list[str]) -> bool:
    return not row or all(not field.strip() for field in row)


def summarize_expenses(csv_text: str) -> dict[str, Any]:
    """Summarise ``date,category,amount`` records held in *csv_text*.

    Returns a JSON-safe dict with ``row_count``, ``total``, ``by_category``,
    ``by_month`` (keys are ``"YYYY-MM"``) and ``ignored_blank_rows``. Amounts
    are fixed two-decimal strings and both maps are sorted, so equal input
    always produces byte-identical JSON. Raises :class:`ExpenseReportError`
    with a 1-based ``line N:`` prefix for the first invalid header, row, or
    field.
    """
    total = Decimal(0)
    categories: dict[str, Decimal] = {}
    months: dict[str, Decimal] = {}
    row_count = 0
    blank_rows = 0
    header_seen = False
    reader = csv.reader(io.StringIO(csv_text))
    for row in reader:
        line = reader.line_num
        if _is_blank(row):
            blank_rows += 1
            continue
        if not header_seen:
            _check_header(row, line)
            header_seen = True
            continue
        day, category, amount = _parse_row(row, line)
        total += amount
        categories[category] = categories.get(category, Decimal(0)) + amount
        month = _month_key(day)
        months[month] = months.get(month, Decimal(0)) + amount
        row_count += 1
    return _result(row_count, total, categories, months, blank_rows)


def _result(
    row_count: int,
    total: Decimal,
    categories: dict[str, Decimal],
    months: dict[str, Decimal],
    blank_rows: int,
) -> dict[str, Any]:
    return {
        "row_count": row_count,
        "total": _money(total),
        "by_category": {name: _money(value) for name, value in sorted(categories.items())},
        "by_month": {name: _money(value) for name, value in sorted(months.items())},
        "ignored_blank_rows": blank_rows,
    }


def render_json(summary: dict[str, Any]) -> str:
    """Render *summary* as stable, sorted JSON terminated by a newline."""
    return json.dumps(summary, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="expense_report",
        description="Summarise a date,category,amount CSV expense report as JSON.",
    )
    parser.add_argument("csv_path", type=Path, help="path to a local CSV file (read only)")
    args = parser.parse_args(argv)
    path: Path = args.csv_path
    try:
        csv_text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        reason = exc.strerror if isinstance(exc, OSError) else exc.reason
        print(f"error: cannot read {path}: {reason}", file=sys.stderr)
        return 2
    try:
        summary = summarize_expenses(csv_text)
    except ExpenseReportError as exc:
        print(f"error: {path}: {exc}", file=sys.stderr)
        return 1
    sys.stdout.write(render_json(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
