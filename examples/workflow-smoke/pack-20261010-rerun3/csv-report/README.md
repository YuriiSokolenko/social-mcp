# CSV expense summary — `pack-20261010-rerun3` (disposable workflow smoke)

Disposable end-to-end smoke artefact for issue #761 (isolated baseline rerun of
the same acceptance task as #753). It is **not** production functionality, is
independent from every other smoke pack, and may be removed by a separate
scoped cleanup PR. Standard library only — zero external dependencies.

Summarises a CSV file whose header is `date,category,amount` as stable JSON.

```bash
python examples/workflow-smoke/pack-20261010-rerun3/csv-report/expense_report.py expenses.csv
```

The input file is read only; it is never rewritten. Exit codes: `0` success,
`1` invalid CSV content, `2` unreadable or missing file (including no argument).

## Importable API

```python
from expense_report import summarize_expenses

summarize_expenses("date,category,amount\n2024-03-01,food,10.00\n")
```

Returns a JSON-safe dict with `row_count`, `total`, `by_category`, `by_month`
(keys are `YYYY-MM`), and `ignored_blank_rows`.

```json
{
  "by_category": {"food": "12.50", "travel": "5.00"},
  "by_month": {"2024-03": "15.00", "2024-04": "2.50"},
  "ignored_blank_rows": 0,
  "row_count": 3,
  "total": "17.50"
}
```

Amounts are fixed two-decimal strings and both maps are sorted, so identical
input always produces byte-identical JSON (`render_json` uses
`json.dumps(..., indent=2, sort_keys=True)` plus a trailing newline).

## Documented policy choices

* **Empty input** (empty string, whitespace only) and header-only input are
  valid and yield `row_count: 0`, `total: "0.00"`, and empty maps.
* **Blank rows** are ignored and counted in `ignored_blank_rows`; row numbers in
  error messages still refer to the original 1-based line number, so blank rows
  are counted in those numbers too.
* **Header** matching trims each field but is exact and case sensitive; no BOM
  is stripped. The first non-blank row must be the header, reported as
  `line 1: expected header date,category,amount, got ...`.
* **Arity** must be exactly three fields per row; missing or extra fields are
  rejected as `line N: expected 3 fields, got M`.
* **Dates** must be exactly `YYYY-MM-DD` (`date.fromisoformat`); no relative,
  locale, or time-zone handling. Empty date and category fields are reported
  explicitly.
* **Categories** must be non-blank after trimming.
* **Amounts** use `decimal.Decimal` (never `float`). `NaN` and `Infinity` are
  rejected, as are values too large to render with two decimals. Signed amounts
  are allowed: a negative amount is a credit that subtracts from the totals.
* **Rounding** happens once per aggregate with `ROUND_HALF_UP`; nothing is
  rounded per row. A rounded negative zero renders as `"0.00"`.
* **Quoting** follows the standard library `csv` dialect, so embedded commas and
  embedded newlines in quoted fields are supported.

## Tests

```bash
python -m pytest --noconftest -p no:cacheprovider \
  tests/workflow_smoke/test_pack_20261010_rerun3_expense_report.py -q
```

The suite loads the module by path (the directory names contain hyphens), uses
only pytest built-ins plus the standard library, makes no network requests, and
writes only inside `tmp_path`.
