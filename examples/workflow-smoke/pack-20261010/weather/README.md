# WeatherService (Open-Meteo) — disposable workflow smoke artefact

Issue #730 · E2E pack `2026-10-10` (task 1/4). This is **disposable workflow
smoke output**, not product code: it is not imported by the MCP server, has no
routes, and is removable by a separate explicitly scoped cleanup PR.

## What it is

`weather.py` is a small, synchronous, **standard-library-only** client for the
Open-Meteo Forecast API `https://api.open-meteo.com/v1/forecast`.

```python
from weather import WeatherService

forecast = WeatherService().get_forecast(52.52, 13.41, days=3)

print(forecast["timezone"])            # "Europe/Berlin"  (timezone=auto)
print(forecast["units"]["temperature"])  # "°C"
print(forecast["current"])             # temperature_c / weather_code / wind_speed_kmh
for day in forecast["daily"]:
    print(day["date"], day["temperature_min_c"], day["temperature_max_c"],
          day["precipitation_probability_pct"])
```

Injected transport (used by the tests, and the reason no network is needed):

```python
service = WeatherService(http_get=lambda url: open("fixture.json", "rb").read())
```

## Request shape

One request per call, built only with `urllib.parse.urlencode`:
`latitude`, `longitude`, `current=temperature_2m,weather_code,wind_speed_10m`,
`daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
`timezone=auto`, `forecast_days=<days>`. No API key or other secret is sent.
The default transport uses `urllib.request.urlopen` with a bounded timeout
(`DEFAULT_TIMEOUT = 10.0`, configurable per instance) and a static
`User-Agent`.

## Documented policy choices

* **Validation first, then transport.** `ValueError` for non-finite or
  out-of-range coordinates (latitude ±90, longitude ±180) and for `days`
  outside 1..7 or of the wrong type (`bool`, `float`, `str` are rejected).
  Invalid input never reaches the network.
* **`WeatherServiceError`** (a `RuntimeError`) wraps every upstream problem:
  `HTTPError`, `URLError`, timeouts, non-UTF-8/malformed/non-JSON bodies, a
  non-object body, a missing `timezone`, a missing `current`/`daily`/units
  block, a missing required daily array, daily arrays whose lengths disagree
  with `days`, and non-numeric values where numbers are required. Raw urllib
  exceptions are never leaked; the (secret-free) request URL is included.
* **`None` is preserved** where Open-Meteo legitimately returns `null`
  (notably `precipitation_probability_max`), so absence of data stays
  distinguishable from `0`.
* Numbers are normalized to `float` (temperatures, wind, precipitation) and
  `int` (`weather_code`); dates are validated with `date.fromisoformat`.
* `elevation_m` and `timezone_abbreviation` appear only when the upstream
  response supplies usable values.

## Data licence and attribution (read before reusing)

* Open-Meteo's forecast API is free **for non-commercial use only** and needs
  no API key for that non-commercial tier.
* Open-Meteo data requires **attribution under CC BY 4.0**
  (credit “Open-Meteo.com”, linking to https://open-meteo.com/en/docs).
* **Commercial use requires an Open-Meteo commercial license.** Nothing here
  grants, implies, or assumes free commercial use; obtain a license from
  Open-Meteo before any commercial deployment.
* Underlying model data carries the licences noted by Open-Meteo
  (https://github.com/open-meteo/open-meteo).

## Tests

Deterministic, fully offline (injected fake transport plus one monkeypatched
`urlopen` that covers the real request path), no external network:

```bash
python -m pytest tests/workflow_smoke/test_pack_20261010_weather.py -q
python -m pytest tests/workflow_smoke -q
ruff check examples/workflow-smoke/pack-20261010 \
           tests/workflow_smoke/test_pack_20261010_weather.py
```

Covered: normalized schema, units, current conditions, daily lengths for
`days` 1/3/7, exact URL/`urlencode` parameters (and absence of any key
parameter), validation rejections that never call transport, accepted
boundaries, wrapped `URLError`/`HTTPError`/timeout, malformed JSON, schema and
array-misalignment failures, `null` tolerance, configured-timeout/`User-Agent`
on the real request path, and determinism of repeated calls.
