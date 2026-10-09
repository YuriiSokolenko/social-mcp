# CSV expense summary CLI (workflow smoke)

Disposable end-to-end workflow smoke artefact. Stdlib only: `csv`, `datetime`,
`decimal`, `json`, `argparse`. Not production functionality.

## Usage

```console
./expense_report.py expenses.csv
```

Prints one JSON object to stdout and exits `0`. On any problem it prints
`error: <message>` to stderr and exits `1`. The input file is opened read-only
and is never modified.

```json
{"by_category":{"food":"3.00","transport":"2.50"},"by_month":{"2024-01":
"5.50"},"total":"5.50"}
```

## Input format

Required header, exactly (whitespace around names is ignored):

```csv
date,category,amount
```

Each data row must have exactly three fields:

| field      | rule                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `date`     | ISO `YYYY-MM-DD` only (e.g. `2024-01-05`). `01/02/2024` and `2024-13-01` are rejected.               |
| `category` | must be non-blank after trimming; surrounding whitespace is trimmed and quoted values may contain `,` |
| `amount`   | decimal, may be signed (`-12.34` models a credit); `NaN`, `Infinity`, `-Infinity` are rejected       |

A missing or extra field is an error. Every error message names the source line
number, where the header is line 1, so the first data row is line 2.

## Documented semantics

- **Empty input.** A header-only CSV, or text containing only blank lines after
  the header, yields the well-formed empty summary
  `{"total": "0.00", "by_category": {}, "by_month": {}}`. Completely empty or
  headerless input is an error.
- **Blank rows.** Blank rows (and blank lines before the header) are skipped,
  not treated as missing-field errors.
- **Rounding.** Sums use `decimal.Decimal` — never `float` — so `0.10 + 0.20`
  is exactly `"0.30"`. Values are quantized once at the end with
  `ROUND_HALF_UP` to two decimals; a sum that rounds to zero is rendered
  `"0.00"`, never `"-0.00"`.
- **Negative credits.** Signed amounts are valid and reduce the `total`, the
  category total, and the month total they belong to.
- **Determinism.** `by_category` and `by_month` are keyed in sorted order and
  the CLI serializes with `json.dumps(..., sort_keys=True)`, so output for the
  same input is byte-identical. `by_month` keys are the `YYYY-MM` prefix.

## Tests

```console
pytest tests/workflow_smoke/test_expense_report.py
```
