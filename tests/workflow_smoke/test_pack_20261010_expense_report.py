"""Focused, deterministic pytest suite for the pack-20261010 expense CLI."""

from __future__ import annotations

import json
import subprocess
import sys
from decimal import Decimal
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType

import pytest

MODULE_PATH = (
    Path(__file__).parents[2]
    / "examples"
    / "workflow-smoke"
    / "pack-20261010"
    / "csv-report"
    / "expense_report.py"
)


def _load_module() -> ModuleType:
    spec = spec_from_file_location("pack_20261010_expense_report", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULE = _load_module()
summarize_expenses = MODULE.summarize_expenses
render_json = MODULE.render_json
ExpenseReportError = MODULE.ExpenseReportError

HEADER = "date,category,amount\n"


def _row(*rows: str) -> str:
    return HEADER + "\n".join(rows) + ("\n" if rows else "")


def test_module_path_exists() -> None:
    assert MODULE_PATH.is_file()


def test_basic_totals_grouping_and_row_count() -> None:
    summary = summarize_expenses(
        _row(
            "2024-01-05,food,10.00",
            "2024-01-20,food,2.50",
            "2024-02-01,travel,100.00",
        )
    )
    assert summary["row_count"] == 3
    assert summary["total"] == "112.50"
    assert summary["by_category"] == {"food": "12.50", "travel": "100.00"}
    assert summary["by_month"] == {"2024-01": "12.50", "2024-02": "100.00"}
    assert summary["ignored_blank_rows"] == 0


def test_decimal_exactness_no_float_drift() -> None:
    summary = summarize_expenses(_row("2024-03-01,misc,0.10", "2024-03-02,misc,0.20"))
    assert summary["total"] == "0.30"
    assert summary["by_category"]["misc"] == "0.30"


def test_half_up_rounding_on_aggregate_only() -> None:
    summary = summarize_expenses(_row("2024-03-01,misc,0.005", "2024-03-02,misc,0.004"))
    assert summary["total"] == "0.01"
    assert summary["by_category"]["misc"] == "0.01"


def test_negative_credits_subtract_everywhere() -> None:
    summary = summarize_expenses(
        _row(
            "2024-04-01,food,50.00",
            "2024-04-02,food,-20.00",
            "2024-04-03,travel,5.00",
        )
    )
    assert summary["total"] == "35.00"
    assert summary["by_category"] == {"food": "30.00", "travel": "5.00"}
    assert summary["by_month"] == {"2024-04": "35.00"}


def test_negative_zero_renders_as_positive_zero() -> None:
    summary = summarize_expenses(_row("2024-05-01,food,-0.001"))
    assert summary["total"] == "0.00"
    assert summary["by_category"]["food"] == "0.00"
    assert summary["by_month"]["2024-05"] == "0.00"


def test_key_ordering_is_deterministic() -> None:
    summary = summarize_expenses(
        _row(
            "2024-02-01,zebra,1.00",
            "2024-01-01,apple,2.00",
            "2024-01-15,apple,3.00",
        )
    )
    assert list(summary["by_category"]) == ["apple", "zebra"]
    assert list(summary["by_month"]) == ["2024-01", "2024-02"]


def test_render_json_is_stable_and_roundtrips() -> None:
    summary = summarize_expenses(_row("2024-06-01,gift,7.50"))
    text = render_json(summary)
    assert text == render_json(summarize_expenses(_row("2024-06-01,gift,7.50")))
    assert text.endswith("\n")
    assert json.loads(text) == summary
    assert json.loads(text)["total"] == "7.50"


def test_all_output_values_are_two_decimal_strings() -> None:
    summary = summarize_expenses(_row("2024-07-01,food,1", "2024-07-02,food,2.5"))
    values = [summary["total"], *summary["by_category"].values(), *summary["by_month"].values()]
    for value in values:
        assert isinstance(value, str)
        assert value == str(Decimal(value).quantize(Decimal("0.01")))
    assert isinstance(summary["row_count"], int)
    assert isinstance(summary["ignored_blank_rows"], int)


def test_blank_rows_ignored_and_line_numbers_preserved() -> None:
    csv_text = HEADER + "\n2024-01-01,food,1.00\n\n   \nnot-a-date,food,1.00\n"
    with pytest.raises(ExpenseReportError, match=r"^line 6:"):
        summarize_expenses(csv_text)
    ok = summarize_expenses(HEADER + "\n2024-01-01,food,1.00\n\n   \n")
    assert ok["ignored_blank_rows"] == 3
    assert ok["row_count"] == 1
    assert ok["total"] == "1.00"


@pytest.mark.parametrize("csv_text", ["", "   \n\n  ", HEADER])
def test_empty_and_header_only_input_are_valid(csv_text: str) -> None:
    summary = summarize_expenses(csv_text)
    assert summary["row_count"] == 0
    assert summary["total"] == "0.00"
    assert summary["by_category"] == {}
    assert summary["by_month"] == {}


def test_invalid_header_reports_line_one() -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 1: expected header"):
        summarize_expenses("date,amount\n2024-01-01,1.00\n")
    with pytest.raises(ExpenseReportError, match=r"^line 1: expected header"):
        summarize_expenses("2024-01-01,food,1.00\n")


@pytest.mark.parametrize(
    ("row", "pattern"),
    [
        ("2024-01-01,food", r"^line 2: expected 3 fields, got 2"),
        ("2024-01-01,food,1.00,extra", r"^line 2: expected 3 fields, got 4"),
    ],
)
def test_field_count_validation(row: str, pattern: str) -> None:
    with pytest.raises(ExpenseReportError, match=pattern):
        summarize_expenses(_row(row))


@pytest.mark.parametrize(
    "bad_date",
    ["2024-1-05", "2024-13-01", "2024-02-30", "not-a-date", "2024-01-01T00:00", "  "],
)
def test_iso_date_rejection(bad_date: str) -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 2: "):
        summarize_expenses(_row(f"{bad_date},food,1.00"))


def test_blank_category_rejected() -> None:
    with pytest.raises(ExpenseReportError, match="missing category"):
        summarize_expenses(_row("2024-01-01,   ,1.00"))


@pytest.mark.parametrize(
    "bad_amount",
    ["abc", "", "NaN", "nan", "Infinity", "-Infinity", "1.00.00", "1e999", "  "],
)
def test_amount_must_be_finite_decimal(bad_amount: str) -> None:
    with pytest.raises(ExpenseReportError, match=r"^line 2: "):
        summarize_expenses(_row(f"2024-01-01,food,{bad_amount}"))


def test_quoted_fields_with_embedded_comma_and_newline() -> None:
    csv_text = (
        HEADER
        + '2024-01-05,"Doe, John",10.00\r\n'
        + '2024-01-06,"Retreat\nPlanning",5.00\r\n'
    )
    summary = summarize_expenses(csv_text)
    assert summary["row_count"] == 2
    assert summary["total"] == "15.00"
    assert summary["by_category"] == {"Doe, John": "10.00", "Retreat\nPlanning": "5.00"}


def test_cli_success_writes_json_and_preserves_file(tmp_path: Path) -> None:
    csv_file = tmp_path / "expenses.csv"
    original = _row("2024-01-01,food,1.005", "2024-01-31,travel,2.00")
    csv_file.write_text(original, encoding="utf-8")
    before = csv_file.read_bytes()

    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(csv_file)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stderr == ""
    payload = json.loads(proc.stdout)
    assert payload["row_count"] == 2
    assert payload["total"] == "3.01"
    assert payload["by_category"] == {"food": "1.01", "travel": "2.00"}
    assert payload["by_month"] == {"2024-01": "3.01"}
    assert proc.stdout == render_json(payload)
    assert csv_file.read_bytes() == before


def test_cli_failure_reports_line_and_keeps_stdout_empty(tmp_path: Path) -> None:
    csv_file = tmp_path / "bad.csv"
    csv_file.write_text("date,category,amountx\n2024-01-01,food,1.00\n", encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(csv_file)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "line 1" in proc.stderr
    assert str(csv_file) in proc.stderr


def test_cli_missing_file_exits_two(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(MODULE_PATH), str(tmp_path / "nope.csv")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 2
    assert proc.stdout == ""
    assert "cannot read" in proc.stderr
