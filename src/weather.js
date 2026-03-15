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
