// Travel search tools — constructs search URLs and provides guidance
// These don't require API keys, they build useful search links

const STATION_CODES = {
  'london kings cross': 'KGX',
  'kings cross': 'KGX',
  'london st pancras': 'STP',
  'st pancras': 'STP',
  'london euston': 'EUS',
  'euston': 'EUS',
  'london paddington': 'PAD',
  'paddington': 'PAD',
  'london waterloo': 'WAT',
  'waterloo': 'WAT',
  'london liverpool street': 'LST',
  'liverpool street': 'LST',
  'london victoria': 'VIC',
  'victoria': 'VIC',
  'edinburgh': 'EDB',
  'edinburgh waverley': 'EDB',
  'york': 'YRK',
  'newcastle': 'NCL',
  'leeds': 'LDS',
  'manchester piccadilly': 'MAN',
  'manchester': 'MAN',
  'birmingham new street': 'BHM',
  'birmingham': 'BHM',
  'bristol temple meads': 'BRI',
  'bristol': 'BRI',
  'glasgow': 'GLC',
  'glasgow central': 'GLC',
  'cambridge': 'CBG',
  'oxford': 'OXF',
  'bath': 'BTH',
  'bath spa': 'BTH',
  'peterborough': 'PBO',
  'darlington': 'DAR',
  'doncaster': 'DON',
  'grantham': 'GRA',
  'inverness': 'INV',
  'aberdeen': 'ABD',
  'dundee': 'DEE',
  'durham': 'DHM',
  'berwick-upon-tweed': 'BWK',
  'stevenage': 'SVG',
};

function findStationCode(name) {
  const lower = name.toLowerCase().trim();
  return STATION_CODES[lower] || null;
}

function formatDate(dateStr) {
  // YYYY-MM-DD → DD/MM/YYYY
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateLNER(dateStr) {
  // YYYY-MM-DD → DDMMYY
  const [y, m, d] = dateStr.split('-');
  return `${d}${m}${y.slice(2)}`;
}

function getDayName(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
}

function buildLegLinks(from, to, date, time) {
  const fromCode = findStationCode(from);
  const toCode = findStationCode(to);
  const lnerDate = formatDateLNER(date);
  const dateFormatted = formatDate(date);
  const day = getDayName(date);
  const links = [];

  if (fromCode && toCode) {
    const timeParam = time ? `&outwardTime=${time.replace(':', '')}` : '';
    links.push(`LNER: https://www.lner.co.uk/travel-information/travelling-with-us/train-times/?from=${fromCode}&to=${toCode}&outwardDate=${lnerDate}${timeParam}`);
  }

  const nrFrom = encodeURIComponent(from);
  const nrTo = encodeURIComponent(to);
  const timeParam = time ? `&timeOfOutwardJourney=${time.replace(':', '')}` : '';
  links.push(`National Rail: https://www.nationalrail.co.uk/journey-planner/?from=${nrFrom}&to=${nrTo}&outwardDate=${dateFormatted}${timeParam}`);

  return { day, links };
}

export async function searchTrains({ from, to, date, time, return_date, legs }) {
  const results = [];

  // Multi-leg mode: generate links for each leg
  if (legs && legs.length > 0) {
    results.push(`🚄 **Train search — ${legs.length} legs**\n`);

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const { day, links } = buildLegLinks(
        leg.from || from,
        leg.to || to,
        leg.date || date,
        leg.time || time,
      );
      results.push(`**Leg ${i + 1}: ${leg.from || from} → ${leg.to || to}** (${day} ${leg.date || date}${leg.time ? ' ~' + leg.time : ''})`);
      for (const link of links) {
        results.push(`  ${link}`);
      }
    }

    results.push('');
    results.push(`💰 **TrainSplit** (check split ticketing for each leg): https://www.trainsplit.com/`);
  } else {
    // Single journey mode (original behaviour)
    const { day, links } = buildLegLinks(from, to, date, time);
    results.push(`🚄 **${from} → ${to}** (${day} ${date}${time ? ' ~' + time : ''})`);
    for (const link of links) {
      results.push(`  ${link}`);
    }

    // Trainline
    const trainlineUrl = `https://www.thetrainline.com/train-times/${from.toLowerCase().replace(/\s+/g, '-')}-to-${to.toLowerCase().replace(/\s+/g, '-')}`;
    results.push(`\n🎫 **Trainline**\n${trainlineUrl}`);

    // Return journey
    if (return_date) {
      const ret = buildLegLinks(to, from, return_date, null);
      results.push(`\n🔄 **Return: ${to} → ${from}** (${ret.day} ${return_date})`);
      for (const link of ret.links) {
        results.push(`  ${link}`);
      }
    }

    results.push(`\n💰 **TrainSplit**: https://www.trainsplit.com/`);
  }

  // Tips — context-aware for London-York corridor
  const corridor = [from, to].map((s) => s.toLowerCase());
  const isLondonYork = corridor.some((s) => s.includes('london') || s.includes('kings cross'))
    && corridor.some((s) => s.includes('york'));

  const tips = [];
  tips.push('\n💡 **Cheap ticket tips:**');
  tips.push('• Advance fares open 12 weeks ahead — cheapest option');
  tips.push('• Off-peak/super off-peak saves 50%+');
  tips.push('• Check TrainSplit for split ticketing savings');

  if (isLondonYork) {
    tips.push('• KGX→York is ~1h50 on LNER — fastest and most direct');
    tips.push('• Advance singles from ~£15-30 each way if booked early');
    tips.push('• Friday evening peak: expect £50-100+ unless booked well ahead');
    tips.push('• Sunday off-peak back to London is usually cheaper');
    tips.push('• LNER Perks loyalty — sign up for member fares');
    tips.push('• Consider Doncaster split: sometimes KGX→DON + DON→YRK is cheaper');
  }

  if (time) {
    const hour = parseInt(time.split(':')[0]);
    if (hour >= 7 && hour <= 9) {
      tips.push('• ⚠️ Peak hours — consider before 07:00 or after 09:30 for cheaper fares');
    }
  }

  return results.join('\n') + '\n' + tips.join('\n');
}

