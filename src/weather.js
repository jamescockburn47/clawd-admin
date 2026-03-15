// Weather integration via OpenWeatherMap free tier
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

export async function fetchWeather(locationKey) {
  if (!config.weatherApiKey) return null;

  const loc = LOCATIONS[locationKey.toLowerCase()];
  if (!loc) {
    logger.warn({ location: locationKey }, 'unknown weather location');
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${loc.lat}&lon=${loc.lon}&appid=${config.weatherApiKey}&units=metric`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Weather API ${res.status}`);
    }

    const data = await res.json();

    return {
      location: loc.label,
      temp: Math.round(data.main.temp),
      feels_like: Math.round(data.main.feels_like),
      description: data.weather[0]?.description || '',
      condition: data.weather[0]?.main || '', // Clear, Clouds, Rain, Snow, etc.
      humidity: data.main.humidity,
      wind_mph: Math.round(data.wind.speed * 2.237),
    };
  } catch (err) {
    logger.error({ location: locationKey, err: err.message }, 'weather fetch error');
    return null;
  }
}

// Cached last successful weather for circuit breaker fallback
let lastWeather = [];

export async function fetchAllWeather() {
  if (!config.weatherApiKey || !config.weatherEnabled) return [];

  return weatherBreaker.call(async () => {
    const results = await Promise.all(
      config.weatherLocations.map(loc => fetchWeather(loc))
    );
    const filtered = results.filter(Boolean);
    if (filtered.length > 0) lastWeather = filtered;
    return filtered;
  }, () => lastWeather);
}
