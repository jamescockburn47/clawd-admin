#!/usr/bin/env node
// scripts/seed-sovren-contributions.mjs
//
// One-shot retroactive seed of the SOVREN contribution store.
//
// Captures Peter's three text contributions from 2026-04-11 (cover email,
// valuation template, and the trapped xlsx envelope) into the new store so
// that even before the new pipeline has processed any live messages, James
// has a working contribution index in the morning.
//
// Run on EVO: node scripts/seed-sovren-contributions.mjs
// Idempotent — safe to re-run; duplicate detection by file hash skips repeats.

import { ContributionStore } from '../src/sovren/contribution-store.js';
import { extractMethodology } from '../src/sovren/methodology-extractor.js';

const store = new ContributionStore();

const PETER_COVER_EMAIL = `I wanted to share with you an Excel spreadsheet where I performed a couple of valuations of a notional award against three different countries (Venezuela, Spain and Egypt). In each case I value the awards at three different stages (i) as a Claim (i.e. pre-Award); (ii) as an Award but pre-annulment; and (iii) as a post annulment Award).

The key Rows to look at in each case are Rows 26, 28 and 30.

This was the only way I could build the model to work in a way that reflects my views on the correct market valuation.

So Row 26 applies the algorithm more or less as we have been discussing. Row 28 discounts that raw figure by the Purchasers IRR (15%) for the expected number of years to recovery. This gives you Component 1 of the valuation.

Row 30 goes back to the raw valuation in Row 26 and multiplies it by the S factor (which is a number between zero and 1). This gives you Component 2 of the valuation.

Row 35 is the valuation. This is the average of Component 1 and Component 2.

I think that this works now.

Is there any way we can incorporate this into the working model?`;

const PETER_TEMPLATE = `Valuation of Award [Insert Title Here]

This arbitration award has been valued by Sovren© using a probabilistic recovery framework in which the present value of the expected recovery is calculated by projecting the future value of the award, applying a recovery coefficient reflecting enforcement and recovery risk, deducting expected enforcement costs, and discounting the resulting recovery to present value using an appropriate risk-adjusted rate of return.

Unlike conventional debt instruments, arbitration awards do not have fixed repayment schedules. Their economic value depends on the probability, magnitude, and timing of recovery, as well as legal, enforcement, and debtor-specific risk factors. Accordingly, this valuation applies an expected recovery framework, incorporating probabilistic recovery modelling, enforcement risk adjustments, and present value discounting consistent with market practice among arbitration award investors.

The starting point for the valuation is the determination of the awards face value, which represents the gross economic entitlement of the award creditor.

The face value includes, as applicable: Principal damages awarded; Attorneys fees and arbitration costs; Pre-award interest; Post-award interest accruing until payment; and Any other monetary relief granted by the tribunal.

Where applicable, post-award interest is projected forward to the estimated recovery date using the applicable interest rate specified in the award.

The economic value of the arbitration award is determined as the present value of expected recovery, net of enforcement costs and adjusted for settlement expectations and recovery risk.

The present value of the arbitration award is calculated by discounting the expected recovery amount to reflect the time value of money and risk-adjusted required returns. Sovren© utilises the S-factor©, which is a subjective, evidence-based recovery adjustment variable in the valuation algorithm. The S-Factor© incorporates multiple dimensions of recovery risk, including: Award debtor creditworthiness; Probability of successful enforcement; Expected magnitude of recovery; Availability and accessibility of attachable assets; Legal and jurisdictional enforcement constraints; Sovereign immunity considerations; Annulment and revision risk; Political and procedural factors affecting enforcement outcomes.

Time to recovery represents the expected duration required to realise recovery through enforcement or settlement. Longer recovery timelines reduce present value due to the effects of discounting.

As a validation step, the resulting valuation is benchmarked against the trading levels of comparable debt instruments issued by the award debtor, such as sovereign or corporate bonds.

The resulting valuation of the Award is [*******]`;

async function seedCoverEmail() {
  const receivedAt = '2026-04-11T18:40:18.154Z';
  console.log('seeding Peter cover email...');
  const extraction = await extractMethodology({
    contributorName: 'Peter',
    contributorSlug: 'peter',
    receivedAt,
    sourceKind: 'text',
    sourceFiles: [],
    textBody: PETER_COVER_EMAIL,
  });
  const entry = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt,
    kind: 'text',
    shortDescription:
      extraction.methodology?.shortDescription ??
      'Peter two-component-average construction (Row 26/28/30/35) for award valuation',
    coverText: PETER_COVER_EMAIL,
    methodology: extraction.methodology,
    extractionError: extraction.error,
    rawModelOutput: extraction.rawModelOutput,
  });
  console.log(`  -> ${entry.id} (methodology=${extraction.ok})`);
}

async function seedTemplate() {
  const receivedAt = '2026-04-11T18:42:03.764Z';
  console.log('seeding Peter Sovren template draft...');
  const extraction = await extractMethodology({
    contributorName: 'Peter',
    contributorSlug: 'peter',
    receivedAt,
    sourceKind: 'text',
    sourceFiles: [],
    textBody: PETER_TEMPLATE,
  });
  const entry = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt,
    kind: 'text',
    shortDescription:
      extraction.methodology?.shortDescription ??
      'Peter Sovren valuation report template v0 (probabilistic recovery framework)',
    coverText: PETER_TEMPLATE,
    methodology: extraction.methodology,
    extractionError: extraction.error,
    rawModelOutput: extraction.rawModelOutput,
  });
  console.log(`  -> ${entry.id} (methodology=${extraction.ok})`);
}

async function seedTrappedXlsx() {
  const receivedAt = '2026-04-11T22:04:11.839Z';
  console.log('seeding pending_attachment marker for trapped xlsx...');
  const placeholderText = `Spreadsheet "Arbitration Award Sovren Template.xlsx" was forwarded into the SOVREN WhatsApp group at 22:04 BST on 2026-04-11 by James (originally from Peter).

The bot received the message envelope but the .xlsx parser was not yet deployed at that point, so the file was not downloaded or parsed. The Baileys in-memory store does not persist across restarts, so the file is now only recoverable by re-forwarding from the original WhatsApp message.

When James re-forwards the file (with @Clint mention or in DM), the new pipeline will ingest it end-to-end and link it to this entry.`;
  const entry = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt,
    kind: 'xlsx',
    shortDescription:
      'Peter worked-examples spreadsheet (Venezuela, Spain, Egypt — three stages each) [pending re-forward]',
    coverText: placeholderText,
    status: 'pending_attachment',
  });
  console.log(`  -> ${entry.id} (status=pending_attachment)`);
}

async function main() {
  try {
    await seedCoverEmail();
  } catch (err) {
    console.error('cover email seed failed:', err.message);
  }
  try {
    await seedTemplate();
  } catch (err) {
    console.error('template seed failed:', err.message);
  }
  try {
    await seedTrappedXlsx();
  } catch (err) {
    console.error('trapped xlsx seed failed:', err.message);
  }

  const index = await store.loadIndex();
  console.log('\nfinal index:');
  console.log(`  ${index.contributions.length} entries`);
  for (const c of index.contributions) {
    console.log(`  - ${c.id} [${c.status}] ${c.shortDescription}`);
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
