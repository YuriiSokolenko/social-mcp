"""Stand-alone CSV expense summary CLI (disposable workflow smoke artefact).

Reads a CSV whose header is ``date,category,amount`` and prints a stable JSON
summary of the grand total, per-category totals and per-month totals.

Documented policy choices
-------------------------
* Empty input, whitespace-only input, and header-only input are valid and
  produce a zero summary (``row_count == 0``, ``total == "0.00"``, empty maps).
* Wholly blank rows are ignored and counted in ``ignored_blank_rows``. Error
  messages still report the original 1-based line number of the offending row.
* Amounts are :class:`decimal.Decimal` end to end; no ``float`` is involved.
  Nothing is rounded per row: each aggregate is rounded once with
  ``ROUND_HALF_UP`` to two decimals and rendered as a fixed two-decimal string,
  so JSON output is deterministic. A rounded negative zero renders ``"0.00"``.
* Negative amounts are credits and therefore subtract from the totals.
* The header must match ``date,category,amount`` exactly (case sensitive) after
  trimming each field; rows with missing or extra fields are rejected.
* Dates must be ISO ``YYYY-MM-DD``. Quoting is delegated to the stdlib
  ``csv`` module. No BOM, locale, time-zone, or network handling.
* The input file is opened read only and is never rewritten.

Exit codes: ``0`` success, ``1`` invalid CSV content, ``2`` unreadable input.
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
ZERO = Decimal(0)


class ExpenseReportError(ValueError):
    """Raised for an invalid header, row shape, or field value."""


def _money(value: Decimal) -> str:
    """Render *value* as a fixed two-decimal string, rounded half up."""
    quantized = value.quantize(CENTS, rounding=ROUND_HALF_UP)
    if quantized == 0:  # avoid emitting "-0.00" for rounded negative zero
        quantized = Decimal("0.00")
    return str(quantized)


def _parse_date(value: str, line: int) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ExpenseReportError(f"line {line}: invalid ISO date {value!r}") from None


def _parse_amount(value: str, line: int) -> Decimal:
    try:
        amount = Decimal(value)
    except InvalidOperation:
        raise ExpenseReportError(f"line {line}: invalid decimal amount {value!r}") from None
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
    date_text, category, amount_text = (field.strip() for field in row)
    if not date_text:
        raise ExpenseReportError(f"line {line}: missing date")
    if not category:
        raise ExpenseReportError(f"line {line}: missing category")
    day = _parse_date(date_text, line)
    return day, category, _parse_amount(amount_text, line)


def _check_header(row: list[str], line: int) -> None:
    fields = tuple(field.strip() for field in row)
    if fields != EXPECTED_HEADER:
        expected = ",".join(EXPECTED_HEADER)
        got = ",".join(fields)
        raise ExpenseReportError(f"line {line}: expected header {expected!r}, got {got!r}")


def _month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def _accumulate(buckets: dict[str, Decimal], key: str, amount: Decimal) -> None:
    buckets[key] = buckets.get(key, ZERO) + amount


def summarize_expenses(csv_text: str) -> dict[str, Any]:
    """Summarise ``date,category,amount`` records held in *csv_text*.

    Returns a JSON-safe dict with ``row_count``, ``total``, ``by_category``,
    ``by_month`` (keys are ``"YYYY-MM"``) and ``ignored_blank_rows``. Amounts
    are fixed two-decimal strings and both maps are sorted, so equal input
    always produces byte-identical JSON.

    Raises:
        ExpenseReportError: on a missing/invalid header, a row with the wrong
            number of fields, a non-ISO date, a blank category, or an amount
            that is not a finite two-decimal-representable decimal.
    """
    total = ZERO
    by_category: dict[str, Decimal] = {}
    by_month: dict[str, Decimal] = {}
    row_count = 0
    ignored_blank_rows = 0
    header_seen = False

    reader = csv.reader(io.StringIO(csv_text))
    for row in reader:
        line = reader.line_num  # 1-based line of the original text, blanks included
        if not row or all(not field.strip() for field in row):
            ignored_blank_rows += 1
            continue
        if not header_seen:
            _check_header(row, line)
            header_seen = True
            continue
        day, category, amount = _parse_row(row, line)
        total += amount
        _accumulate(by_category, category, amount)
        _accumulate(by_month, _month_key(day), amount)
        row_count += 1
    return _build_result(row_count, total, by_category, by_month, ignored_blank_rows)


def _build_result(
    row_count: int,
    total: Decimal,
    by_category: dict[str, Decimal],
    by_month: dict[str, Decimal],
    ignored_blank_rows: int,
) -> dict[str, Any]:
    return {
        "row_count": row_count,
        "total": _money(total),
        "by_category": {name: _money(v) for name, v in sorted(by_category.items())},
        "by_month": {name: _money(v) for name, v in sorted(by_month.items())},
        "ignored_blank_rows": ignored_blank_rows,
    }


def render_json(summary: dict[str, Any]) -> str:
    """Render *summary* as stable, key-sorted JSON terminated by a newline."""
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
