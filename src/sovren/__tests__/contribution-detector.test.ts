/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectContribution, getSovrenGroupJid } from '../contribution-detector.js';

test('detector matches Peter in the SOVREN group', () => {
  const result = detectContribution({
    chatJid: getSovrenGroupJid(),
    isGroup: true,
    senderJid: 'peter@lid',
    senderName: 'Peter',
    text: 'here is my model',
    fileName: null,
  });
  assert.equal(result.isContribution, true);
  assert.equal(result.contributor?.slug, 'peter');
  assert.equal(result.reason, 'sovren_group_registered_contributor');
});

test('detector matches James + sovren keyword in any chat', () => {
  const result = detectContribution({
    chatJid: 'someother@g.us',
    isGroup: true,
    senderJid: '447719697305:3@s.whatsapp.net',
    senderName: 'James C',
    text: 'updated SOVREN config',
    fileName: null,
  });
  assert.equal(result.isContribution, true);
  assert.equal(result.contributor?.slug, 'james');
  assert.equal(result.reason, 'registered_contributor_sovren_keyword');
});

test('detector matches sovren keyword in filename for registered contributor', () => {
  const result = detectContribution({
    chatJid: 'tom@s.whatsapp.net',
    isGroup: false,
    senderJid: 'james@s.whatsapp.net',
    senderName: 'James C',
    text: '',
    fileName: 'sovren-model-v2.xlsx',
  });
  assert.equal(result.isContribution, true);
});

test('detector rejects unknown sender', () => {
  const result = detectContribution({
    chatJid: getSovrenGroupJid(),
    isGroup: true,
    senderJid: 'someone@lid',
    senderName: 'Random Stranger',
    text: 'sovren',
    fileName: null,
  });
  assert.equal(result.isContribution, false);
  assert.equal(result.reason, 'not_a_contribution');
});

test('detector rejects registered contributor without SOVREN context', () => {
  const result = detectContribution({
    chatJid: 'random@g.us',
    isGroup: true,
    senderJid: 'peter@lid',
    senderName: 'Peter',
    text: 'unrelated chat',
    fileName: 'unrelated.pdf',
  });
  assert.equal(result.isContribution, false);
});
