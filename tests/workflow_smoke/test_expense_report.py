"""Focused tests for the disposable CSV expense summary smoke (issue #695)."""

from __future__ import annotations

import json
import subprocess
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parents[2] / "examples" / "workflow-smoke" / "csv-report" / "expense_report.py"

SPEC = spec_from_file_location("expense_report", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
expense_report = module_from_spec(SPEC)
SPEC.loader.exec_module(expense_report)

HEADER = "date,category,amount"
HEADER_ROWS = 1
summarize = expense_report.summarize_expenses


def _row(*rows: str) -> str:
    return HEADER + "\n" + "\n".join(rows) + "\n"


def test_totals_and_groups() -> None:
    summary = summarize(_row("2024-03-01,food,10.00", "2024-03-20,travel,5.00", "2024-04-02,food,2.50"))
    assert summary["row_count"] == 3
    assert summary["total"] == "17.50"
    assert summary["by_category"] == {"food": "12.50", "travel": "5.00"}
    assert summary["by_month"] == {"2024-03": "15.00", "2024-04": "2.50"}
    assert summary["ignored_blank_rows"] == 0


def test_decimal_avoids_float_drift() -> None:
    summary = summarize(_row("2024-01-01,x,0.10", "2024-01-02,x,0.20"))
    assert summary["total"] == "0.30"
    assert summary["by_category"] == {"x": "0.30"}


def test_round_half_up_on_the_aggregate() -> None:
    summary = summarize(_row("2024-01-01,x,0.005", "2024-01-02,x,0.004"))
    assert summary["total"] == "0.01"


def test_negative_credits_subtract() -> None:
    summary = summarize(_row("2024-05-01,refund,-5.00", "2024-05-02,refund,12.00"))
    assert summary["total"] == "7.00"
    assert summary["by_category"] == {"refund": "7.00"}


def test_rounded_negative_zero_renders_as_zero() -> None:
    assert summarize(_row("2024-05-01,x,-0.001"))["total"] == "0.00"


def test_key_ordering_is_deterministic() -> None:
    rows = ("2024-03-01,zebra,1.00", "2024-01-01,apple,2.00", "2024-02-01,mango,3.00")
    summary = summarize(_row(*rows))
    assert list(summary["by_category"]) == ["apple", "mango", "zebra"]
    assert list(summary["by_month"]) == ["2024-01", "2024-02", "2024-03"]
    assert expense_report.render_json(summary) == expense_report.render_json(summarize(_row(*rows)))
    assert json.loads(expense_report.render_json(summary)) == summary


def test_blank_rows_are_ignored_but_line_numbers_stay() -> None:
    text = HEADER + "\n\n2024-01-01,x,1.00\n\n2024-01-02,x,2.00\n"
    summary = summarize(text)
    assert summary["row_count"] == 2
    assert summary["ignored_blank_rows"] == 2
    assert summary["total"] == "3.00"
    with pytest.raises(expense_report.ExpenseReportError, match=r"^line 5:"):
        summarize(HEADER + "\n\n2024-01-01,x,1.00\n\nbad,date,1.00\n")


def test_empty_and_header_only_input_is_valid() -> None:
    for text in ("", "   \n  \n", HEADER + "\n"):
        summary = summarize(text)
        assert summary["row_count"] == 0
        assert summary["total"] == "0.00"
        assert summary["by_category"] == {}
        assert summary["by_month"] == {}


def test_invalid_header_reports_line_one() -> None:
    for text in ("day,cat,amt\n", "Date,category,amount\n", "date,category\n"):
        with pytest.raises(expense_report.ExpenseReportError, match=r"^line 1:"):
            summarize(text)


def test_missing_or_extra_fields() -> None:
    with pytest.raises(expense_report.ExpenseReportError, match=r"^line 2:"):
        summarize(_row("2024-01-01,food"))
    with pytest.raises(expense_report.ExpenseReportError, match=r"^line 3:"):
        summarize(_row("2024-01-01,food,1.00", "2024-01-02,food,1.00,9"))


def test_date_must_be_iso() -> None:
    for value in ("2024-1-5", "2024-13-01", "2024-02-30", "not-a-date", "2024-01-05x", ""):
        with pytest.raises(expense_report.ExpenseReportError, match=r"^line 2:"):
            summarize(_row(f"{value},food,1.00"))


def test_category_must_be_nonblank() -> None:
    with pytest.raises(expense_report.ExpenseReportError, match=r"missing category"):
        summarize(_row("2024-01-01,   ,1.00"))


def test_amount_must_be_finite_decimal() -> None:
    for value in ("NaN", "nan", "Infinity", "-Infinity", "1e999", "twelve", ""):
        with pytest.raises(expense_report.ExpenseReportError, match=r"^line 2:"):
            summarize(_row(f"2024-01-01,food,{value}"))


def test_quoted_fields_and_embedded_newline() -> None:
    assert summarize(_row('2024-03-05,"Doe, John",10.00'))["by_category"] == {"Doe, John": "10.00"}
    summary = summarize(_row('2024-03-05,"Retreat\nPlanning",10.00'))
    assert summary["by_category"] == {"Retreat\nPlanning": "10.00"}
    assert summary["by_month"] == {"2024-03": "10.00"}


def test_cli_success_leaves_input_untouched(tmp_path) -> None:
    path = tmp_path / "sample.csv"
    path.write_text(_row("2024-03-05,food,10.00"), encoding="utf-8")
    before = path.read_bytes()
    result = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(path)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert path.read_bytes() == before
    assert json.loads(result.stdout) == {
        "by_category": {"food": "10.00"},
        "by_month": {"2024-03": "10.00"},
        "ignored_blank_rows": 0,
        "row_count": 1,
        "total": "10.00",
    }
    assert result.stdout == expense_report.render_json(json.loads(result.stdout))


def test_cli_failure_exits_nonzero(tmp_path) -> None:
    bad = tmp_path / "bad.csv"
    bad.write_text("nope,fields,here\n", encoding="utf-8")
    failure = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(bad)],
        capture_output=True,
        text=True,
    )
    assert failure.returncode == 1
    assert "line 1" in failure.stderr
    assert failure.stdout == ""

    missing = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(tmp_path / "absent.csv")],
        capture_output=True,
        text=True,
    )
    assert missing.returncode == 2
    assert missing.stdout == ""
