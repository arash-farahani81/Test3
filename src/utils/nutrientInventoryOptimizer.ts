import type { NutrientInventoryGrams, TankId } from '../types/index.ts';
import {
  MASTER_PROTOCOL_CONFIG,
  IDEAL_DEFAULT_PROTOCOL_PARAMS
} from '../data/masterProtocolConfig.ts';
import {
  YEAST_STRAINS_DATABASE,
  getYeastStrainById,
  type YeastStrainProfile
} from '../data/yeastStrainsData.ts';

export interface TankOptimizedSnaSchedule {
  tankId: TankId;
  tankLabelFa: string;
  liquidVolumeL: number;
  yeastStrain: YeastStrainProfile;
  yeastNeededGrams: number;
  goFermIdealGrams: number;
  goFermAllocatedGrams: number;
  targetYANMgL: number;
  neededYANMgL: number;
  suppliedChemicalYANMgL: number;
  suppliedBioEquivalentYANMgL: number;
  unmetBioYanDeficitMgL: number;
  sna1: {
    fermaidOGrams: number;
    fermaidKGrams: number;
    noteFa: string;
  };
  sna2: {
    fermaidKGrams: number;
    dapGrams: number;
    zincGrams: number;
    fermaidOGrams: number;
    noteFa: string;
  };
  sna3: {
    fermaidOGrams: number;
    noteFa: string;
  };
}

export interface NutrientTopUpRecommendation {
  id:
    | 'buy_fermaid_o'
    | 'buy_fermaid_k_dap'
    | 'boiled_yeast_hulls_fallback'
    | 'switch_low_yan_yeast';
  titleFa: string;
  amountTextFa: string;
  explanationFa: string;
  suggestedStrainIds?: string[];
}

export interface BatchNutrientOptimizationResult {
  isOptimizedFromCustomInventory: boolean;
  strategyMode:
    | 'ideal_standard'
    | 'rebalanced_surplus_k_dap'
    | 'rebalanced_surplus_fermaid_o'
    | 'deficit_warning';
  strategySummaryFa: string;
  hasNitrogenDeficit: boolean;
  hasGoFermDeficit: boolean;
  totalNeededBioYanAverageMgL: number;
  totalSuppliedBioYanAverageMgL: number;
  maxUnmetBioYanDeficitMgL: number;
  inventoryUsedGrams: {
    goFerm: number;
    fermaidO: number;
    fermaidK: number;
    dap: number;
    zinc: number;
  };
  inventoryRemainingGrams: {
    goFerm: number;
    fermaidO: number;
    fermaidK: number;
    dap: number;
    zinc: number;
  };
  tanks: Record<TankId, TankOptimizedSnaSchedule>;
  deficitAlertFa: string | null;
  recommendations: NutrientTopUpRecommendation[];
}

const round1 = (val: number): number => Math.round(val * 10) / 10;
const round2 = (val: number): number => Math.round(val * 100) / 100;

export function getDefaultIdealNutrientInventoryGrams(
  grapeWeightKg: number = 400,
  produceRose: boolean = true
): NutrientInventoryGrams {
  const scale = Math.max(0.05, grapeWeightKg / 400) * (produceRose ? 1 : 0.89);
  return {
    isCustomInventoryActive: false,
    goFermGrams: round1(90 * scale),
    fermaidOGrams: round1(160 * scale),
    fermaidKGrams: round1(75 * scale),
    dapGrams: round1(45 * scale),
    zincSulfateGrams: round2(1.0 * scale)
  };
}

