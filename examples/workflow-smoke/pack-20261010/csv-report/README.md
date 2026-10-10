# CSV Expense Report (pack-20261010, task 2/4)

Standalone, zero-dependency Python 3 CLI and importable API that summarizes a
`date,category,amount` CSV file as stable JSON.

## Usage

```bash
python examples/workflow-smoke/pack-20261010/csv-report/expense_report.py expenses.csv
```

```python
from expense_report import summarize_expenses

summarize_expenses("date,category,amount\n2024-01-05,food,10.00\n")
# {'row_count': 1, 'total': '10.00', 'by_category': {'food': '10.00'},
#  'by_month': {'2024-01': '10.00'}, 'ignored_blank_rows': 0}
```

The file is opened read-only and is never modified.

## Output shape

```json
{
  "row_count": 3,
  "total": "112.50",
  "by_category": {"food": "12.50", "travel": "100.00"},
  "by_month": {"2024-01": "12.50", "2024-02": "100.00"},
  "ignored_blank_rows": 0
}
```

Keys in `by_category` and `by_month` are sorted, and JSON is rendered with
`sort_keys=True` and a trailing newline, so identical input always produces
byte-identical stdout.

## Validation

* The first non-blank row must be exactly the header `date,category,amount`
  (case-sensitive; surrounding whitespace per field is ignored). Data rows
  without a header are therefore rejected as an invalid header on line 1.
* Each data row must have exactly 3 fields (missing/extra fields rejected).
* Dates must be ISO `YYYY-MM-DD` (`2024-1-5`, `2024-13-01`, `2024-02-30`, and
  trailing junk are rejected).
* Categories must be non-blank after trimming.
* Amounts must be finite valid decimals; `NaN`, `nan`, `Infinity`,
  `-Infinity` and unquantizable values such as `1e999` are rejected.
* Every error message is prefixed with the 1-based physical line number
  (`line 5: ...`) and is raised as `ExpenseReportError` (a `ValueError`).
* Quoting follows the standard library `csv` reader, so quoted fields may
  contain embedded commas and embedded newlines.

## Documented policies

* **Empty input:** `""`, whitespace-only text, and header-only input are all
  valid and yield `row_count: 0`, `total: "0.00"`, and empty maps.
* **Blank rows:** wholly blank rows (and blank rows before the header) are
  skipped and counted in `ignored_blank_rows`; later errors still report the
  original physical line number.
* **Rounding:** all arithmetic uses `decimal.Decimal`. Rows are never rounded
  individually; each aggregate is quantized once to 2 decimal places using
  `ROUND_HALF_UP`, so `0.10 + 0.20` is exactly `"0.30"` and `0.005 + 0.004`
  is `"0.01"`. JSON numbers are rendered as fixed 2-decimal **strings**.
* **Negative credits:** signed amounts are allowed and subtract from the
  total, the category total, and the month total. An aggregate that rounds to
  negative zero renders as `"0.00"`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success; JSON on stdout |
| 1 | Invalid CSV content; `error: {path}: {message}` on stderr, stdout empty |
| 2 | File missing/unreadable; `error: cannot read {path}: {reason}` on stderr |

## Tests

```bash
python -m pytest tests/workflow_smoke/test_pack_20261010_expense_report.py -q
```

Deterministic: no clocks, no randomness, no network, no third-party packages.
