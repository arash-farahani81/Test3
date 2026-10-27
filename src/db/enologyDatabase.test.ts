import test from 'node:test';
import assert from 'node:assert/strict';
import { enologyDb } from './enologyDatabase.ts';
import { FermentationLogEntrySchema } from '../types/database.ts';
import { PRELOADED_ENOLOGY_COMPOUNDS, PRELOADED_ENOLOGY_PROTEINS } from '../data/bioscienceData.ts';
import {
  IDEAL_DEFAULT_PROTOCOL_PARAMS,
  getEffectiveProtocolPlanForBatch,
  notifyFlexibleProtocolSync
} from '../data/masterProtocolConfig.ts';
import { getSmartAdditivePresets } from '../data/smartLoggingPresets.ts';
import '../utils/rightNowEngine.test.ts';

test('enologyDb initial state loads batches and fermentation logs correctly', () => {
  const batches = enologyDb.getBatches();
  assert.ok(batches.length >= 2, 'Should have at least 2 default batches');
  assert.equal(batches[0].id, 'batch-rasha-1403');

  const logs = enologyDb.getLogs('tank-a');
  assert.ok(logs.length >= 7, 'Tank A should have at least 7 logs');

  // Test clearRealLogs preserves benchmarks and filters by tankId
  enologyDb.addLog({
    id: 'real-test-a',
    tankId: 'tank-a',
    dayNumber: 2,
    dateTime: '۱۴۰۳/۰۷/۲۶',
    timestampMs: Date.now(),
    stageTitle: 'تست لاگ واقعی',
    sg: 1.075,
    brix: 18.2,
    tempCap: 24,
    tempRoom: 21,
    ph: 3.52,
    pigeageDone: true,
    operationNote: 'تست',
    isBenchmark: false
  });
  assert.ok(enologyDb.getLogs('tank-a').some((l) => l.id === 'real-test-a'));
  enologyDb.clearRealLogs('tank-a');
  assert.ok(!enologyDb.getLogs('tank-a').some((l) => l.id === 'real-test-a'));
  assert.ok(enologyDb.getLogs('tank-a').every((l) => l.isBenchmark === true));
});

test('enologyDb supports adding, updating and deleting chemical additions', () => {
  const initialAdditions = enologyDb.getAdditions('tank-a');
  assert.ok(initialAdditions.some((a) => a.amount === 6.52), 'Should contain 6.52g initial KMS addition');
  assert.ok(initialAdditions.some((a) => a.amount === 3.43), 'Should contain 3.43g post-Saignee KMS addition');
  assert.ok(initialAdditions.some((a) => a.amount === 7.26), 'Should contain 7.26g Pectinase addition');

  const addition = enologyDb.addAddition({
    batchId: 'batch-rasha-1403',
    tankId: 'tank-a',
    timestamp: '۱۴۰۳/۰۷/۲۶ - ۱۵:۰۰',
    stageTitle: 'تست تغذیه',
    compoundName: 'DAP تست',
    pubchemCid: 24261,
    amount: 25,
    unit: 'g',
    purpose: 'تست آزمایشگاهی'
  });

  assert.ok(addition.id.startsWith('add-'), 'Should assign an id with prefix add-');
  const allAdditions = enologyDb.getAdditions('tank-a');
  assert.ok(allAdditions.some((a) => a.id === addition.id));

  // Clean up
  enologyDb.deleteAddition(addition.id);
  const afterDelete = enologyDb.getAdditions('tank-a');
  assert.ok(!afterDelete.some((a) => a.id === addition.id));

  // Verify Cumulative SO2 Ledger on Tank A (6.52g in 150L = 25.0 mg/L + 3.43g in 132L = 15.0 mg/L -> 40 mg/L + 15 mg/L yeast = 55 mg/L)
  const so2Ledger = enologyDb.getCumulativeSO2Ledger('tank-a');
  assert.equal(so2Ledger.addedFromKmsMgL, 40);
  assert.equal(so2Ledger.endogenousYeastMgL, 15);
  assert.equal(so2Ledger.estimatedTotalSO2MgL, 55);
  assert.equal(so2Ledger.legalCeilingMgL, 150);
  assert.equal(so2Ledger.remainingBudgetMgL, 95);
  assert.equal(so2Ledger.isOverBudget, false);
  assert.equal(so2Ledger.estimatedBoundAndVolatilizedRatio, 0.35);
  assert.ok(so2Ledger.accountingBasisFa.includes('Nominal Added SO2'));

  // Verify dynamic OIV ceiling for Rosé (200 mg/L dry, 250 mg/L >= 5 g/L RS) and Red >= 5 g/L RS (200 mg/L)
  assert.equal(enologyDb.getCumulativeSO2Ledger('tank-rose').legalCeilingMgL, 200);
  assert.equal(enologyDb.getCumulativeSO2Ledger('tank-rose', 32, 6.0).legalCeilingMgL, 250);
  assert.equal(enologyDb.getCumulativeSO2Ledger('tank-a', 132, 6.0).legalCeilingMgL, 200);
});

test('enologyDb supports saving and retrieving calculations', () => {
  const calc = enologyDb.saveCalculation({
    calculatorType: 'kms',
    title: 'تست محاسبه KMS',
    inputs: { volume: 100, currentSO2: 15, targetSO2: 35 },
    results: { kmsGrams: 3.51 },
    notes: 'آزمون ذخیره در پایگاه داده'
  });

  assert.ok(calc.id.startsWith('calc-'));
  const calcs = enologyDb.getSavedCalculations();
  assert.ok(calcs.some((c) => c.id === calc.id));

  // Clean up
  enologyDb.deleteCalculation(calc.id);
});

test('enologyDb exports valid JSON and CSV formats', () => {
  const jsonExport = enologyDb.exportDatabaseJSON();
  const parsed = JSON.parse(jsonExport);
  assert.ok(parsed.version);
  assert.ok(Array.isArray(parsed.fermentationLogs));
  assert.ok(Array.isArray(parsed.batches));

  const csv = enologyDb.exportLogsToCSV('tank-a');
  assert.ok(csv.startsWith('\uFEFF'), 'CSV should have UTF-8 BOM for Excel support');
  assert.ok(csv.includes('بریکس (Brix)'));
});

