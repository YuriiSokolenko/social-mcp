"""Focused tests for the isolated CSV expense summary smoke (issue #761).

Fully standalone: the module is loaded by path (the pack directory names contain
hyphens), only pytest built-ins and the standard library are used, and the suite
passes both under ``pytest --noconftest`` and normal product collection.
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

MODULE_PATH = (
    Path(__file__).parents[2] / "examples" / "workflow-smoke"
    / "pack-20261010-rerun3" / "csv-report" / "expense_report.py"
)
SPEC = spec_from_file_location("expense_report_pack_20261010_rerun3", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
expense_report = module_from_spec(SPEC)
SPEC.loader.exec_module(expense_report)

HEADER = "date,category,amount"
summarize = expense_report.summarize_expenses
render = expense_report.render_json
Error = expense_report.ExpenseReportError
ZERO = {"row_count": 0, "total": "0.00", "by_category": {}, "by_month": {}}


def _rows(*rows: str) -> str:
    return HEADER + "\n" + "\n".join(rows) + "\n"


def _run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(MODULE_PATH), *args], capture_output=True, text=True, check=False
    )


def test_module_is_loadable() -> None:
    assert MODULE_PATH.is_file()
    assert expense_report.EXPECTED_HEADER == ("date", "category", "amount")


def test_totals_and_groups() -> None:
    summary = summarize(
        _rows("2024-03-01,food,10.00", "2024-03-20,travel,5.00", "2024-04-02,food,2.50")
    )
    assert summary == {
        "row_count": 3,
        "total": "17.50",
        "by_category": {"food": "12.50", "travel": "5.00"},
        "by_month": {"2024-03": "15.00", "2024-04": "2.50"},
        "ignored_blank_rows": 0,
    }


def test_exact_decimals_rounding_and_credits() -> None:
    assert summarize(_rows("2024-01-01,x,0.10", "2024-01-02,x,0.20"))["total"] == "0.30"
    assert summarize(_rows("2024-01-01,x,0.005", "2024-01-02,x,0.004"))["total"] == "0.01"
    assert summarize(_rows("2024-05-01,r,-5.00", "2024-05-02,r,12.00"))["by_category"] == {
        "r": "7.00"
    }
    assert summarize(_rows("2024-05-01,x,-0.001"))["total"] == "0.00"


def test_key_ordering_and_json_are_deterministic() -> None:
    text = _rows("2024-03-01,zebra,1.00", "2024-01-01,apple,2.00", "2024-02-01,mango,3.00")
    summary = summarize(text)
    assert list(summary["by_category"]) == ["apple", "mango", "zebra"]
    assert list(summary["by_month"]) == ["2024-01", "2024-02", "2024-03"]
    assert render(summary) == render(summarize(text))
    assert json.loads(render(summary)) == summary
    assert render(summary).endswith("\n")


def test_blank_rows_ignored_but_line_numbers_kept() -> None:
    summary = summarize(HEADER + "\n\n2024-01-01,x,1.00\n\n2024-01-02,x,2.00\n")
    assert (summary["row_count"], summary["ignored_blank_rows"], summary["total"]) == (2, 2, "3.00")
    with pytest.raises(Error, match=r"^line 5:"):
        summarize(HEADER + "\n\n2024-01-01,x,1.00\n\nbad,date,1.00\n")


def test_empty_and_header_only_input_is_a_zero_summary() -> None:
    for text in ("", "   \n  \n", HEADER + "\n"):
        for key, value in ZERO.items():
            assert summarize(text)[key] == value


def test_invalid_header_reports_line_one() -> None:
    for text in ("day,cat,amt\n", "Date,category,amount\n", "date,category\n"):
        with pytest.raises(Error, match=r"^line 1:"):
            summarize(text)


def test_missing_or_extra_fields() -> None:
    with pytest.raises(Error, match=r"^line 2:"):
        summarize(_rows("2024-01-01,food"))
    with pytest.raises(Error, match=r"^line 3:"):
        summarize(_rows("2024-01-01,food,1.00", "2024-01-02,food,1.00,9"))


def test_invalid_dates_categories_and_amounts() -> None:
    for value in ("2024-1-5", "2024-13-01", "2024-02-30", "not-a-date", "2024-01-05x", ""):
        with pytest.raises(Error, match=r"^line 2:"):
            summarize(_rows(f"{value},food,1.00"))
    for value in ("NaN", "nan", "Infinity", "-Infinity", "1e999", "twelve", ""):
        with pytest.raises(Error, match=r"^line 2:"):
            summarize(_rows(f"2024-01-01,food,{value}"))
    with pytest.raises(Error, match=r"missing category"):
        summarize(_rows("2024-01-01,   ,1.00"))
    with pytest.raises(Error, match=r"missing date"):
        summarize(_rows("   ,food,1.00"))


def test_csv_quoting_round_trips_through_the_stdlib_writer(tmp_path) -> None:
    assert summarize(_rows('2024-03-05,"Doe, John",10.00'))["by_category"] == {"Doe, John": "10.00"}
    embedded = summarize(_rows('2024-03-05,"Retreat\nPlanning",10.00'))
    assert embedded["row_count"] == 1
    assert embedded["by_category"] == {"Retreat\nPlanning": "10.00"}
    path = tmp_path / "written.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "category", "amount"])
        writer.writerow(["2024-03-05", "Doe, John", "10.00"])
        writer.writerow(["2024-03-06", "Retreat\nPlanning", "4.005"])
    assert summarize(path.read_text(encoding="utf-8"))["by_category"] == {
        "Doe, John": "10.00",
        "Retreat\nPlanning": "4.01",
    }


def test_cli_success_leaves_the_input_untouched(tmp_path) -> None:
    path = tmp_path / "sample.csv"
    path.write_text(_rows("2024-03-05,food,10.00"), encoding="utf-8")
    before = path.read_bytes()
    result = _run_cli(str(path))
    assert result.returncode == 0
    assert path.read_bytes() == before
    assert json.loads(result.stdout) == {
        "row_count": 1,
        "total": "10.00",
        "by_category": {"food": "10.00"},
        "by_month": {"2024-03": "10.00"},
        "ignored_blank_rows": 0,
    }
    assert result.stdout == render(json.loads(result.stdout))


def test_cli_failure_exits_nonzero(tmp_path) -> None:
    bad = tmp_path / "bad.csv"
    bad.write_text("nope,fields,here\n", encoding="utf-8")
    failure = _run_cli(str(bad))
    assert failure.returncode == 1
    assert "line 1" in failure.stderr
    assert failure.stdout == ""
    missing = _run_cli(str(tmp_path / "absent.csv"))
    assert missing.returncode == 2
    assert missing.stdout == ""
    assert _run_cli().returncode == 2
