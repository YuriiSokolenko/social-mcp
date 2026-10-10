# CSV Expense Report (pack-20261011-rerun4)

Disposable workflow-smoke output for issue #771. Standalone, standard-library
only; it is not part of the product and has zero external dependencies.

## Usage

```bash
python examples/workflow-smoke/pack-20261011-rerun4/csv-report/expense_report.py expenses.csv
```

The input file is opened read-only and never modified. JSON goes to stdout,
diagnostics to stderr.

## Exit codes

| Code | Meaning                       |
| ---- | ----------------------------- |
| `0`  | Success, JSON on stdout       |
| `1`  | Invalid CSV content (stderr)  |
| `2`  | Missing/unreadable input file |

## Sample input

```csv
date,category,amount
2024-01-05,Food,10.10
2024-01-20,Food,4.90
2024-02-01,Travel,100.00
```

## Sample output

```json
{
  "by_category": {
    "Food": "15.00",
    "Travel": "100.00"
  },
  "by_month": {
    "2024-01": "15.00",
    "2024-02": "100.00"
  },
  "ignored_blank_rows": 0,
  "row_count": 3,
  "total": "115.00"
}
```

## Documented policy choices

- Empty, whitespace-only, and header-only input are valid (`row_count: 0`,
  `total: "0.00"`, empty maps).
- Wholly blank rows are ignored and counted in `ignored_blank_rows`; reported
  line numbers always refer to 1-based lines in the original text, so the
  header is `line 1`.
- Dates are strictly ISO `YYYY-MM-DD` (no BOM, locale, or timezone handling).
- Categories must be non-blank after trimming and are used verbatim.
- Amounts are signed, finite decimals; `NaN`/`Infinity` are rejected and
  negative amounts model credits that subtract from all aggregates.
- Money uses `decimal.Decimal` end to end with no per-row rounding; each
  aggregate is quantized once to two decimals with `ROUND_HALF_UP`, and a
  rounded zero renders as `"0.00"`.
- Header matching is exact and case sensitive after trimming each field.
- Quoting follows the standard-library `csv` module, so quoted fields may
  contain commas and newlines.
- Rows with a missing or extra field count are rejected.

## Tests

```bash
pytest tests/workflow_smoke/test_pack_20261011_rerun4_expense_report.py -q
```