test('bioscienceData contains verified enology compounds and proteins', () => {
  assert.ok(PRELOADED_ENOLOGY_COMPOUNDS.length >= 10);
  const kms = PRELOADED_ENOLOGY_COMPOUNDS.find((c) => c.cid === 24446);
  assert.ok(kms, 'Potassium Metabisulfite must exist in database');
  assert.equal(kms.molecularFormula, 'K2S2O5');

  const tartaric = PRELOADED_ENOLOGY_COMPOUNDS.find((c) => c.cid === 875);
  assert.ok(tartaric, 'Tartaric acid must exist');
  assert.equal(tartaric.molecularFormula, 'C4H6O6');

  assert.ok(PRELOADED_ENOLOGY_PROTEINS.length >= 3);
  const adh1 = PRELOADED_ENOLOGY_PROTEINS.find((p) => p.accession === 'P00330');
  assert.ok(adh1, 'S. cerevisiae ADH1 must exist');
});

test('enologyDb supports structured compoundType, referenceVolumeL, stageBreakdown, excludeDemo, and soft-delete', () => {
  enologyDb.resetToFactoryDefaults();

  // Verify stageBreakdown on default demo KMS additions
  const initialLedger = enologyDb.getCumulativeSO2Ledger('tank-a');
  assert.equal(initialLedger.stageBreakdown.length, 2);
  assert.equal(initialLedger.stageBreakdown[0].referenceVolumeL, 150);
  assert.equal(initialLedger.stageBreakdown[0].contributedMgL, 25);
  assert.ok(initialLedger.stageBreakdown[0].formulaText.includes('150 L = 25 mg/L'));
  assert.equal(initialLedger.stageBreakdown[1].referenceVolumeL, 132);
  assert.equal(initialLedger.stageBreakdown[1].contributedMgL, 15);

  // Verify excludeDemo: true returns 0 added KMS when only demo records exist
  const realOnlyLedger = enologyDb.getCumulativeSO2Ledger('tank-a', undefined, 1.5, undefined, true);
  assert.equal(realOnlyLedger.addedFromKmsMgL, 0);
  assert.equal(realOnlyLedger.stageBreakdown.length, 0);

  const realBatch = enologyDb.addBatch({
    name: 'بچ واقعی تست سولفیت',
    vintageYear: 1405,
    startDate: '۱۴۰۵/۰۸/۰۱',
    grapeVariety: 'رشه سردشت',
    initialWeightKg: 400,
    targetStyle: 'red',
    status: 'active_fermentation',
    isDemo: false
  });

  // Add Bactiless (non-KMS) and structured KMS addition
  const bactilessAdd = enologyDb.addAddition({
    batchId: realBatch.id,
    tankId: 'tank-a',
    timestamp: '۱۴۰۵/۰۸/۰۵ - ۱۰:۰۰',
    stageTitle: 'روز ۱۱ - تثبیت میکروبی با بکتی‌لس',
    compoundName: 'Bactiless (کیتوزان قارچی مهارکننده سولفیت‌ساز نیست)',
    compoundType: 'bactiless',
    referenceVolumeL: 132,
    amount: 39.6,
    unit: 'g',
    purpose: 'حذف باکتری‌های اسید لاکتیک',
    isDemo: false
  });

  const realKmsAdd = enologyDb.addAddition({
    batchId: realBatch.id,
    tankId: 'tank-a',
    timestamp: '۱۴۰۵/۰۸/۰۵ - ۱۰:۱۵',
    stageTitle: 'روز ۱۱ - سولفیت‌زنی پس از پرس',
    compoundName: 'پتاسیم متابی‌سولفیت (KMS)',
    compoundType: 'kms',
    referenceVolumeL: 118,
    amount: 4.14,
    unit: 'g',
    purpose: 'تثبیت شراب خشک در ۱۱۸ لیتر',
    isDemo: false
  });

  const ledgerAfterRealAdd = enologyDb.getCumulativeSO2Ledger('tank-a', undefined, 1.5, undefined, true);
  assert.equal(ledgerAfterRealAdd.stageBreakdown.length, 1, 'Should include KMS and ignore Bactiless');
  assert.equal(ledgerAfterRealAdd.stageBreakdown[0].referenceVolumeL, 118);
  assert.equal(ledgerAfterRealAdd.addedFromKmsMgL, 20.2);

  // Soft-delete and restore
  enologyDb.softDeleteAddition(realKmsAdd.id);
  assert.ok(!enologyDb.getAdditions('tank-a').some((a) => a.id === realKmsAdd.id));
  assert.ok(enologyDb.getAdditions('tank-a', true).some((a) => a.id === realKmsAdd.id && a.isDeleted === true));
  assert.equal(enologyDb.getCumulativeSO2Ledger('tank-a', undefined, 1.5, undefined, true).addedFromKmsMgL, 0);

  enologyDb.restoreAddition(realKmsAdd.id);
  assert.ok(enologyDb.getAdditions('tank-a').some((a) => a.id === realKmsAdd.id));
  assert.equal(enologyDb.getCumulativeSO2Ledger('tank-a', undefined, 1.5, undefined, true).addedFromKmsMgL, 20.2);

  // Clean up
  enologyDb.deleteAddition(bactilessAdd.id);
  enologyDb.deleteAddition(realKmsAdd.id);
  enologyDb.resetToFactoryDefaults();
});