export function optimizeNutrientScheduleFromInventory(params: {
  inventory?: NutrientInventoryGrams | null;
  redLiquidPerTankL?: number;
  redTankCount?: 1 | 2;
  roseLiquidL?: number;
  produceRose?: boolean;
  initialBrix?: number;
  initialSG?: number;
  naturalYANMgL?: number;
  selectedYeastByTank?: Partial<Record<TankId, string>>;
}): BatchNutrientOptimizationResult {
  const redTankCount = params.redTankCount ?? 2;
  const perTankRedL =
    (params.redLiquidPerTankL ?? 132) * (redTankCount === 1 ? 2 : 1);
  const produceRose = params.produceRose ?? true;
  const roseL = produceRose ? (params.roseLiquidL ?? 32) : 0;

  const brix = params.initialBrix ?? 22.0;
  const sg0 = params.initialSG ?? 1.092;
  const naturalYAN = params.naturalYANMgL ?? 100;
  const sugarGPerL = round1(brix * 10 * sg0);

  const FERMAID_O_CHEM_N = 40;
  const FERMAID_O_BIO_N = 120;
  const FERMAID_K_N =
    MASTER_PROTOCOL_CONFIG.stoichiometry.fermaidKNitrogenMgPerG; // 100
  const DAP_N = MASTER_PROTOCOL_CONFIG.stoichiometry.dapNitrogenMgPerG; // 212

  const tankIds: TankId[] = ['tank-a', 'tank-b', 'tank-rose'];
  const tankLabels: Record<TankId, string> = {
    'tank-a': redTankCount === 1 ? 'مخزن قرمز (تک‌مخزن)' : 'مخزن قرمز A',
    'tank-b': 'مخزن قرمز B',
    'tank-rose': 'گالن رُزه (Saignée)'
  };

  interface TankIdealBaseline {
    tankId: TankId;
    tankLabelFa: string;
    liquidVolumeL: number;
    strain: YeastStrainProfile;
    yeastNeededGrams: number;
    goFermIdealGrams: number;
    targetYANMgL: number;
    neededYANMgL: number;
    yanScale: number;
    idealSna1O: number;
    idealSna2K: number;
    idealSna2Dap: number;
    idealSna2Zinc: number;
    idealSna3O: number;
    idealBioMgN: number;
    demandWeight: number;
  }

  const baselines: Record<TankId, TankIdealBaseline> = {} as Record<
    TankId,
    TankIdealBaseline
  >;

  for (const tId of tankIds) {
    const isRose = tId === 'tank-rose';
    const liquidVolumeL =
      tId === 'tank-a'
        ? perTankRedL
        : tId === 'tank-b'
        ? redTankCount === 1
          ? 0
          : perTankRedL
        : roseL;

    const strain = getYeastStrainById(
      params.selectedYeastByTank?.[tId],
      isRose
    );
    const targetYANMgL = Math.round(
      Math.round(sugarGPerL) * strain.yanMultiplier
    );
    const neededYANMgL = Math.max(0, targetYANMgL - naturalYAN);
    const yanScale = neededYANMgL > 0 ? neededYANMgL / 152 : 0;

    const yeastNeededGrams =
      liquidVolumeL > 0 ? round2(strain.recommendedDoseGL * liquidVolumeL) : 0;
    const goFermIdealGrams =
      liquidVolumeL > 0 ? round2(yeastNeededGrams * 1.25) : 0;

    const o1Rate = isRose
      ? IDEAL_DEFAULT_PROTOCOL_PARAMS.fermaidO1RoseRateGL
      : IDEAL_DEFAULT_PROTOCOL_PARAMS.fermaidO1RedRateGL;
    const k2Rate = isRose
      ? IDEAL_DEFAULT_PROTOCOL_PARAMS.fermaidK2RoseRateGL
      : IDEAL_DEFAULT_PROTOCOL_PARAMS.fermaidK2RedRateGL;
    const dap2Rate = isRose
      ? IDEAL_DEFAULT_PROTOCOL_PARAMS.dap2RoseRateGL
      : IDEAL_DEFAULT_PROTOCOL_PARAMS.dap2RedRateGL;
    const zincRate = IDEAL_DEFAULT_PROTOCOL_PARAMS.zincSafeRateGL;
    const o3Rate = isRose
      ? IDEAL_DEFAULT_PROTOCOL_PARAMS.fermaidO3RoseRateGL
      : IDEAL_DEFAULT_PROTOCOL_PARAMS.fermaidO3RedRateGL;

    const idealSna1O =
      liquidVolumeL > 0 ? round2(o1Rate * liquidVolumeL * yanScale) : 0;
    const idealSna2K =
      liquidVolumeL > 0 ? round2(k2Rate * liquidVolumeL * yanScale) : 0;
    const idealSna2Dap =
      liquidVolumeL > 0 ? round2(dap2Rate * liquidVolumeL * yanScale) : 0;
    const idealSna2Zinc =
      liquidVolumeL > 0
        ? round2(
            zincRate *
              liquidVolumeL *
              Math.min(1.25, Math.max(0.5, yanScale > 0 ? yanScale : 1))
          )
        : 0;
    const idealSna3O =
      liquidVolumeL > 0 ? round2(o3Rate * liquidVolumeL * yanScale) : 0;

    const idealBioMgN =
      (idealSna1O + idealSna3O) * FERMAID_O_BIO_N +
      idealSna2K * FERMAID_K_N +
      idealSna2Dap * DAP_N;

    baselines[tId] = {
      tankId: tId,
      tankLabelFa: tankLabels[tId],
      liquidVolumeL,
      strain,
      yeastNeededGrams,
      goFermIdealGrams,
      targetYANMgL,
      neededYANMgL,
      yanScale,
      idealSna1O,
      idealSna2K,
      idealSna2Dap,
      idealSna2Zinc,
      idealSna3O,
      idealBioMgN,
      demandWeight: liquidVolumeL * Math.max(1, neededYANMgL)
    };
  }

  const isCustom = Boolean(params.inventory?.isCustomInventoryActive);

  if (!isCustom || !params.inventory) {
    const tanksResult: Record<TankId, TankOptimizedSnaSchedule> = {} as Record<
      TankId,
      TankOptimizedSnaSchedule
    >;
    let totalGoFerm = 0;
    let totalO = 0;
    let totalK = 0;
    let totalDap = 0;
    let totalZinc = 0;
    let totalVolL = 0;
    let weightedNeededSum = 0;
    let weightedSuppliedSum = 0;

    for (const tId of tankIds) {
      const b = baselines[tId];
      const chemMgN =
        (b.idealSna1O + b.idealSna3O) * FERMAID_O_CHEM_N +
        b.idealSna2K * FERMAID_K_N +
        b.idealSna2Dap * DAP_N;
      const bioMgN = b.idealBioMgN;

      const suppliedChemMgL =
        b.liquidVolumeL > 0 ? round1(chemMgN / b.liquidVolumeL) : 0;
      const suppliedBioMgL =
        b.liquidVolumeL > 0 ? round1(bioMgN / b.liquidVolumeL) : 0;

      totalGoFerm += b.goFermIdealGrams;
      totalO += b.idealSna1O + b.idealSna3O;
      totalK += b.idealSna2K;
      totalDap += b.idealSna2Dap;
      totalZinc += b.idealSna2Zinc;

      if (b.liquidVolumeL > 0) {
        totalVolL += b.liquidVolumeL;
        weightedNeededSum += b.neededYANMgL * b.liquidVolumeL;
        weightedSuppliedSum += suppliedBioMgL * b.liquidVolumeL;
      }

      tanksResult[tId] = {
        tankId: tId,
        tankLabelFa: b.tankLabelFa,
        liquidVolumeL: b.liquidVolumeL,
        yeastStrain: b.strain,
        yeastNeededGrams: b.yeastNeededGrams,
        goFermIdealGrams: b.goFermIdealGrams,
        goFermAllocatedGrams: b.goFermIdealGrams,
        targetYANMgL: b.targetYANMgL,
        neededYANMgL: b.neededYANMgL,
        suppliedChemicalYANMgL: suppliedChemMgL,
        suppliedBioEquivalentYANMgL: suppliedBioMgL,
        unmetBioYanDeficitMgL: 0,
        sna1: {
          fermaidOGrams: b.idealSna1O,
          fermaidKGrams: 0,
          noteFa: 'تغذیه نوبت اول استاندارد (۱۰۰٪ ارگانیک Fermaid O)'
        },
        sna2: {
          fermaidKGrams: b.idealSna2K,
          dapGrams: b.idealSna2Dap,
          zincGrams: b.idealSna2Zinc,
          fermaidOGrams: 0,
          noteFa: 'تغذیه نوبت دوم استاندارد در اوج تکثیر (Fermaid K + DAP + روی)'
        },
        sna3: {
          fermaidOGrams: b.idealSna3O,
          noteFa: 'تغذیه نوبت سوم استاندارد پس از سقف ۱/۳ قند (۱۰۰٪ ارگانیک Fermaid O)'
        }
      };
    }

    return {
      isOptimizedFromCustomInventory: false,
      strategyMode: 'ideal_standard',
      strategySummaryFa:
        'برنامه استاندارد ۳ مرحله‌ای SNA (مطابق دوزهای مرجع مستر پروتکل بدون محدودیت موجودی)',
      hasNitrogenDeficit: false,
      hasGoFermDeficit: false,
      totalNeededBioYanAverageMgL:
        totalVolL > 0 ? round1(weightedNeededSum / totalVolL) : 0,
      totalSuppliedBioYanAverageMgL:
        totalVolL > 0 ? round1(weightedSuppliedSum / totalVolL) : 0,
      maxUnmetBioYanDeficitMgL: 0,
      inventoryUsedGrams: {
        goFerm: round1(totalGoFerm),
        fermaidO: round1(totalO),
        fermaidK: round1(totalK),
        dap: round1(totalDap),
        zinc: round2(totalZinc)
      },
      inventoryRemainingGrams: {
        goFerm: 0,
        fermaidO: 0,
        fermaidK: 0,
        dap: 0,
        zinc: 0
      },
      tanks: tanksResult,
      deficitAlertFa: null,
      recommendations: []
    };
  }

  // ============================================================================
  // CONSTRAINED STOICHIOMETRIC OPTIMIZER (WHEN CUSTOM INVENTORY IS ACTIVE)
  // ============================================================================
  const inv = params.inventory;
  const totalDemandWeight = tankIds.reduce(
    (acc, id) => acc + baselines[id].demandWeight,
    0
  );
  const totalIdealGoFerm = tankIds.reduce(
    (acc, id) => acc + baselines[id].goFermIdealGrams,
    0
  );
  const totalIdealZinc = tankIds.reduce(
    (acc, id) => acc + baselines[id].idealSna2Zinc,
    0
  );

  const tanksResult: Record<TankId, TankOptimizedSnaSchedule> = {} as Record<
    TankId,
    TankOptimizedSnaSchedule
  >;

  let usedGoFerm = 0;
  let usedO = 0;
  let usedK = 0;
  let usedDap = 0;
  let usedZinc = 0;

  let usedSurplusKOrDap = false;
  let usedSurplusFermaidO = false;
  let hasGoFermDeficit = false;

  let totalVolL = 0;
  let weightedNeededSum = 0;
  let weightedSuppliedSum = 0;
  let maxUnmetBioYanDeficitMgL = 0;
  let totalUnmetMgN = 0;

  for (const tId of tankIds) {
    const b = baselines[tId];
    if (b.liquidVolumeL <= 0) {
      tanksResult[tId] = {
        tankId: tId,
        tankLabelFa: b.tankLabelFa,
        liquidVolumeL: 0,
        yeastStrain: b.strain,
        yeastNeededGrams: 0,
        goFermIdealGrams: 0,
        goFermAllocatedGrams: 0,
        targetYANMgL: b.targetYANMgL,
        neededYANMgL: b.neededYANMgL,
        suppliedChemicalYANMgL: 0,
        suppliedBioEquivalentYANMgL: 0,
        unmetBioYanDeficitMgL: 0,
        sna1: { fermaidOGrams: 0, fermaidKGrams: 0, noteFa: 'مخزن غیرفعال' },
        sna2: {
          fermaidKGrams: 0,
          dapGrams: 0,
          zincGrams: 0,
          fermaidOGrams: 0,
          noteFa: 'مخزن غیرفعال'
        },
        sna3: { fermaidOGrams: 0, noteFa: 'مخزن غیرفعال' }
      };
      continue;
    }

    const tankShare =
      totalDemandWeight > 0 ? b.demandWeight / totalDemandWeight : 0;
    const goFermShare =
      totalIdealGoFerm > 0 ? b.goFermIdealGrams / totalIdealGoFerm : tankShare;
    const zincShare =
      totalIdealZinc > 0 ? b.idealSna2Zinc / totalIdealZinc : tankShare;

    const availGoFerm = Math.max(0, inv.goFermGrams * goFermShare);
    let availO = Math.max(0, inv.fermaidOGrams * tankShare);
    let availK = Math.max(0, inv.fermaidKGrams * tankShare);
    let availDap = Math.max(0, inv.dapGrams * tankShare);
    const availZinc = Math.max(0, inv.zincSulfateGrams * zincShare);

    const goFermAllocatedGrams = round2(
      Math.min(b.goFermIdealGrams, availGoFerm)
    );
    if (goFermAllocatedGrams < b.goFermIdealGrams - 0.5) {
      hasGoFermDeficit = true;
    }

    // Priority 1: SNA-3 Organic Lock (SG 1.057) — Only Fermaid O is biologically safe here
    const maxSna3O = 0.45 * b.liquidVolumeL;
    const sna3O = round2(Math.min(b.idealSna3O, availO, maxSna3O));
    availO = Math.max(0, availO - sna3O);

    // Priority 2: SNA-1 Early Growth (SG 1.083) — Prefer Fermaid O; fallback to surplus Fermaid K (<= 0.15 g/L)
    const maxSna1O = 0.40 * b.liquidVolumeL;
    const sna1O = round2(Math.min(b.idealSna1O, availO, maxSna1O));
    availO = Math.max(0, availO - sna1O);

    let sna1K = 0;
    const sna1GapO = Math.max(0, b.idealSna1O - sna1O);
    if (sna1GapO > 1.0) {
      const surplusKAfterIdealSna2 = Math.max(0, availK - b.idealSna2K);
      const neededKForBioEq = sna1GapO * (FERMAID_O_BIO_N / FERMAID_K_N); // 1.2x
      const maxSna1K = 0.15 * b.liquidVolumeL;
      sna1K = round2(
        Math.min(neededKForBioEq, surplusKAfterIdealSna2, maxSna1K)
      );
      availK = Math.max(0, availK - sna1K);
      if (sna1K > 0.2) {
        usedSurplusKOrDap = true;
      }
    }

    // Priority 3: SNA-2 Peak Cell Division (SG 1.070)
    const maxTotalK = 0.40 * b.liquidVolumeL;
    const maxSna2K = Math.min(
      0.35 * b.liquidVolumeL,
      Math.max(0, maxTotalK - sna1K)
    );
    const maxSna2Dap = 0.30 * b.liquidVolumeL;
    const maxSna2O = 0.40 * b.liquidVolumeL;

    let sna2K = round2(Math.min(b.idealSna2K, availK, maxSna2K));
    availK = Math.max(0, availK - sna2K);

    let sna2Dap = round2(Math.min(b.idealSna2Dap, availDap, maxSna2Dap));
    availDap = Math.max(0, availDap - sna2Dap);

    const sna2Zinc = round2(Math.min(b.idealSna2Zinc, availZinc));
    let sna2O = 0;

    // Cross-Compensation in SNA-2 if any stage had a nitrogen shortfall relative to idealBioMgN
    const currentBioMgN = (): number =>
      (sna1O + sna2O + sna3O) * FERMAID_O_BIO_N +
      (sna1K + sna2K) * FERMAID_K_N +
      sna2Dap * DAP_N;

    let deficitMgN = b.idealBioMgN - currentBioMgN();

    // 1) If Fermaid O is still available in surplus (e.g., when K or DAP was low), add Fermaid O to SNA-2
    if (deficitMgN > 3 * b.liquidVolumeL && availO > 0.2) {
      const neededO = deficitMgN / FERMAID_O_BIO_N;
      const addO = round2(Math.min(neededO, availO, maxSna2O));
      if (addO > 0.2) {
        sna2O = addO;
        availO = Math.max(0, availO - addO);
        usedSurplusFermaidO = true;
        deficitMgN = b.idealBioMgN - currentBioMgN();
      }
    }

    // 2) If deficit remains and surplus Fermaid K is available (e.g., when Fermaid O was low), increase SNA-2 Fermaid K up to ceiling
    if (deficitMgN > 3 * b.liquidVolumeL && availK > 0.2) {
      const headroomK = Math.max(0, maxSna2K - sna2K);
      const neededK = deficitMgN / FERMAID_K_N;
      const addK = round2(Math.min(neededK, availK, headroomK));
      if (addK > 0.2) {
        sna2K = round2(sna2K + addK);
        availK = Math.max(0, availK - addK);
        usedSurplusKOrDap = true;
        deficitMgN = b.idealBioMgN - currentBioMgN();
      }
    }

    // 3) If deficit still remains and surplus DAP is available, increase SNA-2 DAP up to ceiling (0.30 g/L)
    if (deficitMgN > 3 * b.liquidVolumeL && availDap > 0.2) {
      const headroomDap = Math.max(0, maxSna2Dap - sna2Dap);
      const neededDap = deficitMgN / DAP_N;
      const addDap = round2(Math.min(neededDap, availDap, headroomDap));
      if (addDap > 0.2) {
        sna2Dap = round2(sna2Dap + addDap);
        availDap = Math.max(0, availDap - addDap);
        usedSurplusKOrDap = true;
        deficitMgN = b.idealBioMgN - currentBioMgN();
      }
    }

    const finalBioMgN = currentBioMgN();
    const finalChemMgN =
      (sna1O + sna2O + sna3O) * FERMAID_O_CHEM_N +
      (sna1K + sna2K) * FERMAID_K_N +
      sna2Dap * DAP_N;

    const suppliedChemicalYANMgL = round1(finalChemMgN / b.liquidVolumeL);
    const suppliedBioEquivalentYANMgL = round1(finalBioMgN / b.liquidVolumeL);
    const idealBioYanMgL = round1(b.idealBioMgN / b.liquidVolumeL);

    const unmetBioYanDeficitMgL = Math.max(
      0,
      round1(idealBioYanMgL - suppliedBioEquivalentYANMgL)
    );

    if (unmetBioYanDeficitMgL > maxUnmetBioYanDeficitMgL) {
      maxUnmetBioYanDeficitMgL = unmetBioYanDeficitMgL;
    }
    if (unmetBioYanDeficitMgL > 0) {
      totalUnmetMgN += unmetBioYanDeficitMgL * b.liquidVolumeL;
    }

    usedGoFerm += goFermAllocatedGrams;
    usedO += sna1O + sna2O + sna3O;
    usedK += sna1K + sna2K;
    usedDap += sna2Dap;
    usedZinc += sna2Zinc;

    totalVolL += b.liquidVolumeL;
    weightedNeededSum += idealBioYanMgL * b.liquidVolumeL;
    weightedSuppliedSum += suppliedBioEquivalentYANMgL * b.liquidVolumeL;

    tanksResult[tId] = {
      tankId: tId,
      tankLabelFa: b.tankLabelFa,
      liquidVolumeL: b.liquidVolumeL,
      yeastStrain: b.strain,
      yeastNeededGrams: b.yeastNeededGrams,
      goFermIdealGrams: b.goFermIdealGrams,
      goFermAllocatedGrams,
      targetYANMgL: b.targetYANMgL,
      neededYANMgL: b.neededYANMgL,
      suppliedChemicalYANMgL,
      suppliedBioEquivalentYANMgL,
      unmetBioYanDeficitMgL,
      sna1: {
        fermaidOGrams: sna1O,
        fermaidKGrams: sna1K,
        noteFa:
          sna1K > 0
            ? `بازتوزیع هوشمند: ${sna1O}g Fermaid O + ${sna1K}g Fermaid K جایگزین کمبود ارگانیک`
            : 'تغذیه نوبت اول (Fermaid O ارگانیک)'
      },
      sna2: {
        fermaidKGrams: sna2K,
        dapGrams: sna2Dap,
        zincGrams: sna2Zinc,
        fermaidOGrams: sna2O,
        noteFa:
          sna2O > 0
            ? `بازتوزیع هوشمند: افزودن ${sna2O}g Fermaid O در SNA-2 برای جبران کمبود K/DAP`
            : sna2K > b.idealSna2K + 0.3 || sna2Dap > b.idealSna2Dap + 0.3
            ? 'افزایش هوشمند Fermaid K / DAP در سقف مجاز زیستی برای جبران کمبود Fermaid O'
            : 'تغذیه نوبت دوم در اوج تکثیر (Fermaid K + DAP + روی)'
      },
      sna3: {
        fermaidOGrams: sna3O,
        noteFa:
          sna3O < b.idealSna3O - 0.5
            ? 'تخصیص اولویت‌دار Fermaid O به SNA-3 (ممنوعیت مطلق DAP/K پس از ۱/۳ قند)'
            : 'تغذیه نوبت سوم پس از ۱/۳ قند (۱۰۰٪ ارگانیک Fermaid O)'
      }
    };
  }

  const hasNitrogenDeficit = maxUnmetBioYanDeficitMgL > 5;

  let strategyMode: BatchNutrientOptimizationResult['strategyMode'] =
    'ideal_standard';
  let strategySummaryFa =
    'موجودی فعلی شما نیاز کامل ۳ مرحله‌ای SNA را مطابق پروتکل مرجع پوشش می‌دهد.';

  if (hasNitrogenDeficit) {
    strategyMode = 'deficit_warning';
    strategySummaryFa = `هشدار کمبود نیتروژن (${maxUnmetBioYanDeficitMgL} mg N/L): موجودی فعلی برای پوشش کامل نیاز مخمر کافی نیست؛ Fermaid O موجود به اولویت SNA-3 اختصاص یافت.`;
  } else if (usedSurplusKOrDap) {
    strategyMode = 'rebalanced_surplus_k_dap';
    strategySummaryFa =
      'بازتوزیع هوشمند (کمبود Fermaid O): موجودی Fermaid O برای مرحله حساس SNA-3 حفظ شد و کسری نیتروژن با افزایش ایمن Fermaid K و DAP در مراحل SNA-1/SNA-2 جبران گردید.';
  } else if (usedSurplusFermaidO) {
    strategyMode = 'rebalanced_surplus_fermaid_o';
    strategySummaryFa =
      'بازتوزیع هوشمند (کمبود Fermaid K / DAP): کسری نیتروژن مرحله میانی با تخصیص مازاد Fermaid O ارگانیک در نوبت SNA-2 به‌طور کامل جبران گردید.';
  }

  const primaryStrain = baselines['tank-a'].strain;
  let deficitAlertFa: string | null = null;
  const recommendations: NutrientTopUpRecommendation[] = [];

  if (hasNitrogenDeficit) {
    const buyFermaidOGrams = Math.max(
      5,
      Math.ceil(totalUnmetMgN / FERMAID_O_BIO_N)
    );
    const buyFermaidKGrams = Math.max(
      5,
      Math.ceil(totalUnmetMgN / FERMAID_K_N)
    );
    const buyDapGrams = Math.max(5, Math.ceil(totalUnmetMgN / DAP_N));
    const boiledYeastGrams = Math.max(10, Math.ceil(totalUnmetMgN / 60));

    deficitAlertFa = `کمبود ${maxUnmetBioYanDeficitMgL} mg N/L نیتروژن قابل جذب مخمر نسبت به نیاز سویه ${primaryStrain.nameFa}: بدون تأمین نیتروژن تکمیلی، خطر تولید بوی گوگرد (H2S) و توقف تخمیر در نیمه دوم وجود دارد.`;

    const lowYanStrains = YEAST_STRAINS_DATABASE.filter(
      (s) => s.yanMultiplier <= 0.85 && s.recommendedStyles.includes('red')
    ).slice(0, 4);

    recommendations.push(
      {
        id: 'buy_fermaid_o',
        titleFa: 'گزینه ۱ (ایده‌آل): تهیه Fermaid O ارگانیک',
        amountTextFa: `${buyFermaidOGrams} گرم Fermaid O`,
        explanationFa:
          'بهترین مکمل نیتروژن آمینه ارگانیک که در هر سه مرحله (به‌ویژه SNA-3 پس از ۱/۳ قند) کاملاً ایمن است.'
      },
      {
        id: 'buy_fermaid_k_dap',
        titleFa: 'گزینه ۲: تهیه Fermaid K یا DAP معدنی (فقط پیش از SG 1.062)',
        amountTextFa: `${buyFermaidKGrams} گرم Fermaid K یا ${buyDapGrams} گرم DAP`,
        explanationFa:
          'قابل استفاده در مراحل ابتدایی (SNA-1 و SNA-2 پیش از عبور از سقف ۱/۳ قند) تا سقف مجاز زیستی.'
      },
      {
        id: 'boiled_yeast_hulls_fallback',
        titleFa: 'گزینه ۳ (جایگزین اضطراری کارگاهی): پوسته مخمر جوشانده‌شده',
        amountTextFa: `${boiledYeastGrams} گرم مخمر نانوایی خالص جوشانده‌شده`,
        explanationFa:
          'پوسته مخمر غیرفعال حرارتی در آب جوش به مدت ۱۰ دقیقه جهت آزادسازی اسیدهای آمینه و استرولهای غشایی در شرایط عدم دسترسی به مکمل تجاری.'
      },
      {
        id: 'switch_low_yan_yeast',
        titleFa: 'گزینه ۴: تغییر سویه مخمر به سویه‌های کم‌مصرف (Low-YAN)',
        amountTextFa: 'کاهش نیاز نیتروژن به میزان ۴۵ تا ۶۰ mg N/L',
        explanationFa: `استفاده از سویه‌های کم‌مصرف مانند ${lowYanStrains
          .map((s) => s.code)
          .join('، ')} نیاز به مکمل نیتروژن را تا ۲۵٪ کاهش می‌دهد.`,
        suggestedStrainIds: lowYanStrains.map((s) => s.id)
      }
    );
  }

  return {
    isOptimizedFromCustomInventory: true,
    strategyMode,
    strategySummaryFa,
    hasNitrogenDeficit,
    hasGoFermDeficit,
    totalNeededBioYanAverageMgL:
      totalVolL > 0 ? round1(weightedNeededSum / totalVolL) : 0,
    totalSuppliedBioYanAverageMgL:
      totalVolL > 0 ? round1(weightedSuppliedSum / totalVolL) : 0,
    maxUnmetBioYanDeficitMgL,
    inventoryUsedGrams: {
      goFerm: round1(usedGoFerm),
      fermaidO: round1(usedO),
      fermaidK: round1(usedK),
      dap: round1(usedDap),
      zinc: round2(usedZinc)
    },
    inventoryRemainingGrams: {
      goFerm: round1(Math.max(0, inv.goFermGrams - usedGoFerm)),
      fermaidO: round1(Math.max(0, inv.fermaidOGrams - usedO)),
      fermaidK: round1(Math.max(0, inv.fermaidKGrams - usedK)),
      dap: round1(Math.max(0, inv.dapGrams - usedDap)),
      zinc: round2(Math.max(0, inv.zincSulfateGrams - usedZinc))
    },
    tanks: tanksResult,
    deficitAlertFa,
    recommendations
  };
}
