"""Focused tests for the disposable Open-Meteo weather smoke (issue #770).

Every test injects a fake transport, so no real network request is made.
"""

from __future__ import annotations

import json
import urllib.error
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import pytest

MODULE_PATH = (
    Path(__file__).parents[2]
    / "examples"
    / "workflow-smoke"
    / "pack-20261011-rerun4"
    / "weather"
    / "weather.py"
)

SPEC = spec_from_file_location("pack_20261011_rerun4_weather", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
weather = module_from_spec(SPEC)
SPEC.loader.exec_module(weather)

WeatherService = weather.WeatherService
WeatherServiceError = weather.WeatherServiceError
LATITUDE = 45.25
LONGITUDE = -20.5
EXPECTED_KEYS = {"latitude", "longitude", "current", "daily", "timezone", "forecast_days"}


def _payload(days: int = 3) -> dict[str, Any]:
    return {
        "latitude": LATITUDE,
        "longitude": LONGITUDE,
        "elevation": 117.0,
        "timezone": "Europe/Belgrade",
        "timezone_abbreviation": "CET",
        "generationtime_ms": 0.1,
        "current": {
            "time": "2026-10-11T12:00",
            "interval": 900,
            "temperature_2m": 18.5,
            "weather_code": 2,
            "wind_speed_10m": 7.4,
        },
        "current_units": {
            "time": "iso8601",
            "interval": "seconds",
            "temperature_2m": "\u00b0C",
            "weather_code": "wmo code",
            "wind_speed_10m": "km/h",
        },
        "daily": {
            "time": [f"2026-10-{11 + index:02d}" for index in range(days)],
            "temperature_2m_max": [20.0 + index for index in range(days)],
            "temperature_2m_min": [10.0 + index for index in range(days)],
            "precipitation_probability_max": [10 * index for index in range(days)],
        },
        "daily_units": {
            "time": "iso8601",
            "temperature_2m_max": "\u00b0C",
            "temperature_2m_min": "\u00b0C",
            "precipitation_probability_max": "%",
        },
    }


def _service(body: Any = None, *, days: int = 3) -> tuple[WeatherService, list[str]]:
    """Return a service with an injected transport plus the list of captured URLs."""
    captured: list[str] = []
    payload = _payload(days) if body is None else body

    def getter(url: str) -> bytes:
        captured.append(url)
        if isinstance(payload, BaseException):
            raise payload
        if isinstance(payload, (bytes, bytearray)):
            return bytes(payload)
        return json.dumps(payload).encode("utf-8")

    return WeatherService(http_get=getter), captured


def _forecast(body: Any = None, *, days: int = 3) -> dict[str, Any]:
    service, _ = _service(body, days=days)
    return service.get_forecast(LATITUDE, LONGITUDE, days)


def test_well_known_payload_normalises_every_section() -> None:
    result = _forecast()
    assert result["location"] == {"latitude": LATITUDE, "longitude": LONGITUDE, "elevation": 117.0}
    assert result["timezone"] == "Europe/Belgrade"
    assert result["current"]["temperature"] == 18.5
    assert result["current"]["weather_code"] == 2.0
    assert result["current"]["wind_speed"] == 7.4
    assert result["current"]["units"] == {
        "temperature": "\u00b0C",
        "weather_code": "unitless",
        "wind_speed": "km/h",
    }
    assert "attribution" in result and "Open-Meteo" in result["attribution"]


def test_daily_entries_preserve_chronological_order() -> None:
    daily = _forecast()["daily"]
    assert [entry["date"] for entry in daily] == ["2026-10-11", "2026-10-12", "2026-10-13"]
    assert daily[0] == {
        "date": "2026-10-11",
        "temperature_min": 10.0,
        "temperature_max": 20.0,
        "precipitation_probability": 0.0,
    }
    assert daily[2]["temperature_min"] == 12.0
    assert daily[2]["precipitation_probability"] == 20.0


def test_units_are_taken_from_upstream_unit_maps() -> None:
    assert _forecast()["units"] == {
        "temperature_2m": "\u00b0C",
        "weather_code": "wmo code",
        "wind_speed_10m": "km/h",
        "temperature_2m_max": "\u00b0C",
        "temperature_2m_min": "\u00b0C",
        "precipitation_probability_max": "%",
    }


def test_precipitation_probability_may_be_none() -> None:
    payload = _payload()
    payload["daily"]["precipitation_probability_max"][1] = None
    assert _forecast(payload)["daily"][1]["precipitation_probability"] is None


def test_result_is_json_safe_and_deterministic() -> None:
    first = _forecast()
    assert json.loads(json.dumps(first)) == first
    service, captured = _service()
    assert service.get_forecast(LATITUDE, LONGITUDE) == service.get_forecast(LATITUDE, LONGITUDE)
    assert len(captured) == 2


@pytest.mark.parametrize("days", [1, 2, 3, 7])
def test_daily_length_matches_requested_days(days: int) -> None:
    assert len(_forecast(days=days)["daily"]) == days


@pytest.mark.parametrize(
    ("latitude", "longitude", "days"),
    [
        (float("nan"), LONGITUDE, 3),
        (float("inf"), LONGITUDE, 3),
        (float("-inf"), LONGITUDE, 3),
        (90.0001, LONGITUDE, 3),
        (-91, LONGITUDE, 3),
        ("45.25", LONGITUDE, 3),
        (None, LONGITUDE, 3),
        (True, LONGITUDE, 3),
        (LATITUDE, 180.5, 3),
        (LATITUDE, -181, 3),
        (LATITUDE, float("nan"), 3),
        (LATITUDE, "20", 3),
        (LATITUDE, True, 3),
        (LATITUDE, LONGITUDE, 0),
        (LATITUDE, LONGITUDE, 8),
        (LATITUDE, LONGITUDE, -1),
        (LATITUDE, LONGITUDE, 1.5),
        (LATITUDE, LONGITUDE, True),
        (LATITUDE, LONGITUDE, "3"),
        (LATITUDE, LONGITUDE, None),
    ],
)
def test_invalid_inputs_raise_value_error(
    latitude: Any, longitude: Any, days: Any
) -> None:
    service, captured = _service()
    with pytest.raises(WeatherServiceError):
        service.get_forecast(latitude, longitude, days)
    with pytest.raises(ValueError):
        service.get_forecast(latitude, longitude, days)
    assert captured == []


@pytest.mark.parametrize(
    ("latitude", "longitude", "days"),
    [(90, 180, 1), (-90.0, -180.0, 7), (0, 0, 3), (LATITUDE, LONGITUDE, 7)],
)
def test_boundary_inputs_are_accepted(latitude: float, longitude: float, days: int) -> None:
    result = _service(days=days)[0].get_forecast(latitude, longitude, days)
    assert len(result["daily"]) == days
    assert result["location"]["latitude"] == latitude


def _query(days: int = 3) -> dict[str, list[str]]:
    service, captured = _service(days=days)
    service.get_forecast(LATITUDE, LONGITUDE, days)
    parts = urlsplit(captured[0])
    assert (parts.scheme, parts.netloc, parts.path) == (
        "https",
        "api.open-meteo.com",
        "/v1/forecast",
    )
    return parse_qs(parts.query)


def test_request_url_carries_the_documented_params() -> None:
    query = _query()
    assert query["latitude"] == [repr(LATITUDE)]
    assert query["longitude"] == [repr(LONGITUDE)]
    assert query["current"] == ["temperature_2m,weather_code,wind_speed_10m"]
    assert query["daily"] == [
        "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    ]
    assert query["timezone"] == ["auto"]
    assert query["forecast_days"] == ["3"]
    assert set(query) == EXPECTED_KEYS


def test_default_days_is_three_in_url_and_output() -> None:
    service, captured = _service()
    service.get_forecast(LATITUDE, LONGITUDE)
    assert parse_qs(urlsplit(captured[0]).query)["forecast_days"] == ["3"]


def test_base_url_is_overridable_without_secrets() -> None:
    captured: list[str] = []
    service = WeatherService(
        http_get=lambda url: captured.append(url) or json.dumps(_payload(2)).encode("utf-8"),
        base_url="https://example.invalid/v1/forecast",
    )
    service.get_forecast(LATITUDE, LONGITUDE, 2)
    assert captured[0].startswith("https://example.invalid/v1/forecast?")
    assert not any(token in captured[0] for token in ("key", "token", "secret", "apikey"))


@pytest.mark.parametrize(
    "body",
    [b"not json", b"", b'{"daily":', b"[1,2,3]", b'"text"', b"\xff\xfe"],
)
def test_malformed_json_and_non_object_payloads(body: bytes) -> None:
    with pytest.raises(WeatherServiceError):
        _forecast(body)


def test_nan_and_non_numeric_current_values_are_rejected() -> None:
    for payload in (
        _with_current(temperature=float("nan")),
        _with_current(temperature="abc"),
        _with_current(wind_speed=None),
        _with_current(weather_code={"code": 2}),
    ):
        with pytest.raises(WeatherServiceError):
            _forecast(payload)


CURRENT_UPSTREAM_KEYS = {
    "temperature": "temperature_2m",
    "weather_code": "weather_code",
    "wind_speed": "wind_speed_10m",
}


def _with_current(**overrides: Any) -> dict[str, Any]:
    """Override upstream ``current`` fields using the normalised key names."""
    payload = _payload()
    payload["current"].update(
        {CURRENT_UPSTREAM_KEYS[name]: value for name, value in overrides.items()}
    )
    return payload


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.pop("timezone"),
        lambda p: p.__setitem__("timezone", "   "),
        lambda p: p.__setitem__("timezone", 5),
        lambda p: p.pop("current"),
        lambda p: p.pop("daily"),
        lambda p: p.pop("current_units"),
        lambda p: p.pop("daily_units"),
        lambda p: p["current_units"].pop("wind_speed_10m"),
        lambda p: p["daily_units"].pop("temperature_2m_min"),
        lambda p: p["daily"].pop("time"),
        lambda p: p["daily"].pop("temperature_2m_max"),
        lambda p: p["daily"].pop("temperature_2m_min"),
        lambda p: p["daily"].pop("precipitation_probability_max"),
        lambda p: p["daily"].__setitem__("time", ["2026-10-11"]),
        lambda p: p["daily"].__setitem__("time", "2026-10-11"),
        lambda p: p["daily"].__setitem__("temperature_2m_max", [20.0, 21.0]),
        lambda p: p["daily"].__setitem__(
            "temperature_2m_max", [20.0, 21.0, 22.0, 23.0]
        ),
        lambda p: p["daily"].__setitem__("temperature_2m_min", "10"),
        lambda p: p["daily"].__setitem__("time", ["2026-10-11", "", "2026-10-13"]),
        lambda p: p["daily"].__setitem__("temperature_2m_max", [20.0, 21.0, None]),
    ],
)
def test_missing_or_misaligned_daily_arrays_are_rejected(
    mutate: Callable[[dict[str, Any]], Any],
) -> None:
    payload = _payload()
    mutate(payload)
    with pytest.raises(WeatherServiceError):
        _forecast(payload)


