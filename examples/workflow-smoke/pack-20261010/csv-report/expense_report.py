#!/usr/bin/env python3
"""Summarize a ``date,category,amount`` CSV expense file as stable JSON.

Standalone, standard-library-only CLI and importable API for the
``pack-20261010`` workflow smoke run.

Policy
------
* Input must start with the exact header ``date,category,amount``
  (case-sensitive, whitespace around each field is ignored).
* Every data row must have exactly three fields.
* Dates must be ISO ``YYYY-MM-DD``; categories must be non-blank after
  trimming; amounts must be finite decimals (``NaN``/``Infinity`` rejected).
* Signed amounts are allowed: a negative amount is a credit that subtracts
  from the total, its category total and its month total.
* All arithmetic uses :class:`decimal.Decimal`. Aggregates are quantized once
  to 2 decimal places with ``ROUND_HALF_UP``; rows are never rounded
  individually. A quantized aggregate of ``-0.00`` renders as ``"0.00"``.
* Empty input, whitespace-only input and header-only input are valid and
  produce zero rows. Wholly blank rows are skipped and counted in
  ``ignored_blank_rows``.
* Errors always report the 1-based physical line number of the offending row
  and are raised as :class:`ExpenseReportError` (a ``ValueError``).
* The CLI reads the file read-only and never writes to it. Exit codes:
  ``0`` success, ``1`` invalid CSV content, ``2`` unreadable/missing file.
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
# Largest base-10 exponent accepted for an amount, keeping every aggregate
# quantizable to 2 decimal places under the default decimal context.
MAX_AMOUNT_DIGITS = 15


class ExpenseReportError(ValueError):
    """Raised for invalid CSV content, with a ``line N:`` prefix where known."""


def _money(value: Decimal) -> str:
    """Render an aggregate as a fixed 2-decimal string."""
    quantized = value.quantize(CENTS, rounding=ROUND_HALF_UP)
    if quantized == 0:
        quantized = Decimal("0.00")
    return str(quantized)


def _parse_date(value: str, line_number: int) -> str:
    text = value.strip()
    if not text:
        raise ExpenseReportError(f"line {line_number}: missing date")
    try:
        parsed = date.fromisoformat(text)
    except ValueError:
        raise ExpenseReportError(
            f"line {line_number}: invalid date {value!r}; expected ISO YYYY-MM-DD"
        ) from None
    return parsed.isoformat()


def _parse_amount(value: str, line_number: int) -> Decimal:
    text = value.strip()
    if not text:
        raise ExpenseReportError(f"line {line_number}: missing amount")
    try:
        amount = Decimal(text)
    except InvalidOperation:
        raise ExpenseReportError(
            f"line {line_number}: invalid amount {value!r}"
        ) from None
    if not amount.is_finite():
        raise ExpenseReportError(
            f"line {line_number}: amount must be finite, got {value!r}"
        )
    if amount.adjusted() > MAX_AMOUNT_DIGITS:
        raise ExpenseReportError(
            f"line {line_number}: amount out of range: {value!r}"
        )
    return amount


def _parse_row(
    row: list[str], line_number: int
) -> tuple[str, str, str, Decimal]:
    if len(row) != 3:
        raise ExpenseReportError(
            f"line {line_number}: expected 3 fields, got {len(row)}"
        )
    raw_date, raw_category, raw_amount = row
    iso_date = _parse_date(raw_date, line_number)
    category = raw_category.strip()
    if not category:
        raise ExpenseReportError(f"line {line_number}: missing category")
    amount = _parse_amount(raw_amount, line_number)
    return iso_date, category, iso_date[:7], amount


def _check_header(row: list[str], line_number: int) -> None:
    fields = tuple(field.strip() for field in row)
    if fields != EXPECTED_HEADER:
        raise ExpenseReportError(
            "line "
            f"{line_number}: expected header {','.join(EXPECTED_HEADER)}, "
            f"got {','.join(fields)}"
        )


def _result(
    row_count: int,
    total: Decimal,
    by_category: dict[str, Decimal],
    by_month: dict[str, Decimal],
    ignored_blank_rows: int,
) -> dict[str, Any]:
    return {
        "row_count": row_count,
        "total": _money(total),
        "by_category": {key: _money(by_category[key]) for key in sorted(by_category)},
        "by_month": {key: _money(by_month[key]) for key in sorted(by_month)},
        "ignored_blank_rows": ignored_blank_rows,
    }


def summarize_expenses(csv_text: str) -> dict[str, Any]:
    """Summarize ``date,category,amount`` CSV text into deterministic totals."""
    reader = csv.reader(io.StringIO(csv_text))
    by_category: dict[str, Decimal] = {}
    by_month: dict[str, Decimal] = {}
    total = Decimal("0")
    row_count = 0
    ignored_blank_rows = 0
    header_seen = False

    for row in reader:
        line_number = reader.line_num
        if not header_seen:
            if not any(field.strip() for field in row):
                ignored_blank_rows += 1
                continue
            _check_header(row, line_number)
            header_seen = True
            continue
        if not any(field.strip() for field in row):
            ignored_blank_rows += 1
            continue
        iso_date, category, month, amount = _parse_row(row, line_number)
        row_count += 1
        total += amount
        by_category[category] = by_category.get(category, Decimal("0")) + amount
        by_month[month] = by_month.get(month, Decimal("0")) + amount

    return _result(row_count, total, by_category, by_month, ignored_blank_rows)


def render_json(summary: dict[str, Any]) -> str:
    """Render a summary as byte-stable, sorted, indented JSON."""
    return json.dumps(summary, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="expense_report.py",
        description="Summarize a date,category,amount CSV file as JSON.",
    )
    parser.add_argument("csv_path", type=Path, help="path to the CSV file to read")
    args = parser.parse_args(argv)
    path: Path = args.csv_path

    try:
        csv_text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        reason = getattr(exc, "strerror", None) or getattr(exc, "reason", None) or str(exc)
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
