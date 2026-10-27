import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDefaultIdealNutrientInventoryGrams,
  optimizeNutrientScheduleFromInventory
} from './nutrientInventoryOptimizer.ts';

test('optimizeNutrientScheduleFromInventory — 1. Standard Ideal Inventory yields ideal_standard and zero deficit', () => {
  const defaultInv = getDefaultIdealNutrientInventoryGrams(400, true);
  assert.equal(defaultInv.isCustomInventoryActive, false);
  assert.equal(defaultInv.goFermGrams, 90);
  assert.equal(defaultInv.fermaidOGrams, 160);
  assert.equal(defaultInv.fermaidKGrams, 75);
  assert.equal(defaultInv.dapGrams, 45);

  const activeFullResult = optimizeNutrientScheduleFromInventory({
    inventory: {
      isCustomInventoryActive: true,
      goFermGrams: 90,
      fermaidOGrams: 165,
      fermaidKGrams: 75,
      dapGrams: 45,
      zincSulfateGrams: 1.0
    },
    redLiquidPerTankL: 132,
    redTankCount: 2,
    roseLiquidL: 32,
    produceRose: true
  });

  assert.equal(activeFullResult.isOptimizedFromCustomInventory, true);
  assert.equal(activeFullResult.strategyMode, 'ideal_standard');
  assert.equal(activeFullResult.hasNitrogenDeficit, false);
  assert.equal(activeFullResult.deficitAlertFa, null);
  assert.equal(activeFullResult.recommendations.length, 0);
});

test('optimizeNutrientScheduleFromInventory — 2. Low Fermaid O + High Fermaid K & DAP rebalances into SNA-1/SNA-2 and prioritizes SNA-3', () => {
  const rebalancedKDap = optimizeNutrientScheduleFromInventory({
    inventory: {
      isCustomInventoryActive: true,
      goFermGrams: 90,
      fermaidOGrams: 80,
      fermaidKGrams: 150,
      dapGrams: 100,
      zincSulfateGrams: 1.0
    },
    redLiquidPerTankL: 132,
    redTankCount: 2,
    roseLiquidL: 32,
    produceRose: true
  });

  assert.equal(rebalancedKDap.strategyMode, 'rebalanced_surplus_k_dap');
  assert.equal(rebalancedKDap.hasNitrogenDeficit, false);

  const tankA = rebalancedKDap.tanks['tank-a'];
  // SNA-3 gets priority for Fermaid O (~35-39.6g)
  assert.ok(
    tankA.sna3.fermaidOGrams >= 34,
    `Expected SNA-3 Fermaid O (${tankA.sna3.fermaidOGrams}) to be prioritized`
  );
  // Total Fermaid K + DAP in Tank A is increased above baseline (33g K + 19.8g DAP) to compensate low Fermaid O
  assert.ok(
    tankA.sna1.fermaidKGrams + tankA.sna2.fermaidKGrams > 33 ||
      tankA.sna2.dapGrams > 19.8,
    'Expected surplus Fermaid K or DAP to compensate for low Fermaid O'
  );
  // Biological ceiling respected: total K <= 0.40 g/L (52.8g) and DAP <= 0.30 g/L (39.6g)
  assert.ok(tankA.sna1.fermaidKGrams + tankA.sna2.fermaidKGrams <= 52.81);
  assert.ok(tankA.sna2.dapGrams <= 39.61);
});

test('optimizeNutrientScheduleFromInventory — 3. Low Fermaid K / DAP + High Fermaid O rebalances surplus Fermaid O into SNA-2', () => {
  const rebalancedO = optimizeNutrientScheduleFromInventory({
    inventory: {
      isCustomInventoryActive: true,
      goFermGrams: 90,
      fermaidOGrams: 300,
      fermaidKGrams: 0,
      dapGrams: 0,
      zincSulfateGrams: 1.0
    },
    redLiquidPerTankL: 132,
    redTankCount: 2,
    roseLiquidL: 32,
    produceRose: true
  });

  assert.equal(rebalancedO.strategyMode, 'rebalanced_surplus_fermaid_o');
  const tankA = rebalancedO.tanks['tank-a'];
  assert.equal(tankA.sna2.fermaidKGrams, 0);
  assert.equal(tankA.sna2.dapGrams, 0);
  assert.ok(
    tankA.sna2.fermaidOGrams > 30,
    `Expected surplus Fermaid O to be allocated into SNA-2, got ${tankA.sna2.fermaidOGrams}`
  );
});

test('optimizeNutrientScheduleFromInventory — 4. Severe Nitrogen Deficit triggers deficit_warning and 4 actionable top-up recommendations', () => {
  const deficitResult = optimizeNutrientScheduleFromInventory({
    inventory: {
      isCustomInventoryActive: true,
      goFermGrams: 20,
      fermaidOGrams: 20,
      fermaidKGrams: 10,
      dapGrams: 5,
      zincSulfateGrams: 0.5
    },
    redLiquidPerTankL: 132,
    redTankCount: 2,
    roseLiquidL: 32,
    produceRose: true
  });

  assert.equal(deficitResult.hasNitrogenDeficit, true);
  assert.equal(deficitResult.hasGoFermDeficit, true);
  assert.equal(deficitResult.strategyMode, 'deficit_warning');
  assert.ok(deficitResult.deficitAlertFa && deficitResult.deficitAlertFa.length > 10);
  assert.equal(deficitResult.recommendations.length, 4);

  const recIds = deficitResult.recommendations.map((r) => r.id);
  assert.deepEqual(recIds, [
    'buy_fermaid_o',
    'buy_fermaid_k_dap',
    'boiled_yeast_hulls_fallback',
    'switch_low_yan_yeast'
  ]);
  const switchRec = deficitResult.recommendations.find(
    (r) => r.id === 'switch_low_yan_yeast'
  );
  assert.ok(switchRec?.suggestedStrainIds && switchRec.suggestedStrainIds.length > 0);
});
