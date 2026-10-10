# Open-Meteo `WeatherService` (workflow smoke pack `pack-20261011-rerun4`, issue #770)

Disposable workflow-smoke artefact: a small, reusable **synchronous** Python
service around the keyless [Open-Meteo Forecast API](https://open-meteo.com/en/docs)
(`https://api.open-meteo.com/v1/forecast`). It is not product code, has no
server/CLI, and can be removed by a later explicitly scoped cleanup PR.

## Licensing and attribution (read first)

* Open-Meteo is free of charge **for non-commercial use only** and requires
  attribution of Open-Meteo as the data source; the underlying data is licensed
  **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**.
* **Commercial use requires a separate Open-Meteo commercial licence.** Nothing
  here grants, implies, or substitutes for that licence, and nothing here should
  be read as saying the data is free for commercial use.
* Source and terms: <https://open-meteo.com/en/docs>,
  <https://github.com/open-meteo/open-meteo>.
* Every result carries an `attribution` string, so normalised output keeps the
  attribution with the data.

## Usage

```python
from weather import WeatherService

forecast = WeatherService().get_forecast(45.25, -20.5, days=3)
print(forecast["timezone"], forecast["current"]["temperature"])
for day in forecast["daily"]:
    print(day["date"], day["temperature_min"], day["temperature_max"],
          day["precipitation_probability"])
```

`get_forecast(latitude, longitude, days=3)` returns a JSON-safe dict:

```python
{
    "location": {"latitude": 45.25, "longitude": -20.5, "elevation": 117.0},
    "timezone": "Europe/Belgrade",
    "units": {"temperature_2m": "°C", "weather_code": "wmo code", ...},
    "current": {
        "temperature": 18.5,
        "weather_code": 2.0,
        "wind_speed": 7.4,
        "units": {"temperature": "°C", "weather_code": "unitless", "wind_speed": "km/h"},
    },
    "daily": [
        {
            "date": "2026-10-11",
            "temperature_min": 10.0,
            "temperature_max": 20.0,
            "precipitation_probability": 0.0,
        },
        ...
    ],
    "attribution": "Weather data (c) Open-Meteo, licensed CC BY 4.0; ...",
}
```

`location` echoes the validated request coordinates (plus upstream `elevation`
when present) so the output stays stable; daily entries keep the upstream
chronological order. `precipitation_probability` is the only field that can be
`None`, because Open-Meteo omits precipitation probability in some regions.

## Requests, validation, and errors

* Requested fields are exactly
  `current=temperature_2m,weather_code,wind_speed_10m`,
  `daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
  `timezone=auto`, `forecast_days=<days>`. The URL is built with
  `urllib.parse.urlencode`; **no API key, token, or secret is ever added**
  (Open-Meteo needs none for non-commercial use).
* Validation happens before any request: coordinates must be finite numbers in
  `-90..90` / `-180..180` and `days` must be an `int` in `1..7` (`bool` is
  rejected). Clear `ValueError` messages name the offending parameter.
* Transport is `urllib.request.urlopen` with a timeout (`timeout`, default
  5.0s). Inject `http_get=callable(url) -> bytes` to supply your own transport;
  the unit tests use that seam, so **no test performs a real network request**.
* Upstream HTTP status failures, URL/DNS failures, timeouts, other `OSError`s,
  malformed JSON, non-object payloads, missing/blank `timezone`, missing
  `current`/`daily`/unit objects, non-numeric values, and missing,
  non-list, short, or over-long daily arrays all raise
  `WeatherServiceError`, which subclasses `ValueError` and names the offending
  field. No upstream exception type escapes to callers.

## Tests

Deterministic, mocked-transport tests (no network, no secrets, no sleeps):

```bash
uv run pytest tests/workflow_smoke/test_pack_20261011_rerun4_weather.py -q
```