// North York Moors area — specific towns/villages within ~1hr of York
const NORTH_YORK_MOORS_AREAS = [
  'Helmsley',
  'Pickering',
  'Kirkbymoorside',
  'Hutton-le-Hole',
  'Goathland',
  'Whitby',
  'Robin Hoods Bay',
  'Thornton-le-Dale',
  'Malton',
  'Hovingham',
  'Osmotherley',
  'Rosedale Abbey',
  'Lastingham',
  'Cropton',
  'Scarborough',
];

export async function searchAccommodation({ location, checkin, checkout, guests = 2, budget, area }) {
  const results = [];
  const guestsParam = guests || 2;

  // If area is 'north_york_moors', provide area-specific search
  const isNYM = area === 'north_york_moors'
    || location.toLowerCase().includes('north york moors')
    || location.toLowerCase().includes('moors');

  const searchLocation = location;
  const loc = encodeURIComponent(searchLocation);

  // Booking.com
  const bookingUrl = `https://www.booking.com/searchresults.html?ss=${loc}&checkin=${checkin}&checkout=${checkout}&group_adults=${guestsParam}&no_rooms=1&order=price`;
  results.push(`🏨 **Booking.com** (sorted by price)\n${bookingUrl}`);

  // Airbnb
  const airbnbUrl = `https://www.airbnb.co.uk/s/${encodeURIComponent(searchLocation)}/homes?checkin=${checkin}&checkout=${checkout}&adults=${guestsParam}&price_max=100`;
  results.push(`🏠 **Airbnb** (under £100/night)\n${airbnbUrl}`);

  // Hotels.com
  const hotelsUrl = `https://uk.hotels.com/search.do?q-destination=${loc}&q-check-in=${checkin}&q-check-out=${checkout}&q-rooms=1&q-room-0-adults=${guestsParam}&sort-order=PRICE_LOW_TO_HIGH`;
  results.push(`🏩 **Hotels.com** (low→high)\n${hotelsUrl}`);

  if (isNYM) {
    results.push(`\n🏔️ **North York Moors — good areas to search:**`);
    results.push(`Within 30 min of York: Malton, Hovingham, Helmsley`);
    results.push(`Heart of the Moors: Hutton-le-Hole, Rosedale Abbey, Kirkbymoorside, Lastingham`);
    results.push(`Rural valleys: Farndale, Bransdale, Rosedale, Glaisdale`);
    results.push(`Towards the coast: Pickering, Thornton-le-Dale, Goathland, Whitby`);
    results.push(`Coast: Robin Hood's Bay, Staithes, Runswick Bay, Sandsend`);

    // Extra Booking.com search for Helmsley (popular NYM base)
    const helmsleyUrl = `https://www.booking.com/searchresults.html?ss=Helmsley%2C+North+Yorkshire&checkin=${checkin}&checkout=${checkout}&group_adults=${guestsParam}&no_rooms=1&order=price`;
    results.push(`\n🏡 **Booking.com — Helmsley** (popular NYM base)\n${helmsleyUrl}`);

    // Cottages.com for rural stays
    results.push(`\n🏠 **Cottages.com** (rural/holiday lets)\nhttps://www.cottages.com/search?region=north-york-moors`);

    // Glamping, pods, shepherd's huts
    results.push(`\n⛺ **Canopy & Stars** (glamping, shepherd's huts, treehouses)\nhttps://www.canopyandstars.co.uk/search?location=North+York+Moors`);

    const pitchupLoc = encodeURIComponent('North York Moors');
    results.push(`\n🏕️ **Pitchup.com** (camping, glamping, pods)\nhttps://www.pitchup.com/search/?q=${pitchupLoc}&date_from=${checkin}&date_to=${checkout}`);

    results.push(`\n🛖 **Hipcamp** (unique outdoor stays)\nhttps://www.hipcamp.com/en-GB/search?location=North+York+Moors`);

    // Coastal Booking.com
    const whitbyUrl = `https://www.booking.com/searchresults.html?ss=Whitby%2C+North+Yorkshire&checkin=${checkin}&checkout=${checkout}&group_adults=${guestsParam}&no_rooms=1&order=price`;
    results.push(`\n🌊 **Booking.com — Whitby** (coastal base)\n${whitbyUrl}`);

    results.push(`\n💡 **NYM accommodation tips:**`);
    results.push(`• B&Bs in Helmsley/Pickering often £60-90/night`);
    results.push(`• Pub rooms (e.g. Star Inn at Harome, Lion at Blakey Ridge) — good value with food`);
    results.push(`• Airbnb cottages in villages like Hutton-le-Hole, Rosedale — from ~£50/night`);
    results.push(`• Glamping pods/shepherd's huts: Canopy & Stars, Pitchup — from ~£40/night`);
    results.push(`• Camping: Spiers House (Cropton Forest), Hooks House (Robin Hood's Bay)`);
    results.push(`• Coastal: Whitby, Robin Hood's Bay, Staithes — great for Henry, easy drive from York`);
    results.push(`• Last-minute weekend deals on Booking.com — filter "free cancellation" + sort by price`);
  }

  // Budget guidance
  if (budget) {
    const budgetTips = {
      budget: '💰 Budget: Hostels, Premier Inn, Travelodge, or Airbnb rooms. Filter price low-to-high.',
      mid: '💰 Mid-range: Boutique B&Bs, Holiday Inn Express, Airbnb apartments. £80-150/night typical.',
      luxury: '💰 Luxury: 4-5 star on Booking.com, Airbnb Plus/Luxe, country house hotels.',
    };
    results.push(budgetTips[budget] || '');
  }

  // Weekend stay info
  const checkinDate = new Date(checkin);
  const checkoutDate = new Date(checkout);
  const nights = Math.round((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24));
  if (nights <= 3) {
    results.push(`\n📅 ${nights} night(s). Friday check-in often has better availability than Saturday.`);
  }

  return results.join('\n');
}