test('enologyDb supports previewDatabaseImport and importDatabaseJSON in merge mode', () => {
  enologyDb.resetToFactoryDefaults();
  const exportedJson = enologyDb.exportDatabaseJSON();

  const preview = enologyDb.previewDatabaseImport(exportedJson);
  assert.equal(preview.valid, true);
  assert.ok(preview.summary);
  assert.equal(preview.summary.batchesCount, 2);
  assert.equal(preview.summary.additionsCount, 6);

  // Add a new local addition then merge the backup
  const extraAdd = enologyDb.addAddition({
    batchId: 'batch-rasha-1403',
    tankId: 'tank-b',
    timestamp: '۱۴۰۵/۰۷/۲۸ - ۱۲:۰۰',
    stageTitle: 'تست ادغام',
    compoundName: 'تانن قرمز',
    compoundType: 'tannin_red',
    amount: 15,
    unit: 'g',
    purpose: 'تست merge'
  });

  const mergeRes = enologyDb.importDatabaseJSON(exportedJson, 'merge');
  assert.equal(mergeRes.success, true);
  assert.ok(enologyDb.getAdditions().some((a) => a.id === extraAdd.id), 'Merge mode must preserve existing unique records');
  assert.equal(enologyDb.getAdditions().length, 7, 'Merge mode must deduplicate overlapping IDs');

  enologyDb.resetToFactoryDefaults();
});

test('enologyDb row-level Zod salvage, timestamp-aware & soft-delete-safe merge, and unsavedChangesCount tracking', () => {
  enologyDb.resetToFactoryDefaults();
  // Export to reset unsavedChangesCount to 0
  enologyDb.exportDatabaseJSON();
  assert.equal(enologyDb.getBackupHealthStatus().unsavedChangesCount, 0);

  // 1. Verify updateLog and softDeleteLog increment unsavedChangesCount
  const addedLogs = enologyDb.addLog({
    id: 'test-mut-log-1',
    tankId: 'tank-a',
    batchId: 'batch-rasha-1403',
    dayNumber: 4,
    dateTime: '۱۴۰۵/۰۷/۲۸ - ۱۰:۰۰',
    timestampMs: 1700000000000,
    updatedAtMs: 1700000000000,
    stageTitle: 'تست لاگ',
    sg: 1.050,
    brix: 12.5,
    tempCap: 25,
    tempRoom: 21,
    ph: 3.52,
    pigeageDone: true,
    operationNote: 'نسخه اول',
    isBenchmark: false
  });
  assert.ok(addedLogs.some((l) => l.id === 'test-mut-log-1'));
  assert.equal(enologyDb.getBackupHealthStatus().unsavedChangesCount, 1);

  // Take a backup at t = 1700000000000 (resets unsavedChangesCount to 0)
  const olderBackupJson = enologyDb.exportDatabaseJSON();
  assert.equal(enologyDb.getBackupHealthStatus().unsavedChangesCount, 0);

  // Update the log locally (bumps updatedAtMs to Date.now() > 1700000000000 and increments unsavedChangesCount)
  enologyDb.updateLog('test-mut-log-1', { operationNote: 'نسخه جدیدتر ویرایش شده', sg: 1.045 });
  assert.equal(enologyDb.getBackupHealthStatus().unsavedChangesCount, 1);

  // Add another log and soft-delete it locally
  enologyDb.addLog({
    id: 'test-soft-del-log',
    tankId: 'tank-a',
    dayNumber: 5,
    dateTime: '۱۴۰۵/۰۷/۲۹ - ۱۰:۰۰',
    timestampMs: 1690000000000,
    updatedAtMs: 1690000000000,
    stageTitle: 'تست حذف نرم',
    sg: 1.040,
    brix: 10.0,
    tempCap: 24,
    tempRoom: 20,
    ph: 3.53,
    pigeageDone: false,
    operationNote: 'قرار است حذف شود',
    isBenchmark: false
  });
  const backupBeforeDelete = enologyDb.exportDatabaseJSON();
  assert.equal(enologyDb.getBackupHealthStatus().unsavedChangesCount, 0);

  enologyDb.softDeleteLog('test-soft-del-log');
  assert.equal(enologyDb.getBackupHealthStatus().unsavedChangesCount, 1);
  assert.ok(!enologyDb.getLogs('tank-a').some((l) => l.id === 'test-soft-del-log'));

  // 2. Merge older backup: must NOT overwrite newer local edit AND must NOT resurrect soft-deleted item
  enologyDb.importDatabaseJSON(olderBackupJson, 'merge');
  const mergedLog = enologyDb.getLogs('tank-a').find((l) => l.id === 'test-mut-log-1');
  assert.ok(mergedLog);
  assert.equal(mergedLog.operationNote, 'نسخه جدیدتر ویرایش شده');
  assert.equal(mergedLog.sg, 1.045);

  enologyDb.importDatabaseJSON(backupBeforeDelete, 'merge');
  assert.ok(
    !enologyDb.getLogs('tank-a').some((l) => l.id === 'test-soft-del-log'),
    'Soft-deleted local log must not be resurrected by older backup in merge mode'
  );

  // 3. Test row-level salvage via parseArrayWithSalvage
  const validLogs = enologyDb.getLogs('tank-a').slice(0, 2);
  const mixedPayload = JSON.stringify([
    validLogs[0],
    { id: 'malformed-log', sg: 'not-a-number' },
    validLogs[1]
  ]);
  const dbInternal = enologyDb as unknown as {
    parseArrayWithSalvage: (key: string, raw: string, schema: unknown, fallback: unknown[]) => Array<{ id: string }>;
  };
  const salvaged = dbInternal.parseArrayWithSalvage(
    'enology_db_logs_v1_test_salvage',
    mixedPayload,
    FermentationLogEntrySchema,
    []
  );
  assert.equal(salvaged.length, 2, 'Should salvage the 2 valid logs and skip the 1 malformed log');
  assert.ok(
    enologyDb.getStorageDiagnostics().corruptedKeysRecovered.includes('enology_db_logs_v1_test_salvage'),
    'Should record the corrupt key in getStorageDiagnostics().corruptedKeysRecovered'
  );

  enologyDb.resetToFactoryDefaults();
});

