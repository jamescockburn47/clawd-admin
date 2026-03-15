// Weather integration via Open-Meteo (free, no API key required)
import config from './config.js';
import logger from './logger.js';
import { CircuitBreaker } from './circuit-breaker.js';

const weatherBreaker = new CircuitBreaker('weather', { threshold: 3, resetTimeout: 120000 });

const LOCATIONS = {
  london: { lat: 51.5074, lon: -0.1278, label: 'London' },
  york: { lat: 53.9591, lon: -1.0815, label: 'York' },
  helmsley: { lat: 54.2465, lon: -1.0636, label: 'Helmsley' },
  whitby: { lat: 54.4858, lon: -0.6206, label: 'Whitby' },
  pickering: { lat: 54.2483, lon: -0.7764, label: 'Pickering' },
  ingleton: { lat: 54.1505, lon: -2.4705, label: 'Ingleton' },
  skipton: { lat: 53.9615, lon: -2.0174, label: 'Skipton' },
  richmond: { lat: 54.4034, lon: -1.7377, label: 'Richmond' },
  thirsk: { lat: 54.2327, lon: -1.3413, label: 'Thirsk' },
  scarborough: { lat: 54.2796, lon: -0.4004, label: 'Scarborough' },
  harrogate: { lat: 53.9921, lon: -1.5418, label: 'Harrogate' },
  malton: { lat: 54.1367, lon: -0.7972, label: 'Malton' },
  northallerton: { lat: 54.3385, lon: -1.4287, label: 'Northallerton' },
  leyburn: { lat: 54.3098, lon: -1.8302, label: 'Leyburn' },
  settle: { lat: 54.0679, lon: -2.2788, label: 'Settle' },
  robin_hoods_bay: { lat: 54.4340, lon: -0.5344, label: "Robin Hood's Bay" },
  hutton_le_hole: { lat: 54.2930, lon: -0.9240, label: 'Hutton le Hole' },
  goathland: { lat: 54.4000, lon: -0.7250, label: 'Goathland' },
  osmotherley: { lat: 54.3530, lon: -1.2880, label: 'Osmotherley' },
  chapel_le_dale: { lat: 54.1850, lon: -2.4930, label: 'Chapel le Dale' },
};

// Open-Meteo WMO weather codes → description
const WMO_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

// Map WMO codes to simple condition groups (for dashboard icons/styling)
function wmoToCondition(code) {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Clouds';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Rain';
  if (code <= 86) return 'Snow';
  return 'Thunderstorm';
}

export async function fetchWeather(locationKey) {
  const loc = LOCATIONS[locationKey.toLowerCase()];
  if (!loc) {
    logger.warn({ location: locationKey }, 'unknown weather location');
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&wind_speed_unit=mph&timezone=Europe%2FLondon`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Open-Meteo API ${res.status}`);
    }

    const data = await res.json();
    const current = data.current;
    const code = current.weather_code;

    return {
      location: loc.label,
      temp: Math.round(current.temperature_2m),
      feels_like: Math.round(current.apparent_temperature),
      description: WMO_CODES[code] || `Code ${code}`,
      condition: wmoToCondition(code),
      humidity: current.relative_humidity_2m,
      wind_mph: Math.round(current.wind_speed_10m),
    };
  } catch (err) {
    logger.error({ location: locationKey, err: err.message }, 'weather fetch error');
    return null;
  }
}

// --- Daily forecast for specific dates (up to 16 days ahead) ---

export async function fetchDailyForecast(locationKey, startDate, endDate) {
  const loc = LOCATIONS[locationKey.toLowerCase()];
  if (!loc) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&wind_speed_unit=mph&timezone=Europe%2FLondon&start_date=${startDate}&end_date=${endDate}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`Open-Meteo forecast ${res.status}`);

    const data = await res.json();
    const daily = data.daily;
    if (!daily || !daily.time) return null;

    const days = daily.time.map((date, i) => {
      const code = daily.weather_code[i];
      return {
        date,
        high: Math.round(daily.temperature_2m_max[i]),
        low: Math.round(daily.temperature_2m_min[i]),
        description: WMO_CODES[code] || `Code ${code}`,
        condition: wmoToCondition(code),
        rainChance: daily.precipitation_probability_max[i],
        windMax: Math.round(daily.wind_speed_10m_max[i]),
      };
    });

    return { location: loc.label, days };
  } catch (err) {
    logger.error({ location: locationKey, err: err.message }, 'forecast fetch error');
    return null;
  }
}

// Extract a known Yorkshire location from event/booking text, default to York
// Checks specific places first (villages/towns), then falls back to nearest town
export function extractLocation(text) {
  const lower = (text || '').toLowerCase();

  // Specific villages/hamlets first
  if (lower.includes('chapel le dale')) return 'chapel_le_dale';
  if (lower.includes('hutton le hole') || lower.includes('hutton-le-hole')) return 'hutton_le_hole';
  if (lower.includes('robin hood')) return 'robin_hoods_bay';
  if (lower.includes('goathland')) return 'goathland';
  if (lower.includes('osmotherley')) return 'osmotherley';

  // Towns
  if (lower.includes('helmsley')) return 'helmsley';
  if (lower.includes('whitby')) return 'whitby';
  if (lower.includes('pickering')) return 'pickering';
  if (lower.includes('ingleton')) return 'ingleton';
  if (lower.includes('skipton')) return 'skipton';
  if (lower.includes('richmond')) return 'richmond';
  if (lower.includes('thirsk')) return 'thirsk';
  if (lower.includes('scarborough')) return 'scarborough';
  if (lower.includes('harrogate')) return 'harrogate';
  if (lower.includes('malton')) return 'malton';
  if (lower.includes('northallerton')) return 'northallerton';
  if (lower.includes('leyburn')) return 'leyburn';
  if (lower.includes('settle')) return 'settle';

  // Regional hints — map to nearest representative location
  if (lower.includes('yorkshire dales') || lower.includes('dales')) return 'leyburn';
  if (lower.includes('north york moors') || lower.includes('moors')) return 'helmsley';
  if (lower.includes('york')) return 'york';

  return 'york';
}

// Cached last successful weather for circuit breaker fallback
let lastWeather = [];

export async function fetchAllWeather() {
  if (!config.weatherEnabled) return [];

  return weatherBreaker.call(async () => {
    const results = await Promise.all(
      config.weatherLocations.map(loc => fetchWeather(loc))
    );
    const filtered = results.filter(Boolean);
    if (filtered.length > 0) lastWeather = filtered;
    return filtered;
  }, () => lastWeather);
}
