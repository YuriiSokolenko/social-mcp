# WeatherService (Open-Meteo) — pack-20261010-rerun3

Small, reusable, **synchronous** client around the Open-Meteo Forecast API
(`https://api.open-meteo.com/v1/forecast`). Standard library only, no
framework, no app/server wiring, and no secrets.

## Usage

```python
from weather import WeatherService

forecast = WeatherService().get_forecast(52.52, 13.41, days=3)

forecast["location"]   # {"latitude": 52.52, "longitude": 13.41}
forecast["timezone"]   # e.g. "Europe/Berlin"
forecast["units"]      # {"temperature": "°C", "wind_speed": "km/h",
                       #  "precipitation_probability": "%"}
forecast["current"]    # {"temperature": ..., "weather_code": ..., "wind_speed": ...}
forecast["daily"]      # [{"date", "temperature_min", "temperature_max",
                       #   "precipitation_probability"}, ...]
```

Request parameters are built with `urllib.parse.urlencode` and select
`current=temperature_2m,weather_code,wind_speed_10m`,
`daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
`timezone=auto`, `forecast_days=<days>`.

## Validation and errors

- `ValueError` — invalid inputs, raised **before** any request:
  non-finite / non-numeric coordinates, latitude outside ±90, longitude
  outside ±180, `days` outside 1..7 (must be a plain `int`), plus invalid
  `timeout` / `base_url` at construction time.
- `WeatherError` (a `RuntimeError`) — upstream problems surfaced by the
  default transport: non-200 HTTP status, `HTTPError`/`URLError`/OS errors,
  malformed JSON, a non-object JSON payload, and missing, non-array,
  misaligned, empty, over-long, or non-numeric required daily/current fields.

Transport is injectable, which is how the tests stay deterministic and
offline:

```python
service = WeatherService(http_get=lambda url, timeout: payload, timeout=5.0)
```

`http_get` receives the fully encoded URL and the configured timeout and may
return `bytes`, `str`, a decoded mapping, or an `Exception` instance (raised
by `get_forecast`). Default timeout is 10 s.

## Open-Meteo licensing caveat

Open-Meteo's Forecast API is free **for non-commercial use only** and needs
no API key in that tier. The data are licensed **CC BY 4.0**, so attribution
to "Open-Meteo.com" is required when publishing results. **Commercial use is
not free**: it requires a separate Open-Meteo Commercial license (see
<https://open-meteo.com/en/terms> and the non-commercial terms). Nothing in
this module, its README, or its tests should be read as implying free
commercial use.

## Tests

```bash
pytest tests/workflow_smoke/test_pack_20261010_rerun3_weather.py
```

The suite mocks all transport with fixed JSON fixtures and mocked
`urlopen` failures — it performs no real network requests, uses no secrets,
and installs no new packages.