test('enologyDb isolates getCumulativeSO2Ledger by batchId, converts g/hL and kg KMS units, and supports softDeleteLabAnalysis/restoreLabAnalysis', () => {
  enologyDb.resetToFactoryDefaults();

  // Create two distinct batches on tank-a
  const batch1 = enologyDb.addBatch({
    name: 'بچ آزمایشی ۱',
    grapeVariety: 'رشه سردشت',
    vintageYear: 1405,
    initialWeightKg: 400,
    targetStyle: 'red',
    status: 'active_fermentation',
    startDate: '۱۴۰۵/۰۷/۰۱',
    isDemo: false
  });
  const batch2 = enologyDb.addBatch({
    name: 'بچ آزمایشی ۲',
    grapeVariety: 'رشه سردشت',
    vintageYear: 1405,
    initialWeightKg: 400,
    targetStyle: 'red',
    status: 'active_fermentation',
    startDate: '۱۴۰۵/۰۸/۰۱',
    isDemo: false
  });

  // Add KMS in g/hL to batch1 (5 g/hL = 28.5 mg/L in 100 L = 5 g)
  enologyDb.addAddition({
    batchId: batch1.id,
    tankId: 'tank-a',
    timestamp: '۱۴۰۵/۰۷/۰۲',
    stageTitle: 'سولفیت‌زنی بچ ۱',
    compoundName: 'KMS',
    compoundType: 'kms',
    referenceVolumeL: 100,
    amount: 5,
    unit: 'g/hL',
    purpose: 'تست واحد g/hL',
    isDemo: false
  });

  // Add KMS in kg to batch2 (0.01 kg = 10 g in 100 L = 57 mg/L)
  enologyDb.addAddition({
    batchId: batch2.id,
    tankId: 'tank-a',
    timestamp: '۱۴۰۵/۰۸/۰۲',
    stageTitle: 'سولفیت‌زنی بچ ۲',
    compoundName: 'KMS',
    compoundType: 'kms',
    referenceVolumeL: 100,
    amount: 0.01,
    unit: 'kg',
    purpose: 'تست واحد kg',
    isDemo: false
  });

  const ledgerBatch1 = enologyDb.getCumulativeSO2Ledger('tank-a', 100, 1.5, undefined, true, batch1.id);
  assert.equal(ledgerBatch1.batchId, batch1.id);
  assert.equal(ledgerBatch1.addedFromKmsMgL, 28.8, '5 g/hL KMS must equal 28.8 mg/L SO2');
  assert.equal(ledgerBatch1.totalKmsMassGrams, 5, '5 g/hL in 100 L must equal 5 g KMS');
  assert.equal(ledgerBatch1.stageBreakdown.length, 1);

  const ledgerBatch2 = enologyDb.getCumulativeSO2Ledger('tank-a', 100, 1.5, undefined, true, batch2.id);
  assert.equal(ledgerBatch2.batchId, batch2.id);
  assert.equal(ledgerBatch2.addedFromKmsMgL, 57.6, '0.01 kg (10 g) KMS in 100 L must equal 57.6 mg/L SO2');
  assert.equal(ledgerBatch2.totalKmsMassGrams, 10);
  assert.equal(ledgerBatch2.stageBreakdown.length, 1);

  // Verify softDeleteLabAnalysis and restoreLabAnalysis
  const labRec = enologyDb.addLabAnalysis({
    batchId: batch1.id,
    tankId: 'tank-a',
    date: '۱۴۰۵/۰۷/۰۵',
    testType: 'ph_meter',
    targetAnalyte: 'pH',
    measuredValue: 3.48,
    unit: 'pH',
    isDemo: false
  });
  assert.ok(enologyDb.getLabAnalyses('tank-a', false, batch1.id).some((a) => a.id === labRec.id));
  assert.equal(enologyDb.getLabAnalyses('tank-a', false, batch2.id).length, 0, 'Batch 2 should not see Batch 1 lab analyses');

  enologyDb.softDeleteLabAnalysis(labRec.id);
  assert.ok(!enologyDb.getLabAnalyses('tank-a', false, batch1.id).some((a) => a.id === labRec.id));
  assert.ok(
    enologyDb.getLabAnalyses('tank-a', true, batch1.id).some((a) => a.id === labRec.id && a.isDeleted === true)
  );

  enologyDb.restoreLabAnalysis(labRec.id);
  assert.ok(enologyDb.getLabAnalyses('tank-a', false, batch1.id).some((a) => a.id === labRec.id && a.isDeleted === false));

  enologyDb.resetToFactoryDefaults();
});

