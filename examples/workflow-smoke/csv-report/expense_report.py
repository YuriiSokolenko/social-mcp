#!/usr/bin/env python3
"""Deterministic CSV expense summary: ``date,category,amount`` -> stable JSON.

Stdlib only. See ``README.md`` for the documented input, error, and rounding
semantics. Money is aggregated with ``decimal.Decimal`` and emitted as fixed
2-decimal strings.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import io
import json
import sys
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

HEADER = ("date", "category", "amount")
MONTH_LENGTH = 7  # len("YYYY-MM")
CENTS = Decimal("0.01")


class ExpenseReportError(ValueError):
    """Raised for any invalid CSV text, file path, or CLI usage."""


def _money(value: Decimal) -> str:
    """Render ``value`` as a fixed 2-decimal string using ROUND_HALF_UP."""
    quantized = value.quantize(CENTS, rounding=ROUND_HALF_UP)
    if quantized == 0:  # normalise "-0.00" (negative zero) to "0.00".
        quantized = Decimal("0.00")
    return f"{quantized:.2f}"


def _parse_date(value: str) -> str:
    """Return the ISO ``YYYY-MM-DD`` date, rejecting every other format."""
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError:
        raise ExpenseReportError(f"{value!r} is not an ISO YYYY-MM-DD date")


def _parse_amount(value: str) -> Decimal:
    """Return a finite signed ``Decimal`` amount, rejecting NaN/Infinity."""
    try:
        amount = Decimal(value)
    except InvalidOperation:
        raise ExpenseReportError(f"{value!r} is not a valid decimal amount")
    if not amount.is_finite():
        raise ExpenseReportError(f"{value!r} is not a finite decimal amount")
    return amount


def summarize_expenses(csv_text: str) -> dict:
    """Summarize ``date,category,amount`` CSV text into deterministic totals.

    Returns ``{"total": str, "by_category": {..}, "by_month": {"YYYY-MM": ..}}``
    with every money value a fixed 2-decimal string and every key sorted.
    """
    reader = csv.reader(io.StringIO(csv_text, newline=""))
    total = Decimal("0")
    by_category: dict[str, Decimal] = {}
    by_month: dict[str, Decimal] = {}

    if not isinstance(csv_text, str):
        raise ExpenseReportError("csv_text must be a string")

    rows = list(reader)
    while rows and not rows[0]:
        rows.pop(0)  # tolerate leading blank lines before the header
    if not rows:
        raise ExpenseReportError("CSV is empty: expected a 'date,category,amount' header")

    header, *body = rows
    fields = tuple(field.strip() for field in header)
    if fields != HEADER:
        raise ExpenseReportError(
            f"line 1: expected header {','.join(HEADER)}, got {','.join(header)}"
        )

    for index, row in enumerate(body, start=2):  # line 1 is the header
        if not row:
            continue  # blank rows are skipped
        if len(row) != len(HEADER):
            raise ExpenseReportError(
                f"line {index}: expected {len(HEADER)} fields, got {len(row)}"
            )
        raw_date, raw_category, raw_amount = row

        try:
            date = _parse_date(raw_date.strip())
            amount = _parse_amount(raw_amount.strip())
        except ExpenseReportError as error:
            raise ExpenseReportError(f"line {index}: {error}")

        category = raw_category.strip()
        if not category:
            raise ExpenseReportError(f"line {index}: category is empty")

        month = date[:MONTH_LENGTH]
        total += amount
        by_category[category] = by_category.get(category, Decimal("0")) + amount
        by_month[month] = by_month.get(month, Decimal("0")) + amount

    return {
        "total": _money(total),
        "by_category": {key: _money(by_category[key]) for key in sorted(by_category)},
        "by_month": {key: _money(by_month[key]) for key in sorted(by_month)},
    }


def _read_csv(path: str) -> str:
    """Read the named file read-only, never writing to it."""
    try:
        with Path(path).open("r", encoding="utf-8", newline="") as handle:
            return handle.read()
    except OSError as error:
        raise ExpenseReportError(f"cannot read {path}: {error.strerror}")


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point: print stable JSON for one CSV file path."""
    parser = argparse.ArgumentParser(prog="expense_report", description=__doc__.splitlines()[0])
    parser.add_argument("csv_file", help="path to a 'date,category,amount' CSV file")
    args = parser.parse_args(argv)

    try:
        summary = summarize_expenses(_read_csv(args.csv_file))
    except ExpenseReportError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
