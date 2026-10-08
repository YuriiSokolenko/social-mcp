# Open-Meteo weather service (disposable workflow smoke)

A small, synchronous, standard-library-only `WeatherService` around the
[Open-Meteo Forecast API](https://open-meteo.com/en/docs)
(`https://api.open-meteo.com/v1/forecast`). It exists to exercise the
Planner → Implementer → Reviewer → CI → Merge Gate pipeline; it is **not**
product functionality and is not wired into the MCP server, app, or CLI.

## Usage

```python
import sys

sys.path.insert(0, "examples/workflow-smoke/weather")

from weather import WeatherService

result = WeatherService().get_forecast(52.52, 13.41, days=3)

print(result["timezone"])  # e.g. "Europe/Berlin"
print(result["units"])  # unit labels echoed by Open-Meteo
print(result["current"])  # temperature, weather_code, wind_speed
for day in result["daily"]:
    print(day["date"], day["temperature_min"], day["temperature_max"],
          day["precipitation_probability"])
```

Returned shape (the keys are the public contract):

| key | value |
| --- | --- |
| `location` | `{"latitude": float, "longitude": float}` of the request |
| `timezone` | IANA timezone reported by Open-Meteo (`timezone=auto`) |
| `units` | `temperature`, `wind_speed`, `precipitation_probability` labels |
| `current` | `temperature`, `weather_code`, `wind_speed` |
| `daily` | one entry per day: `date`, `temperature_min`, `temperature_max`, `precipitation_probability` |

Requests use `current=temperature_2m,weather_code,wind_speed_10m`,
`daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
`timezone=auto`, and `forecast_days=<days>`, built with
`urllib.parse.urlencode`. `latitude` must be finite and within ±90, `longitude`
finite and within ±180, and `days` an `int` from 1 to 7; anything else raises
`ValueError`. Transport, HTTP/URL, JSON, and missing/misaligned array problems
raise `WeatherServiceError` instead of leaking `urllib` or `json` exceptions.
The default transport uses `urllib.request.urlopen` with a 10 second timeout;
pass `http_get=` to inject your own getter.

## Tests

Deterministic and offline: every test injects a fake HTTP getter, so no test
reaches the network.

```bash
.venv/bin/pytest tests/workflow_smoke/test_weather.py -q
```

## Source and attribution

Data source: [Open-Meteo](https://open-meteo.com/), source code at
<https://github.com/open-meteo/open-meteo>. Open-Meteo's data is licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and asks that the
source be credited, e.g. "Weather data by [Open-Meteo](https://open-meteo.com/)".

Open-Meteo requires no API key for **non-commercial** use only. That free tier
is **not** a commercial licence: commercial use needs a separate licence or
plan from Open-Meteo, and this example must not be taken as permitting it.
