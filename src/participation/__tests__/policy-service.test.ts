/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  getParticipationProfile,
  mergeParticipationProfile,
  resetParticipationProfilesForTest,
} from '../policy-service.js';

test('getParticipationProfile returns direct_only by default for unknown groups', () => {
  resetParticipationProfilesForTest();
  const profile = getParticipationProfile({
    chatJid: '123@g.us',
    groupLabel: 'Unknown Group',
    groupMode: 'colleague',
  });

  assert.equal(profile.posture, 'direct_only');
  assert.equal(profile.researchEnabled, true);
  assert.equal(profile.memoryRecallEnabled, true);
});

test('getParticipationProfile ignores invalid persisted overrides shapes like arrays', () => {
  const storePath = resetParticipationProfilesForTest();
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      overrides: [],
    }),
    'utf8',
  );

  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const profile = getParticipationProfile({
      chatJid: 'invalid@g.us',
      groupLabel: 'Invalid Store',
      groupMode: 'project',
    });

    assert.equal(profile.posture, 'direct_only');
    assert.equal(profile.groupMode, 'project');
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test('getParticipationProfile uses caller-supplied groupMode after merge', () => {
  resetParticipationProfilesForTest();

  mergeParticipationProfile('lqcore@g.us', {
    posture: 'rare_high_confidence',
    maxUnsolicitedPerHour: 4,
    followUpWindowMs: 180000,
  });

  const profile = getParticipationProfile({
    chatJid: 'lqcore@g.us',
    groupLabel: 'LQCore',
    groupMode: 'open',
  });

  assert.equal(profile.posture, 'rare_high_confidence');
  assert.equal(profile.maxUnsolicitedPerHour, 4);
  assert.equal(profile.groupMode, 'open');
});