test('enologyDb supports updateBatchProtocolSnapshot, getOrphanRecordsSummary, and assignOrphanRecordsToBatch', () => {
  enologyDb.resetToFactoryDefaults();

  const targetBatch = enologyDb.addBatch({
    name: 'بچ هدف ۱۴۰۵',
    grapeVariety: 'رشه سردشت',
    vintageYear: 1405,
    initialWeightKg: 200,
    targetStyle: 'red',
    status: 'active_fermentation',
    startDate: '۱۴۰۵/۰۷/۱۰',
    notes: '',
    isDemo: false
  });

  // 1. Test updateBatchProtocolSnapshot
  const updatedBatch = enologyDb.updateBatchProtocolSnapshot(targetBatch.id, {
    ...IDEAL_DEFAULT_PROTOCOL_PARAMS,
    presetId: 'custom',
    grapeWeightKg: 200,
    redMashLiquidYieldFactor: 0.80
  });
  assert.ok(updatedBatch?.protocolParamsSnapshot);
  assert.equal(updatedBatch?.protocolParamsSnapshot?.grapeWeightKg, 200);
  assert.equal(updatedBatch?.protocolParamsSnapshot?.redMashLiquidYieldFactor, 0.80);

  // 2. Create orphan records pointing to a non-existent batchId
  enologyDb.addLog({
    id: 'orphan-log-1',
    batchId: 'batch-deleted-ghost',
    tankId: 'tank-a',
    dayNumber: 1,
    dateTime: '۱۴۰۵/۰۷/۱۱',
    stageTitle: 'روز ۱',
    sg: 1.088,
    brix: 21.0,
    tempCap: 23,
    tempRoom: 20,
    ph: 3.52,
    pigeageDone: true,
    isBenchmark: false,
    isDemo: false
  });
  enologyDb.addAddition({
    batchId: 'batch-deleted-ghost',
    tankId: 'tank-a',
    timestamp: '۱۴۰۵/۰۷/۱۱',
    stageTitle: 'روز ۱',
    compoundName: 'Fermaid O',
    compoundType: 'fermaid_o',
    amount: 16.5,
    unit: 'g',
    purpose: 'تست رکورد یتیم',
    isDemo: false
  });
  enologyDb.addLabAnalysis({
    batchId: 'batch-deleted-ghost',
    tankId: 'tank-a',
    date: '۱۴۰۵/۰۷/۱۱',
    testType: 'ph_meter',
    targetAnalyte: 'pH',
    measuredValue: 3.51,
    unit: 'pH',
    isDemo: false
  });

  const orphanSummaryBefore = enologyDb.getOrphanRecordsSummary();
  assert.equal(orphanSummaryBefore.orphanLogsCount, 1);
  assert.equal(orphanSummaryBefore.orphanAdditionsCount, 1);
  assert.equal(orphanSummaryBefore.orphanAnalysesCount, 1);

  enologyDb.assignOrphanRecordsToBatch(targetBatch.id);

  const orphanSummaryAfter = enologyDb.getOrphanRecordsSummary();
  assert.equal(orphanSummaryAfter.orphanLogsCount, 0);
  assert.equal(orphanSummaryAfter.orphanAdditionsCount, 0);
  assert.equal(orphanSummaryAfter.orphanAnalysesCount, 0);

  assert.ok(
    enologyDb.getLogs('tank-a', false, targetBatch.id).some((l) => l.id === 'orphan-log-1')
  );
  assert.equal(enologyDb.getAdditions('tank-a', false, targetBatch.id).length, 1);
  assert.equal(enologyDb.getLabAnalyses('tank-a', false, targetBatch.id).length, 1);

  enologyDb.resetToFactoryDefaults();
});

test('BUG-41: buildExportDatabaseJSON does not clear unsavedChangesCount until confirmBackupCompleted is called', () => {
  enologyDb.resetToFactoryDefaults();
  enologyDb.addLog({
    id: 'test-unconfirmed-backup-log',
    tankId: 'tank-a',
    dayNumber: 1,
    dateTime: '۱۴۰۵/۰۷/۱۲',
    stageTitle: 'روز ۱',
    sg: 1.09,
    brix: 21.5,
    tempCap: 22,
    tempRoom: 20,
    ph: 3.52,
    pigeageDone: true,
    isBenchmark: false
  });

  const beforeHealth = enologyDb.getBackupHealthStatus();
  assert.ok(beforeHealth.unsavedChangesCount > 0, 'Should have unsaved changes before backup');

  const json = enologyDb.buildExportDatabaseJSON();
  assert.ok(json.includes('test-unconfirmed-backup-log'));

  const midHealth = enologyDb.getBackupHealthStatus();
  assert.equal(
    midHealth.unsavedChangesCount,
    beforeHealth.unsavedChangesCount,
    'buildExportDatabaseJSON must not reset unsavedChangesCount prematurely'
  );

  enologyDb.confirmBackupCompleted();
  const afterHealth = enologyDb.getBackupHealthStatus();
  assert.equal(afterHealth.unsavedChangesCount, 0, 'confirmBackupCompleted must reset unsavedChangesCount');
  assert.equal(afterHealth.status, 'green');

  enologyDb.resetToFactoryDefaults();
});

test('BUG-43: getEffectiveProtocolPlanForBatch sanitizes malformed string/NaN entries in protocolParamsSnapshot', () => {
  const malformedBatch = {
    protocolParamsSnapshot: {
      grapeWeightKg: 'invalid-string' as unknown as number,
      initialBrix: Number.NaN,
      targetRedPH: 3.48,
      presetId: 'custom'
    }
  };

  const plan = getEffectiveProtocolPlanForBatch(malformedBatch);
  assert.equal(plan.params.grapeWeightKg, IDEAL_DEFAULT_PROTOCOL_PARAMS.grapeWeightKg);
  assert.equal(plan.params.initialBrix, IDEAL_DEFAULT_PROTOCOL_PARAMS.initialBrix);
  assert.equal(plan.params.targetRedPH, 3.48);
  assert.equal(plan.params.presetId, 'custom');
});

test('BUG-47 & BUG-53: getCumulativeSO2Ledger with excludeDemo=true does not leak demo batch additions when no real batch exists', () => {
  enologyDb.resetToFactoryDefaults();
  // In factory defaults, all batches have isDemo: true
  const ledgerDemoExcluded = enologyDb.getCumulativeSO2Ledger('tank-a', 132, 1.5, undefined, true);
  assert.equal(ledgerDemoExcluded.addedFromKmsMgL, 0);
  assert.equal(ledgerDemoExcluded.stageBreakdown.length, 0);

  // Legacy additions without batchId match demo batch when queried for batch-rasha-1403
  const demoAdditions = enologyDb.getAdditions('tank-a', false, 'batch-rasha-1403');
  assert.ok(demoAdditions.length >= 2, 'Demo batch should match legacy additions via matchesBatch');
});

test('BUG-46: importDatabaseJSON in merge mode restores flexibleProtocolParams if not already set in localStorage', () => {
  enologyDb.resetToFactoryDefaults();
  const rawExport = JSON.parse(enologyDb.buildExportDatabaseJSON());
  rawExport.flexibleProtocolParams = {
    ...IDEAL_DEFAULT_PROTOCOL_PARAMS,
    grapeWeightKg: 500
  };
  const mergeRes = enologyDb.importDatabaseJSON(JSON.stringify(rawExport), 'merge');
  assert.equal(mergeRes.success, true);
  enologyDb.resetToFactoryDefaults();
});

