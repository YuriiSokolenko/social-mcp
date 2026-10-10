"""Standalone CSV expense summary CLI for workflow smoke pack pack-20261011-rerun4.

This module is disposable smoke-test output for issue #771. It has zero external
dependencies and reads input files read-only; it never modifies the input file.

Input is CSV text with the exact header ``date,category,amount``.

Documented policy choices
-------------------------
* Empty input, whitespace-only input, and header-only input are valid and
  produce ``row_count: 0``, ``total: "0.00"`` and empty group maps.
* Wholly blank rows (no fields, or every field blank after trimming) are
  ignored and counted in ``ignored_blank_rows``. They do not consume line
  numbers: all reported line numbers are 1-based line numbers in the original
  text, so the header is always ``line 1``.
* Dates are strictly ISO ``YYYY-MM-DD``. No BOM, locale, relative-date, or
  timezone handling is performed.
* Categories must be non-blank after trimming and are used verbatim (case and
  inner whitespace sensitive) as grouping keys.
* Amounts are decimal, finite, and signed. ``NaN``/``Infinity`` and unquoted
  exponent spellings are rejected. Negative amounts model credits and
  subtract from the total, category, and month aggregates.
* Money uses :class:`decimal.Decimal` end to end with no per-row rounding. Each
  aggregate is quantized once to two decimals with ``ROUND_HALF_UP``; a rounded
  zero always renders as ``"0.00"`` (never ``"-0.00"``).
* Header comparison is exact and case sensitive after trimming each field.
* Quoting follows the standard-library :mod:`csv` dialect, so quoted fields may
  contain commas and newlines; embedded newlines do not shift line numbering.
* Rows with a missing or extra field count are rejected.

CLI usage::

    python examples/workflow-smoke/pack-20261011-rerun4/csv-report/expense_report.py expenses.csv

Exit codes: ``0`` success, ``1`` invalid CSV content, ``2`` unreadable/missing
file. JSON is written to stdout; all diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

EXPECTED_HEADER = ("date", "category", "amount")
CENTS = Decimal("0.01")


class ExpenseReportError(ValueError):
    """Raised for invalid header, row, or field data with a line-numbered message."""


def _money(value: Decimal) -> str:
    """Return ``value`` as a fixed two-decimal string using half-up rounding."""
    quantized = value.quantize(CENTS, rounding=ROUND_HALF_UP)
    if quantized == 0:
        quantized = Decimal("0.00")
    return f"{quantized:.2f}"


def _parse_date(value: str, line: int) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ExpenseReportError(f"line {line}: invalid ISO YYYY-MM-DD date {value!r}") from exc


def _parse_amount(value: str, line: int) -> Decimal:
    try:
        amount = Decimal(value)
    except InvalidOperation as exc:
        raise ExpenseReportError(f"line {line}: invalid decimal amount {value!r}") from exc
    if not amount.is_finite():
        raise ExpenseReportError(f"line {line}: amount must be finite, got {value!r}")
    try:
        amount.quantize(CENTS)
    except InvalidOperation as exc:
        raise ExpenseReportError(f"line {line}: amount {value!r} is out of range") from exc
    return amount


def _check_header(row: list[str], line: int) -> None:
    header = tuple(field.strip() for field in row)
    if header != EXPECTED_HEADER:
        expected = ",".join(EXPECTED_HEADER)
        got = ",".join(header)
        raise ExpenseReportError(f"line {line}: expected header {expected}, got {got!r}")


def _parse_row(row: list[str], line: int) -> tuple[date, str, Decimal]:
    if len(row) != 3:
        raise ExpenseReportError(f"line {line}: expected 3 fields, got {len(row)}")
    raw_date, raw_category, raw_amount = (field.strip() for field in row)
    if not raw_date:
        raise ExpenseReportError(f"line {line}: date is required")
    if not raw_category:
        raise ExpenseReportError(f"line {line}: category is required")
    return _parse_date(raw_date, line), raw_category, _parse_amount(raw_amount, line)


def summarize_expenses(csv_text: str) -> dict[str, Any]:
    """Summarize ``date,category,amount`` CSV text into deterministic totals.

    Returns ``row_count``, ``total``, ``by_category``, ``by_month`` and
    ``ignored_blank_rows``. Money is accumulated as ``Decimal`` and every amount
    is rendered as a fixed two-decimal string; group keys are sorted.
    """
    reader = csv.reader(io.StringIO(csv_text))
    header_seen = False
    row_count = 0
    ignored_blank_rows = 0
    total = Decimal("0")
    by_category: dict[str, Decimal] = {}
    by_month: dict[str, Decimal] = {}

    for row in reader:
        line = reader.line_num
        if not row or all(not field.strip() for field in row):
            ignored_blank_rows += 1
            continue
        if not header_seen:
            _check_header(row, line)
            header_seen = True
            continue
        day, category, amount = _parse_row(row, line)
        month = f"{day.year:04d}-{day.month:02d}"
        row_count += 1
        total += amount
        by_category[category] = by_category.get(category, Decimal("0")) + amount
        by_month[month] = by_month.get(month, Decimal("0")) + amount

    return {
        "row_count": row_count,
        "total": _money(total),
        "by_category": {key: _money(value) for key, value in sorted(by_category.items())},
        "by_month": {key: _money(value) for key, value in sorted(by_month.items())},
        "ignored_blank_rows": ignored_blank_rows,
    }


def render_json(summary: dict[str, Any]) -> str:
    """Render ``summary`` as stable, pretty-printed JSON ending with a newline."""
    return json.dumps(summary, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    """Run the CLI and return the process exit code."""
    parser = argparse.ArgumentParser(
        prog="expense_report",
        description="Summarize a date,category,amount CSV file as stable JSON.",
    )
    parser.add_argument("csv_path", type=Path, help="path to a local CSV file (read only)")
    args = parser.parse_args(argv)
    path: Path = args.csv_path

    try:
        csv_text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        reason = getattr(exc, "strerror", None) or str(exc)
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
