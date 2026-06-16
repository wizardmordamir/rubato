/**
 * Deploy / release-integrity toolkit — public barrel.
 *
 * Everything needed to gather, generate, and verify deploy data from another app:
 * the pure correlation core (api/deploy) plus the IO glue (parse lists, join
 * multi-source records, run verification, format reports, build clients).
 *
 *   import { collectApps, verifyDeployList, buildDeployClients } from "rubato/deploy";
 */

export * from '../../api/deploy';
export * from './checkImages';
export * from './clients';
export * from './collect';
export * from './format';
export * from './parseList';
export * from './scanVulns';
export * from './verify';
