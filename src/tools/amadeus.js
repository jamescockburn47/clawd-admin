import Amadeus from 'amadeus';
import config from '../config.js';

let client = null;

function getClient() {
  if (client) return client;
  client = new Amadeus({
    clientId: config.amadeusClientId,
    clientSecret: config.amadeusClientSecret,
  });
  return client;
}

// Known area coordinates for quick lookups
const AREA_COORDS = {
  // Core
  north_york_moors: { latitude: 54.35, longitude: -1.05 },
  york: { latitude: 53.96, longitude: -1.08 },
  helmsley: { latitude: 54.25, longitude: -1.06 },
  pickering: { latitude: 54.25, longitude: -0.78 },
  malton: { latitude: 54.14, longitude: -0.80 },
  // Rural/valleys
  kirkbymoorside: { latitude: 54.27, longitude: -0.94 },
  hovingham: { latitude: 54.18, longitude: -0.98 },
  hutton_le_hole: { latitude: 54.30, longitude: -0.92 },
  rosedale: { latitude: 54.33, longitude: -0.88 },
  farndale: { latitude: 54.34, longitude: -0.96 },
  glaisdale: { latitude: 54.44, longitude: -0.82 },
  // Coastal
  whitby: { latitude: 54.49, longitude: -0.62 },
  scarborough: { latitude: 54.28, longitude: -0.40 },
  robin_hoods_bay: { latitude: 54.43, longitude: -0.53 },
  staithes: { latitude: 54.56, longitude: -0.79 },
  runswick_bay: { latitude: 54.53, longitude: -0.74 },
  sandsend: { latitude: 54.50, longitude: -0.66 },
};

export async function hotelSearch({ latitude, longitude, checkin, checkout, adults, radius, area }) {
  const amadeus = getClient();

  // Resolve area name to coords if provided
  let lat = latitude;
  let lon = longitude;
  if (area && AREA_COORDS[area.toLowerCase().replace(/\s+/g, '_')]) {
    const coords = AREA_COORDS[area.toLowerCase().replace(/\s+/g, '_')];
    lat = coords.latitude;
    lon = coords.longitude;
  }

  if (!lat || !lon) {
    lat = AREA_COORDS.north_york_moors.latitude;
    lon = AREA_COORDS.north_york_moors.longitude;
  }

  // Step 1: Find hotels near the location
  const hotelList = await amadeus.referenceData.locations.hotels.byGeocode.get({
    latitude: lat,
    longitude: lon,
    radius: radius || 30,
    radiusUnit: 'KM',
    hotelSource: 'ALL',
  });

  const hotels = hotelList.data || [];
  if (hotels.length === 0) {
    return `No hotels found near ${area || `${lat}, ${lon}`}.`;
  }

  // If no dates provided, just list hotels without prices
  if (!checkin || !checkout) {
    const lines = hotels.slice(0, 10).map((h) =>
      `• ${h.name} (${h.address?.countryCode || 'GB'})`
    );
    return `*Hotels near ${area || 'location'}* (${hotels.length} found)\n\n${lines.join('\n')}\n\n_Provide check-in/check-out dates for live prices._`;
  }

  // Step 2: Get offers for top hotels
  const hotelIds = hotels.slice(0, 15).map((h) => h.hotelId);
  let offers;
  try {
    offers = await amadeus.shopping.hotelOffersSearch.get({
      hotelIds: hotelIds.join(','),
      checkInDate: checkin,
      checkOutDate: checkout,
      adults: adults || 2,
      currency: 'GBP',
    });
  } catch (err) {
    // Amadeus may return errors for no availability — handle gracefully
    if (err.response?.statusCode === 400) {
      return `No availability found near ${area || 'location'} for ${checkin} to ${checkout}. Try different dates or a wider search radius.`;
    }
    throw err;
  }

  const results = (offers.data || [])
    .filter((h) => h.offers && h.offers.length > 0)
    .map((h) => {
      const cheapest = h.offers.sort((a, b) =>
        parseFloat(a.price?.total || '99999') - parseFloat(b.price?.total || '99999')
      )[0];
      return {
        name: h.hotel?.name || 'Unknown',
        price: cheapest.price?.total || '?',
        currency: cheapest.price?.currency || 'GBP',
        room: cheapest.room?.description?.text || cheapest.room?.type || '',
        nights: Math.ceil((new Date(checkout) - new Date(checkin)) / (1000 * 60 * 60 * 24)),
      };
    })
    .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

  if (results.length === 0) {
    return `No availability found near ${area || 'location'} for ${checkin} to ${checkout}.`;
  }

  const lines = results.slice(0, 8).map((r) => {
    const perNight = r.nights > 0 ? ` (~£${(parseFloat(r.price) / r.nights).toFixed(0)}/night)` : '';
    return `• *${r.name}* — £${r.price}${perNight}\n  ${r.room}`;
  });

  return `*Hotels near ${area || 'location'}*\n${checkin} → ${checkout} (${results[0].nights} night${results[0].nights > 1 ? 's' : ''}), ${adults || 2} adults\n\n${lines.join('\n\n')}\n\n_${results.length} options found. Prices in ${results[0].currency}._`;
}
