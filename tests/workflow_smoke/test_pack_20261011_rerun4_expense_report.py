"""Focused pytest coverage for the pack-20261011-rerun4 expense report CLI."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

MODULE_PATH = (
    Path(__file__).parents[2]
    / "examples"
    / "workflow-smoke"
    / "pack-20261011-rerun4"
    / "csv-report"
    / "expense_report.py"
)
SPEC = importlib.util.spec_from_file_location("expense_report_pack_20261011_rerun4", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE: ModuleType = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

summarize_expenses = MODULE.summarize_expenses
render_json = MODULE.render_json
ExpenseReportError = MODULE.ExpenseReportError

HEADER = "date,category,amount"


def _row(*rows: str) -> str:
    return "\n".join((HEADER, *rows)) + "\n"


def test_totals_and_grouping() -> None:
    summary = summarize_expenses(
        _row(
            "2024-01-05,Food,10.10",
            "2024-01-20,Food,4.90",
            "2024-02-01,Travel,100.00",
        )
    )
    assert summary["row_count"] == 3
    assert summary["total"] == "115.00"
    assert summary["by_category"] == {"Food": "15.00", "Travel": "100.00"}
    assert summary["by_month"] == {"2024-01": "15.00", "2024-02": "100.00"}
    assert summary["ignored_blank_rows"] == 0


def test_decimal_exactness_avoids_float_drift() -> None:
    summary = summarize_expenses(_row("2024-03-01,Misc,0.10", "2024-03-02,Misc,0.20"))
    assert summary["total"] == "0.30"
    assert summary["by_category"]["Misc"] == "0.30"


def test_half_up_rounding_on_aggregate_only() -> None:
    summary = summarize_expenses(_row("2024-03-01,Misc,0.005", "2024-03-02,Misc,0.004"))
    assert summary["total"] == "0.01"
    assert summary["by_category"]["Misc"] == "0.01"


def test_negative_credits_subtract() -> None:
    summary = summarize_expenses(
        _row(
            "2024-04-01,Refunds,10.005",
            "2024-04-02,Refunds,-10.005",
        )
    )
    assert summary["total"] == "0.00"
    assert summary["by_category"]["Refunds"] == "0.00"
    assert summary["by_month"]["2024-04"] == "0.00"
    assert summary["by_month"] == {"2024-04": "0.00"}


def test_deterministic_key_ordering_and_json_stability() -> None:
    summary = summarize_expenses(
        _row(
            "2024-05-01,Travel,1.00",
            "2024-01-30,Food,2.00",
            "2024-05-02,Auto,3.00",
        )
    )
    assert list(summary["by_category"]) == ["Auto", "Food", "Travel"]
    assert list(summary["by_month"]) == ["2024-01", "2024-05"]
    rendered = render_json(summary)
    assert rendered == render_json(summarize_expenses(_row(
        "2024-05-01,Travel,1.00",
        "2024-01-30,Food,2.00",
        "2024-05-02,Auto,3.00",
    )))
    assert json.loads(rendered) == summary


def test_blank_rows_ignored_counted_and_line_numbers_preserved() -> None:
    csv_text = "\n".join(
        [
            HEADER,
            "",
            "   ",
            "2024-06-01,Food,1.00",
            "2024-06-02,Bad,notanumber",
            "",
        ]
    )
    with pytest.raises(ExpenseReportError, match=r"^line 5:"):
        summarize_expenses(csv_text)
    summary = summarize_expenses(_row("2024-06-01,Food,1.00", "", "   ", "2024-06-02,Food,2.00"))
    assert summary["row_count"] == 2
    assert summary["ignored_blank_rows"] == 2
    assert summary["total"] == "3.00"


def test_empty_whitespace_only_and_header_only_are_valid() -> None:
    for csv_text in ("", "   \n\t\n  ", HEADER, HEADER + "\n\n"):
        summary = summarize_expenses(csv_text)
        assert summary["row_count"] == 0
        assert summary["total"] == "0.00"
        assert summary["by_category"] == {}
        assert summary["by_month"] == {}


@pytest.mark.parametrize(
    "header",
    [
        "date,category,value",
        "Date,Category,Amount",
        "date,category",
        "category,amount",
        "amount",
    ],
)
def test_invalid_header_reported_on_line_1(header: str) -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 1: expected header"):
        summarize_expenses(header + "\n2024-01-01,Food,1.00\n")


def test_missing_and_extra_field_counts() -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 2: expected 3 fields, got 2"):
        summarize_expenses(_row("2024-01-01,Food"))
    with pytest.raises(ExpenseReportError, match=r"^line 3: expected 3 fields, got 4"):
        summarize_expenses(_row("2024-01-01,Food,1.00", "2024-01-02,Food,2.00,extra"))


@pytest.mark.parametrize(
    "bad_date",
    ["2024-1-5", "2024-13-01", "2024-02-30", "not-a-date", "2024-01-01T00:00", "2024/01/01", ""],
)
def test_date_strictness(bad_date: str) -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 2:"):
        summarize_expenses(_row(f"{bad_date},Food,1.00"))


@pytest.mark.parametrize("bad_category", ["", "   ", "\t"])
def test_blank_category_rejected(bad_category: str) -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 2: category is required"):
        summarize_expenses(_row(f"2024-01-01,{bad_category},1.00"))


@pytest.mark.parametrize(
    "bad_amount",
    ["NaN", "nan", "Infinity", "-Infinity", "1e999", "abc", "", "12,00"],
)
def test_amount_must_be_finite_decimal(bad_amount: str) -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 2:"):
        summarize_expenses(_row(f"2024-01-01,Food,{bad_amount}"))


def test_quoted_fields_with_comma_and_newline() -> None:
    csv_text = (
        HEADER + "\n"
        '2024-07-01,"Food, Snacks",10.00\n'
        '2024-07-02,"Multi\nline",5.00\n'
    )
    summary = summarize_expenses(csv_text)
    assert summary["row_count"] == 2
    assert summary["total"] == "15.00"
    assert summary["by_category"] == {"Food, Snacks": "10.00", "Multi\nline": "5.00"}
    assert summary["by_month"] == {"2024-07": "15.00"}


def test_cli_success_writes_stable_json_and_preserves_input(tmp_path: Path) -> None:
    csv_path = tmp_path / "expenses.csv"
    original = _row("2024-08-01,Food,1.005", "2024-08-02,Food,1.005")
    csv_path.write_text(original, encoding="utf-8")
    before = csv_path.read_bytes()

    completed = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(csv_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == render_json(json.loads(completed.stdout))
    assert json.loads(completed.stdout) == {
        "row_count": 2,
        "total": "2.01",
        "by_category": {"Food": "2.01"},
        "by_month": {"2024-08": "2.01"},
        "ignored_blank_rows": 0,
    }
    assert csv_path.read_bytes() == before


def test_cli_failure_on_bad_content(tmp_path: Path) -> None:
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("date,category,amount\n2024-08-01,Food,NaN\n", encoding="utf-8")

    completed = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(csv_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 1
    assert completed.stdout == ""
    assert "line 2" in completed.stderr


def test_cli_missing_file_uses_exit_code_2(tmp_path: Path) -> None:
    completed = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(tmp_path / "missing.csv")],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 2
    assert completed.stdout == ""
    assert "cannot read" in completed.stderr