@pytest.mark.parametrize(
    "failure",
    [
        urllib.error.HTTPError("https://api.open-meteo.com/v1/forecast", 503, "unavailable", None, None),  # noqa: E501
        urllib.error.HTTPError("https://api.open-meteo.com/v1/forecast", 404, "not found", None, None),  # noqa: E501
        urllib.error.URLError("dns lookup failed"),
        TimeoutError("timed out"),
        OSError("connection reset"),
        ValueError("unknown url type"),
    ],
)
def test_transport_failures_become_domain_errors(failure: BaseException) -> None:
    service, captured = _service(failure)
    with pytest.raises(WeatherServiceError) as excinfo:
        service.get_forecast(LATITUDE, LONGITUDE)
    assert "upstream" in str(excinfo.value) or "URL" in str(excinfo.value)
    assert len(captured) == 1
    assert not isinstance(excinfo.value, urllib.error.URLError)


def test_injected_transport_is_the_only_transport_used() -> None:
    service, captured = _service()
    service.get_forecast(LATITUDE, LONGITUDE, 3)
    assert len(captured) == 1
    assert "api.open-meteo.com" in captured[0]
    assert "key=" not in captured[0] and "token=" not in captured[0]


def test_service_configuration_is_validated() -> None:
    with pytest.raises(WeatherServiceError):
        WeatherService(timeout=0)
    with pytest.raises(WeatherServiceError):
        WeatherService(timeout=float("nan"))
    with pytest.raises(ValueError):
        WeatherService(timeout="5")


def test_error_type_is_a_value_error_subclass() -> None:
    assert issubclass(WeatherServiceError, ValueError)
