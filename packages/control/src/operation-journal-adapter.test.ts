import {
  createMemoryJournalFixture,
  operationJournalAdapterConformance,
} from './journal-conformance.test-support.js';

operationJournalAdapterConformance(createMemoryJournalFixture);
