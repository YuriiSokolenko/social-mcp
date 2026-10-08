"""Deterministic ``date,category,amount`` CSV expense summary CLI.

Workflow smoke-test scratch code: standalone, standard library only.

`summarize_expenses(csv_text)` parses CSV text whose header is
``date,category,amount`` and returns a plain ``dict``.  Documented behaviour:

* Empty input (no header) is an error: a header row is mandatory.  A file with
  only a header is valid and yields zero totals with ``record_count == 0``.
* Blank rows (a line with no fields, or one containing nothing but whitespace)
  are skipped silently; ``date,,``-style rows with real empty fields are not
  blank and are reported as invalid.
* Dates must be exactly ISO ``YYYY-MM-DD``; categories must be non-blank after
  trimming; amounts are parsed with `decimal.Decimal`, so ``NaN``,
  ``Infinity`` and malformed numbers are rejected while signed values stay
  valid to model credits.
* Money is aggregated with `decimal.Decimal` (never ``float``) and rendered as
  fixed 2-decimal strings using ``ROUND_HALF_UP``.  Negative group/total sums
  are kept as-is, but a sum that quantizes to zero is rendered ``"0.00"`` so
  ``-0.00`` never appears.
* Key order is deterministic: top-level keys are fixed, category and month keys
  are sorted.  The input file is only ever read.
"""

import argparse
import csv
import decimal
import io
import json
import re
import sys
from datetime import date

EXPECTED_HEADER = ("date", "category", "amount")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CENT = decimal.Decimal("0.01")


class ExpenseReportError(Exception):
    """Raised when CSV text cannot be summarised."""


def _parse_date(raw: str, lineno: int) -> str:
    if not ISO_DATE_RE.match(raw):
        raise ExpenseReportError(f"line {lineno}: invalid date {raw!r}; expected ISO YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(raw)
    except ValueError:
        raise ExpenseReportError(f"line {lineno}: invalid date {raw!r}; expected ISO YYYY-MM-DD")
    return parsed.isoformat()


def _parse_amount(raw: str, lineno: int) -> decimal.Decimal:
    try:
        amount = decimal.Decimal(raw.strip())
    except decimal.InvalidOperation:
        raise ExpenseReportError(
            f"line {lineno}: invalid amount {raw!r}; expected a finite decimal number"
        )
    if amount.is_nan() or amount.is_infinite():
        raise ExpenseReportError(
            f"line {lineno}: invalid amount {raw!r}; expected a finite decimal number"
        )
    return amount


def _is_blank_row(row: list[str]) -> bool:
    return not row or (len(row) == 1 and not row[0].strip())


def _money(value: decimal.Decimal) -> str:
    quantized = value.quantize(CENT, rounding=decimal.ROUND_HALF_UP)
    if quantized == 0:
        quantized = decimal.Decimal("0.00")
    return f"{quantized:.2f}"


def summarize_expenses(csv_text: str) -> dict:
    """Summarise ``date,category,amount`` CSV text into deterministic totals."""
    body = csv_text.lstrip("\ufeff")
    total = decimal.Decimal("0")
    by_category: dict[str, decimal.Decimal] = {}
    by_month: dict[str, decimal.Decimal] = {}
    record_count = 0
    header_seen = False

    reader = csv.reader(io.StringIO(body, newline=""))
    try:
        for row in reader:
            lineno = reader.line_num
            if _is_blank_row(row):
                continue
            if not header_seen:
                header = [field.strip().lower() for field in row]
                if tuple(header) != EXPECTED_HEADER:
                    got = ",".join(field.strip() for field in row)
                    raise ExpenseReportError(
                        f"line {lineno}: header must be 'date,category,amount', got {got!r}"
                    )
                header_seen = True
                continue
            if len(row) != 3:
                raise ExpenseReportError(
                    f"line {lineno}: expected 3 fields (date,category,amount), got {len(row)}"
                )
            raw_date, raw_category, raw_amount = (field.strip() for field in row)
            iso_date = _parse_date(raw_date, lineno)
            category = raw_category
            if not category:
                raise ExpenseReportError(f"line {lineno}: category must not be blank")
            amount = _parse_amount(raw_amount, lineno)
            total += amount
            by_category[category] = by_category.get(category, decimal.Decimal("0")) + amount
            month = iso_date[:7]
            by_month[month] = by_month.get(month, decimal.Decimal("0")) + amount
            record_count += 1
    except csv.Error as exc:
        raise ExpenseReportError(f"line {reader.line_num}: malformed CSV: {exc}") from exc

    if not header_seen:
        raise ExpenseReportError("missing header row: expected 'date,category,amount'")

    return {
        "total": _money(total),
        "by_category": {key: _money(by_category[key]) for key in sorted(by_category)},
        "by_month": {key: _money(by_month[key]) for key in sorted(by_month)},
        "record_count": record_count,
    }


def main(argv: list[str] | None = None) -> int:
    """Summarise one local CSV file as stable JSON on stdout."""
    parser = argparse.ArgumentParser(
        description="Summarise a date,category,amount CSV expense file as JSON."
    )
    parser.add_argument("csv_path", help="path to a local CSV file (read only)")
    args = parser.parse_args(argv)

    try:
        with open(args.csv_path, encoding="utf-8") as handle:
            csv_text = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        print(f"error: cannot read {args.csv_path}: {exc}", file=sys.stderr)
        return 2

    try:
        payload = summarize_expenses(csv_text)
    except ExpenseReportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
