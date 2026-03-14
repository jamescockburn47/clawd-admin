import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchTrains, searchAccommodation } from '../src/tools/travel.js';

describe('searchTrains', () => {
  it('single journey generates LNER and National Rail links', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
    });
    assert.ok(result.includes('LNER'));
    assert.ok(result.includes('from=KGX'));
    assert.ok(result.includes('to=YRK'));
    assert.ok(result.includes('100426')); // DDMMYY for 2026-04-10
    assert.ok(result.includes('National Rail'));
    assert.ok(result.includes('10/04/2026'));
  });

  it('single journey includes time param when provided', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
      time: '18:00',
    });
    assert.ok(result.includes('outwardTime=1800'));
  });

  it('single journey with return generates both directions', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
      return_date: '2026-04-12',
    });
    assert.ok(result.includes('London Kings Cross → York'));
    assert.ok(result.includes('Return: York → London Kings Cross'));
    assert.ok(result.includes('12/04/2026'));
  });

  it('multi-leg trip generates links for each leg', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
      legs: [
        { from: 'London Kings Cross', to: 'York', date: '2026-04-10', time: '18:00' },
        { from: 'York', to: 'London Kings Cross', date: '2026-04-11', time: '10:00' },
        { from: 'London Kings Cross', to: 'York', date: '2026-04-11', time: '16:00' },
        { from: 'York', to: 'London Kings Cross', date: '2026-04-12', time: '17:00' },
      ],
    });
    assert.ok(result.includes('4 legs'));
    assert.ok(result.includes('Leg 1'));
    assert.ok(result.includes('Leg 2'));
    assert.ok(result.includes('Leg 3'));
    assert.ok(result.includes('Leg 4'));
    // Check all dates present
    assert.ok(result.includes('100426')); // Fri
    assert.ok(result.includes('110426')); // Sat (x2)
    assert.ok(result.includes('120426')); // Sun
    assert.ok(result.includes('TrainSplit'));
  });

  it('London-York corridor triggers specific tips', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
    });
    assert.ok(result.includes('KGX→York'));
    assert.ok(result.includes('Doncaster split'));
    assert.ok(result.includes('LNER Perks'));
  });

  it('non London-York route does not include corridor tips', async () => {
    const result = await searchTrains({
      from: 'Edinburgh',
      to: 'Newcastle',
      date: '2026-04-10',
    });
    assert.ok(!result.includes('Doncaster split'));
    assert.ok(!result.includes('KGX→York'));
  });

  it('peak hour warning triggers for 08:00', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
      time: '08:00',
    });
    assert.ok(result.includes('Peak hours'));
  });

  it('off-peak hour does not trigger warning', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
      time: '11:00',
    });
    assert.ok(!result.includes('Peak hours'));
  });

  it('unknown station still generates National Rail link', async () => {
    const result = await searchTrains({
      from: 'Skipton',
      to: 'York',
      date: '2026-04-10',
    });
    assert.ok(result.includes('National Rail'));
    assert.ok(result.includes('Skipton'));
  });

  it('legs inherit defaults from top-level params', async () => {
    const result = await searchTrains({
      from: 'London Kings Cross',
      to: 'York',
      date: '2026-04-10',
      time: '18:00',
      legs: [
        { from: 'London Kings Cross', to: 'York', date: '2026-04-10' },
      ],
    });
    assert.ok(result.includes('Leg 1'));
    assert.ok(result.includes('KGX'));
  });
});

describe('searchAccommodation', () => {
  it('generates Booking.com, Airbnb, Hotels.com links sorted by price', async () => {
    const result = await searchAccommodation({
      location: 'York',
      checkin: '2026-04-10',
      checkout: '2026-04-12',
    });
    assert.ok(result.includes('Booking.com'));
    assert.ok(result.includes('order=price'));
    assert.ok(result.includes('Airbnb'));
    assert.ok(result.includes('Hotels.com'));
    assert.ok(result.includes('PRICE_LOW_TO_HIGH'));
  });

  it('North York Moors area flag triggers NYM-specific content', async () => {
    const result = await searchAccommodation({
      location: 'Helmsley',
      checkin: '2026-04-10',
      checkout: '2026-04-11',
      area: 'north_york_moors',
    });
    assert.ok(result.includes('North York Moors'));
    assert.ok(result.includes('Helmsley'));
    assert.ok(result.includes('Hutton-le-Hole'));
    assert.ok(result.includes('Cottages.com'));
    assert.ok(result.includes('Star Inn'));
  });

  it('moors in location name triggers NYM content without area flag', async () => {
    const result = await searchAccommodation({
      location: 'North York Moors',
      checkin: '2026-04-10',
      checkout: '2026-04-11',
    });
    assert.ok(result.includes('North York Moors'));
    assert.ok(result.includes('Pickering'));
  });

  it('budget parameter adds budget tips', async () => {
    const result = await searchAccommodation({
      location: 'York',
      checkin: '2026-04-10',
      checkout: '2026-04-12',
      budget: 'budget',
    });
    assert.ok(result.includes('Premier Inn'));
    assert.ok(result.includes('Travelodge'));
  });

  it('weekend stay shows night count', async () => {
    const result = await searchAccommodation({
      location: 'York',
      checkin: '2026-04-10',
      checkout: '2026-04-12',
    });
    assert.ok(result.includes('2 night(s)'));
  });

  it('guests param is reflected in URLs', async () => {
    const result = await searchAccommodation({
      location: 'York',
      checkin: '2026-04-10',
      checkout: '2026-04-11',
      guests: 3,
    });
    assert.ok(result.includes('group_adults=3'));
    assert.ok(result.includes('adults=3'));
  });
});