test('Micro-Task 2 Audit Fixes: BUG-05 (576 mg/g KMS), BUG-12 (protocol snapshot sync), BUG-13 (startRealBatchMode fallback batch), BUG-14 (clearRealLogs batchId isolation), and BUG-17 (KMS CID 24446)', () => {
  enologyDb.resetToFactoryDefaults();

  // BUG-13: Calling startRealBatchMode() with no arguments creates a fallback real batch so batches is never empty
  const fallbackRealBatch = enologyDb.startRealBatchMode();
  assert.ok(fallbackRealBatch, 'startRealBatchMode() without args must return a created real batch');
  assert.equal(fallbackRealBatch.isDemo, false);
  assert.equal(enologyDb.getBatches().length, 1);
  assert.equal(enologyDb.getBatches()[0].id, fallbackRealBatch.id);

  // BUG-12: Updating flexible protocol parameters syncs protocolParamsSnapshot on active batch
  notifyFlexibleProtocolSync({
    ...IDEAL_DEFAULT_PROTOCOL_PARAMS,
    presetId: 'custom',
    grapeWeightKg: 320
  });
  const syncedBatch = enologyDb.getBatchById(fallbackRealBatch.id);
  assert.equal(syncedBatch?.protocolParamsSnapshot?.grapeWeightKg, 320);

  // BUG-14: clearRealLogs(tankId, batchId) only clears logs of the specified batchId
  const secondBatch = enologyDb.addBatch({
    name: 'بچ واقعی دوم',
    grapeVariety: 'رشه سردشت',
    vintageYear: 1405,
    initialWeightKg: 400,
    targetStyle: 'red',
    status: 'active_fermentation',
    startDate: '۱۴۰۵/۰۸/۰۵',
    isDemo: false
  });
  enologyDb.addLog({
    id: 'log-b1',
    batchId: fallbackRealBatch.id,
    tankId: 'tank-a',
    dayNumber: 1,
    dateTime: '۱۴۰۵/۰۸/۰۱',
    stageTitle: 'روز ۱ بچ ۱',
    sg: 1.090,
    brix: 21.5,
    tempCap: 22,
    tempRoom: 20,
    ph: 3.52,
    pigeageDone: true,
    isBenchmark: false
  });
  enologyDb.addLog({
    id: 'log-b2',
    batchId: secondBatch.id,
    tankId: 'tank-a',
    dayNumber: 1,
    dateTime: '۱۴۰۵/۰۸/۰۵',
    stageTitle: 'روز ۱ بچ ۲',
    sg: 1.088,
    brix: 21.1,
    tempCap: 23,
    tempRoom: 20,
    ph: 3.50,
    pigeageDone: true,
    isBenchmark: false
  });

  enologyDb.clearRealLogs('tank-a', fallbackRealBatch.id);
  assert.ok(!enologyDb.getLogs('tank-a', false, fallbackRealBatch.id).some((l) => l.id === 'log-b1'));
  assert.ok(
    enologyDb.getLogs('tank-a', false, secondBatch.id).some((l) => l.id === 'log-b2'),
    'clearRealLogs with batchId must preserve logs belonging to other batches'
  );

  // BUG-17: Smart KMS presets use PubChem CID 24446 (Potassium Metabisulfite)
  const plan = getEffectiveProtocolPlanForBatch(syncedBatch);
  const presets = getSmartAdditivePresets(plan, 'tank-a');
  const kmsPresets = presets.filter((p) => p.id.startsWith('kms-'));
  assert.equal(kmsPresets.length, 4);
  for (const preset of kmsPresets) {
    assert.equal(preset.pubchemCid, 24446, `Preset ${preset.id} must have pubchemCid 24446`);
  }

  enologyDb.resetToFactoryDefaults();
});

test('EnologyDatabaseService: CellarEquipmentProfile defaults, presets, partial save, and backup round-trip', () => {
  enologyDb.resetToFactoryDefaults();

  // 1. Default profile is full_sardasht_pro with onboardingCompleted: false
  const initial = enologyDb.getEquipmentProfile();
  assert.equal(initial.presetId, 'full_sardasht_pro');
  assert.equal(initial.onboardingCompleted, false);
  assert.equal(enologyDb.isEquipmentOnboardingCompleted(), false);
  assert.equal(initial.primaryTankCount, 2);
  assert.equal(initial.producesRoseSaignee, true);
  assert.equal(initial.so2Instrument, 'ripper_iodine');

  // 2. Apply standard_artisan_home preset
  const artisan = enologyDb.applyEquipmentPreset('standard_artisan_home');
  assert.equal(artisan.presetId, 'standard_artisan_home');
  assert.equal(artisan.onboardingCompleted, true);
  assert.equal(enologyDb.isEquipmentOnboardingCompleted(), true);
  assert.equal(artisan.so2Instrument, 'none');
  assert.equal(artisan.producesRoseSaignee, false);
  assert.equal(artisan.primaryTankCount, 1);
  assert.equal(artisan.reagents.hasCopperSulfate, false);

  // 3. Apply minimal_plus_kit preset
  const minimal = enologyDb.applyEquipmentPreset('minimal_plus_kit');
  assert.equal(minimal.presetId, 'minimal_plus_kit');
  assert.equal(minimal.phInstrument, 'strips_or_pocket');
  assert.equal(minimal.pressingMethod, 'nylon_straining_bag_manual');
  assert.equal(minimal.hasPrecisionScale001g, false);
  assert.equal(minimal.reagents.hasBactilessOrLysozyme, false);

  // 4. Partial save merges top-level fields and nested reagents cleanly
  const custom = enologyDb.saveEquipmentProfile({
    presetId: 'custom',
    so2Instrument: 'aeration_oxidation',
    reagents: { hasCopperSulfate: true }
  });
  assert.equal(custom.presetId, 'custom');
  assert.equal(custom.so2Instrument, 'aeration_oxidation');
  assert.equal(custom.phInstrument, 'strips_or_pocket');
  assert.equal(custom.reagents.hasCopperSulfate, true);
  assert.equal(custom.reagents.hasBactilessOrLysozyme, false);

  // 5. Export JSON includes equipmentProfile and Import JSON ('replace') restores it
  const exportedJson = enologyDb.exportDatabaseJSON();
  const parsedExport = JSON.parse(exportedJson) as { equipmentProfile?: { presetId?: string } };
  assert.equal(parsedExport.equipmentProfile?.presetId, 'custom');

  enologyDb.resetToFactoryDefaults();
  assert.equal(enologyDb.getEquipmentProfile().presetId, 'full_sardasht_pro');

  const importRes = enologyDb.importDatabaseJSON(exportedJson, 'replace');
  assert.equal(importRes.success, true);
  const restored = enologyDb.getEquipmentProfile();
  assert.equal(restored.presetId, 'custom');
  assert.equal(restored.so2Instrument, 'aeration_oxidation');
  assert.equal(restored.reagents.hasCopperSulfate, true);

  enologyDb.resetToFactoryDefaults();
});

test('EnologyDatabaseService: per-tank yeast selection and strain-specific endogenous SO2 in CumulativeSO2Ledger', () => {
  enologyDb.resetToFactoryDefaults();

  // 1. Default selections: tank-a -> lalvin-rc-212, tank-rose -> lalvin-rhone-4600
  assert.equal(enologyDb.getSelectedYeastIdForTank('tank-a'), 'lalvin-rc-212');
  assert.equal(enologyDb.getSelectedYeastIdForTank('tank-b'), 'lalvin-rc-212');
  assert.equal(enologyDb.getSelectedYeastIdForTank('tank-rose'), 'lalvin-rhone-4600');

  const defaultLedger = enologyDb.getCumulativeSO2Ledger('tank-a');
  assert.equal(defaultLedger.endogenousYeastMgL, 15);
  assert.equal(defaultLedger.activeYeastStrainId, 'lalvin-rc-212');

  // 2. Setting Zymaflore XPURE on tank-a updates endogenousYeastMgL to 4 mg/L
  enologyDb.setSelectedYeastForTank('tank-a', 'laffort-zymaflore-xpure');
  assert.equal(enologyDb.getSelectedYeastIdForTank('tank-a'), 'laffort-zymaflore-xpure');

  const xpureLedger = enologyDb.getCumulativeSO2Ledger('tank-a');
  assert.equal(xpureLedger.endogenousYeastMgL, 4);
  assert.equal(xpureLedger.activeYeastStrainId, 'laffort-zymaflore-xpure');

  enologyDb.resetToFactoryDefaults();
});

test('EnologyDatabaseService: deleteBatch atomic cascade deletion and addLog 1500ms rapid double-submit deduplication (Audit Remediation Part 2)', () => {
  enologyDb.resetToFactoryDefaults();

  const tempBatch = enologyDb.addBatch({
    name: 'بچ آزمایشی حذف آبشاری',
    grapeVariety: 'رشه سردشت',
    vintageYear: 1405,
    initialWeightKg: 200,
    targetStyle: 'red',
    status: 'active_fermentation',
    startDate: '۱۴۰۵/۰۷/۱۰',
    isDemo: false,
    volumeBasis: 'gross_mash'
  });

  // Rapid double-submit within 500ms with different IDs but identical tankId, batchId, dayNumber, and SG
  const baseTs = Date.now();
  enologyDb.addLog({
    id: 'dup-log-1',
    batchId: tempBatch.id,
    tankId: 'tank-a',
    dayNumber: 3,
    dateTime: '۱۴۰۵/۰۷/۱۳ - ۱۰:۰۰',
    timestampMs: baseTs,
    stageTitle: 'روز ۳ ثبت اول',
    brix: 18.0,
    sg: 1.074,
    tempCap: 24.0,
    tempRoom: 21.0,
    ph: 3.52,
    pigeageDone: true,
    isBenchmark: false
  });
  enologyDb.addLog({
    id: 'dup-log-2',
    batchId: tempBatch.id,
    tankId: 'tank-a',
    dayNumber: 3,
    dateTime: '۱۴۰۵/۰۷/۱۳ - ۱۰:۰۰',
    timestampMs: baseTs + 500,
    stageTitle: 'روز ۳ ثبت تکراری ۵۰۰ms',
    brix: 18.0,
    sg: 1.074,
    tempCap: 24.5,
    tempRoom: 21.0,
    ph: 3.52,
    pigeageDone: true,
    isBenchmark: false
  });

  const batchRealLogs = enologyDb
    .getLogs('tank-a', false, tempBatch.id)
    .filter((l) => !l.isBenchmark);
  assert.equal(batchRealLogs.length, 1);
  assert.equal(batchRealLogs[0].id, 'dup-log-1');
  assert.equal(batchRealLogs[0].tempCap, 24.5);

  enologyDb.addAddition({
    batchId: tempBatch.id,
    tankId: 'tank-a',
    timestamp: '۱۴۰۵/۰۷/۱۳',
    stageTitle: 'تغذیه',
    compoundName: 'Fermaid O',
    compoundType: 'fermaid_o',
    amount: 16.5,
    unit: 'g',
    purpose: 'تست حذف آبشاری'
  });

  enologyDb.addLabAnalysis({
    batchId: tempBatch.id,
    tankId: 'tank-a',
    date: '۱۴۰۵/۰۷/۱۳',
    testType: 'ph_meter',
    targetAnalyte: 'pH',
    measuredValue: 3.52,
    unit: 'pH'
  });

  // Delete batch with cascadeDeleteRecords = true
  enologyDb.deleteBatch(tempBatch.id, true);
  assert.equal(enologyDb.getBatchById(tempBatch.id), undefined);
  assert.equal(
    enologyDb.getLogs(undefined, true).some((l) => l.batchId === tempBatch.id),
    false
  );
  assert.equal(
    enologyDb.getAdditions(undefined, true).some((a) => a.batchId === tempBatch.id),
    false
  );
  assert.equal(
    enologyDb.getLabAnalyses(undefined, true).some((a) => a.batchId === tempBatch.id),
    false
  );
  // Benchmark logs must still be preserved
  assert.ok(enologyDb.getLogs('tank-a').some((l) => l.isBenchmark === true));

  // Verify hasDemoData() detects demo logs and demo labAnalyses even when demo batches and additions are removed
  enologyDb.startRealBatchMode();
  assert.equal(enologyDb.hasDemoData(), false);

  enologyDb.addLog({
    id: 'demo-log-only',
    tankId: 'tank-a',
    dayNumber: 1,
    dateTime: '۱۴۰۵/۰۷/۱۱',
    stageTitle: 'لاگ دمو',
    brix: 21,
    sg: 1.088,
    tempCap: 22,
    tempRoom: 20,
    ph: 3.52,
    pigeageDone: false,
    isBenchmark: false,
    isDemo: true
  });
  assert.equal(enologyDb.hasDemoData(), true, 'hasDemoData must return true when a non-deleted demo log exists');
  enologyDb.deleteLog('demo-log-only');
  assert.equal(enologyDb.hasDemoData(), false);

  const demoAnalysis = enologyDb.addLabAnalysis({
    batchId: 'batch-real',
    tankId: 'tank-a',
    date: '۱۴۰۵/۰۷/۱۱',
    testType: 'hydrometer_temp',
    targetAnalyte: 'SG',
    measuredValue: 1.088,
    unit: 'SG',
    isDemo: true
  });
  assert.equal(enologyDb.hasDemoData(), true, 'hasDemoData must return true when a non-deleted demo labAnalysis exists');
  enologyDb.deleteLabAnalysis(demoAnalysis.id);
  assert.equal(enologyDb.hasDemoData(), false);

  enologyDb.resetToFactoryDefaults();
});

test('enologyDb preserves multiple same-day corrupt JSON recoveries, preserves undated local records in merge mode, and saves pre-replace backup snapshot', () => {
  enologyDb.resetToFactoryDefaults();

  const store = new Map<string, string>();
  const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const mockStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    }
  };
  (globalThis as { localStorage?: Storage }).localStorage = mockStorage;

  try {
    const dbInternal = enologyDb as unknown as {
      parseArrayWithSalvage: (
        key: string,
        raw: string,
        schema: unknown,
        fallback: unknown[]
      ) => Array<{ id: string }>;
    };

    // 1. Two corrupt JSON recoveries on the same key and same day must not overwrite each other
    dbInternal.parseArrayWithSalvage(
      'enology_db_logs_v1_same_day',
      '{broken_json_first',
      FermentationLogEntrySchema,
      []
    );
    dbInternal.parseArrayWithSalvage(
      'enology_db_logs_v1_same_day',
      '{broken_json_second',
      FermentationLogEntrySchema,
      []
    );

    const dateSuffix = new Date().toISOString().slice(0, 10);
    const baseCorruptKey = `corrupt_enology_db_logs_v1_same_day_${dateSuffix}`;
    assert.equal(mockStorage.getItem(baseCorruptKey), '{broken_json_first');

    const timestampedKeys = Array.from(store.keys()).filter((k) =>
      k.startsWith(`${baseCorruptKey}_`)
    );
    assert.equal(timestampedKeys.length, 1, 'Second same-day corrupt recovery must use timestamped suffix');
    assert.equal(mockStorage.getItem(timestampedKeys[0]), '{broken_json_second');

    // 2. Undated local records (existingTime === 0 && incomingTime === 0) must be preserved in merge mode
    const exportJson = enologyDb.exportDatabaseJSON();
    const parsedExport = JSON.parse(exportJson) as {
      batches: Array<{
        id: string;
        name: string;
        grapeVariety: string;
        vintageYear: number;
        initialWeightKg: number;
        targetStyle: 'red' | 'rose' | 'both';
        status: 'planning' | 'active_fermentation' | 'mlf_aging' | 'bottled';
        startDate: string;
        notes?: string;
        isDemo?: boolean;
        updatedAtMs?: number;
      }>;
    };

    // Mutate local batch-rasha-1403 to be non-demo and undated with custom local name
    const localBatch = enologyDb.getBatchById('batch-rasha-1403');
    assert.ok(localBatch);
    localBatch.name = 'نسخه محلی ویرایش شده بدون تاریخ';
    localBatch.isDemo = false;
    delete (localBatch as { updatedAtMs?: number }).updatedAtMs;

    // Prepare incoming backup where batch-rasha-1403 is also undated (updatedAtMs: undefined) with an older/different name
    parsedExport.batches[0].name = 'نسخه قدیمی ورودی بدون تاریخ';
    parsedExport.batches[0].isDemo = false;
    delete parsedExport.batches[0].updatedAtMs;

    const mergeResult = enologyDb.importDatabaseJSON(JSON.stringify(parsedExport), 'merge');
    assert.equal(mergeResult.success, true);
    assert.equal(
      enologyDb.getBatchById('batch-rasha-1403')?.name,
      'نسخه محلی ویرایش شده بدون تاریخ',
      'Merge mode must preserve local undated non-demo record over undated incoming record'
    );

    // 3. Replace mode must save pre-replace snapshot to 'enology_pre_replace_backup_snapshot_v1'
    const replaceResult = enologyDb.importDatabaseJSON(JSON.stringify(parsedExport), 'replace');
    assert.equal(replaceResult.success, true);
    const preReplaceSnapshot = mockStorage.getItem('enology_pre_replace_backup_snapshot_v1');
    assert.ok(preReplaceSnapshot, 'Replace mode must write enology_pre_replace_backup_snapshot_v1');
    assert.ok(
      preReplaceSnapshot.includes('نسخه محلی ویرایش شده بدون تاریخ'),
      'Pre-replace snapshot must contain the state prior to replacement'
    );
    assert.equal(
      enologyDb.getBatchById('batch-rasha-1403')?.name,
      'نسخه قدیمی ورودی بدون تاریخ'
    );

    // 4. Malformed JSON must return specific JSON syntax error message
    const badJsonResult = enologyDb.importDatabaseJSON('{not_valid_json', 'replace');
    assert.equal(badJsonResult.success, false);
    assert.equal(badJsonResult.message, 'فایل پشتیبان نامعتبر است: خطای ساختار JSON.');
  } finally {
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
    }
    enologyDb.resetToFactoryDefaults();
  }
});
