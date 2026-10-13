// ============================================================================
// DOCE CÁLCULO 2.0 (GELACOST PRO EVOLUTION) — APPLICATION ENGINE
// ============================================================================
// - Sincronização em tempo real com Firebase Auth + Firestore ("empresa/dados_v2")
// - Isolamento total: NUNCA sobrescreve "empresa/dados" (GelaCost 1.0 original)
// - Edição de receitas em Modal com rascunho seguro (Cancel funcional + Live Preview)
// - Suporte nativo a Sub-receitas / Bases com recálculo em cascata
// - Edição rápida inline de preços e quantidades de insumos e embalagens
// ============================================================================

const STORAGE_KEY_DATA = 'doceCalculo2_data_v2';
const STORAGE_KEY_UNLOCKED = 'doceCalculo2_unlocked_v2';
const STORAGE_KEY_DOC_ID = 'doceCalculo2_doc_id_v2';

// IDs de receitas que são bases conhecidas no catálogo original do GelaCost PRO
const KNOWN_BASE_RECIPE_IDS = new Set([
  1776100322652, // Ganache Preta
  1776105201619, // Trufado de Ninho - Anelyse (Ganache Branca)
  1779721828906, // Bisconuts Base 60 biscoitos
  1789942497128  // Mini Donuts
]);

// Vínculo entre insumos manuais antigos e suas respectivas Receitas Base
// para que alterações nos ingredientes base recalculem tudo automaticamente em cascata
const LEGACY_BASE_INGREDIENT_LINKS = [
  { ingId: 1776100516608, baseRecipeId: 1776100322652, mode: 'raw_weight' }, // Ganache Preta (400g)
  { ingId: 1776105396094, baseRecipeId: 1776105201619, mode: 'raw_weight' }, // Ganache Branca (565g)
  { ingId: 1791745792501, baseRecipeId: 1789942497128, mode: 'batch_unit' }  // Donuts (50 un)
];

// Estado Principal dos Dados
let appData = {
  ingredients: [],
  packaging: [],
  categories: [],
  recipes: [],
  settings: {
    utilityCost: 10,
    profitMargin: 50,
    wasteMargin: 5,
    monthlyFixed: 84,
    targetPrice: 10,
    workDays: 26,
    ifoodFee: 12,
    debitFee: 1.99,
    creditFee: 4.99
  }
};

// Estado de Interface (UI)
const uiState = {
  activeTab: 'recipes',
  recipeCategoryFilter: 'all',
  collapsedCategories: new Set(),
  ingUnitFilter: 'all',
  ingViewMode: 'table',
  pkgViewMode: 'table',
  draftRecipe: null,
  isOfflineMode: false,
  firebaseConnected: false,
  firestoreUnsubscribe: null,
  isSavingToCloud: false,
  goalSaveTimeout: null
};

// Instâncias Firebase
let fbApp = null;
let fbDb = null;
let fbAuth = null;

// ============================================================================
// 1. UTILITÁRIOS DE FORMATAÇÃO E UNIDADES
// ============================================================================

function generateId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

function formatCurrency(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatNumber(val, maxDecimals = 2) {
  const num = Number(val) || 0;
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUnitDisplay(unit) {
  if (unit === 'l' || unit === 'L') return 'L';
  return unit || 'un';
}

function normalizeToSmallestUnit(qty, unit) {
  const q = parseFloat(qty) || 0;
  const u = (unit || '').toLowerCase();
  if (u === 'kg' || u === 'l') return q * 1000;
  return q;
}

function getBaseSmallestUnitLabel(unit) {
  const u = (unit || '').toLowerCase();
  if (u === 'kg' || u === 'g') return 'g';
  if (u === 'l' || u === 'ml') return 'ml';
  return 'un';
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 260);
  }, 3200);
}

function clearSearchInput(inputId, callbackFn) {
  const input = document.getElementById(inputId);
  if (input) {
    input.value = '';
    input.focus();
  }
  if (typeof callbackFn === 'function') callbackFn();
}

// ============================================================================
// 2. NORMALIZAÇÃO DE DADOS E MOTOR DE SUB-RECEITAS
// ============================================================================

function normalizeAppData(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const ingredients = Array.isArray(source.ingredients)
    ? source.ingredients.map(i => ({
        id: i.id ?? generateId(),
        name: String(i.name || 'Insumo sem nome').trim(),
        price: parseFloat(i.price) || 0,
        qty: parseFloat(i.qty) > 0 ? parseFloat(i.qty) : 1,
        unit: (i.unit || 'g').toLowerCase()
      }))
    : [];

  const rawPackaging = Array.isArray(source.packaging)
    ? source.packaging
    : Array.isArray(source.packagings)
    ? source.packagings
    : [];

  const packaging = rawPackaging.map(p => ({
    id: p.id ?? generateId(),
    name: String(p.name || 'Embalagem sem nome').trim(),
    price: parseFloat(p.price) || 0,
    qty: parseFloat(p.qty) > 0 ? parseFloat(p.qty) : 1
  }));

  const categories = Array.isArray(source.categories) && source.categories.length > 0
    ? source.categories.map(c => ({
        id: c.id ?? generateId(),
        name: String(c.name || 'Categoria').trim()
      }))
    : [{ id: 1, name: 'Geladinhos Gourmet' }];

  const rawSettings = source.settings || {};
  const settings = {
    utilityCost: rawSettings.utilityCost !== undefined ? parseFloat(rawSettings.utilityCost) || 0 : 10,
    profitMargin: rawSettings.profitMargin !== undefined ? parseFloat(rawSettings.profitMargin) || 0 : 50,
    wasteMargin: rawSettings.wasteMargin !== undefined ? parseFloat(rawSettings.wasteMargin) || 0 : 5,
    monthlyFixed: rawSettings.monthlyFixed !== undefined ? parseFloat(rawSettings.monthlyFixed) || 0 : 84,
    targetPrice: rawSettings.targetPrice !== undefined ? parseFloat(rawSettings.targetPrice) || 0 : 0,
    workDays: rawSettings.workDays !== undefined ? parseInt(rawSettings.workDays, 10) || 26 : 26,
    ifoodFee: rawSettings.ifoodFee !== undefined ? parseFloat(rawSettings.ifoodFee) || 0 : 12,
    debitFee: rawSettings.debitFee !== undefined ? parseFloat(rawSettings.debitFee) || 0 : 1.99,
    creditFee: rawSettings.creditFee !== undefined ? parseFloat(rawSettings.creditFee) || 0 : 4.99
  };

  const recipes = Array.isArray(source.recipes)
    ? source.recipes.map(r => {
        const numId = Number(r.id);
        const isKnownBase = KNOWN_BASE_RECIPE_IDS.has(numId);
        const isBase = r.isBase !== undefined ? Boolean(r.isBase) : isKnownBase;

        // Para Ganache Preta e Trufado de Ninho (Ganache Branca), no GelaCost original
        // o custo da base usado nas outras receitas era a soma pura dos ingredientes
        let defaultCustomUtility = r.customUtilityCost !== undefined && r.customUtilityCost !== '' && r.customUtilityCost !== null
          ? parseFloat(r.customUtilityCost)
          : null;
        let defaultCustomWaste = r.customWasteMargin !== undefined && r.customWasteMargin !== '' && r.customWasteMargin !== null
          ? parseFloat(r.customWasteMargin)
          : null;

        return {
          id: r.id ?? generateId(),
          name: String(r.name || 'Receita sem nome').trim(),
          categoryId: r.categoryId ?? categories[0].id,
          time: parseFloat(r.time) || 30,
          yield: parseFloat(r.yield) > 0 ? parseFloat(r.yield) : 1,
          yieldUnit: r.yieldUnit || 'unidades',
          isBase: isBase,
          baseYieldWeight: parseFloat(r.baseYieldWeight) > 0 ? parseFloat(r.baseYieldWeight) : null,
          baseYieldUnit: r.baseYieldUnit || 'g',
          customUtilityCost: defaultCustomUtility,
          customWasteMargin: defaultCustomWaste,
          customProfitMargin: r.customProfitMargin !== undefined && r.customProfitMargin !== '' && r.customProfitMargin !== null
            ? parseFloat(r.customProfitMargin)
            : null,
          customPrice: parseFloat(r.customPrice) > 0 ? parseFloat(r.customPrice) : null,
          notes: r.notes || '',
          ingredients: Array.isArray(r.ingredients)
            ? r.ingredients.map(ri => ({
                id: ri.id,
                type: ri.type || 'ingredient', // 'ingredient' ou 'subrecipe'
                subRecipeId: ri.subRecipeId || null,
                qty: parseFloat(ri.qty) || 0,
                unit: (ri.unit || 'g').toLowerCase()
              }))
            : [],
          packaging: Array.isArray(r.packaging)
            ? r.packaging.map(rp => ({
                id: rp.id,
                qty: parseFloat(rp.qty) || 0
              }))
            : []
        };
      })
    : [];

  return { ingredients, packaging, categories, settings, recipes };
}

/**
 * Calcula o peso/volume automático de uma receita somando os ingredientes em g/ml
 */
function calculateRecipeAutoWeight(recipe) {
  if (!recipe || !Array.isArray(recipe.ingredients)) return 0;
  let totalWeightG = 0;
  recipe.ingredients.forEach(rIng => {
    const u = (rIng.unit || 'g').toLowerCase();
    if (u === 'g' || u === 'kg' || u === 'ml' || u === 'l') {
      totalWeightG += normalizeToSmallestUnit(rIng.qty, u);
    }
  });
  return totalWeightG;
}

/**
 * Sincroniza insumos vinculados a receitas-base (ex: Ganache Preta, Ganache Branca, Mini Donuts)
 * para que qualquer alteração de preço em matérias-primas atualize em cascata todas as 34 receitas!
 */
function syncBaseRecipesToLinkedIngredients() {
  if (!appData || !Array.isArray(appData.recipes) || !Array.isArray(appData.ingredients)) return;

  LEGACY_BASE_INGREDIENT_LINKS.forEach(link => {
    const baseRecipe = appData.recipes.find(r => r.id == link.baseRecipeId);
    const linkedIng = appData.ingredients.find(i => i.id == link.ingId);
    if (!baseRecipe || !linkedIng) return;

    const calc = calculateRecipeCosts(baseRecipe, new Set([String(baseRecipe.id)]));
    if (link.mode === 'raw_weight') {
      const weight = baseRecipe.baseYieldWeight > 0
        ? baseRecipe.baseYieldWeight
        : calculateRecipeAutoWeight(baseRecipe);
      if (weight > 0) {
        linkedIng.qty = weight;
        linkedIng.unit = baseRecipe.baseYieldUnit || 'g';
        linkedIng.price = Number(calc.rawIngredientsBatchCost.toFixed(2));
      }
    } else if (link.mode === 'batch_unit') {
      const y = parseFloat(baseRecipe.yield) || 1;
      const batchWithoutWaste = calc.rawIngredientsBatchCost + (calc.utilityCostPerUnit * y);
      linkedIng.qty = y;
      linkedIng.unit = 'un';
      linkedIng.price = Number(batchWithoutWaste.toFixed(2));
    }
  });
}

// ============================================================================
// 3. MOTOR DE CÁLCULO FINANCEIRO (COMPATÍVEL COM GELACOST PRO + SUB-RECEITAS)
// ============================================================================

function calculateIngredientRowCost(rIng, visitedRecipes = new Set()) {
  if (!rIng) return { cost: 0, name: 'Item inválido', unitPriceText: '', isSubRecipe: false };

  // Caso 1: É uma Sub-receita direta (type === 'subrecipe' ou id começando com 'sub:')
  const isSub = rIng.type === 'subrecipe' || String(rIng.id).startsWith('sub:');
  if (isSub) {
    const subId = rIng.subRecipeId || String(rIng.id).replace(/^sub:/, '');
    const subRecipe = appData.recipes.find(r => String(r.id) === String(subId));
    if (!subRecipe) {
      return { cost: 0, name: 'Sub-receita excluída', unitPriceText: '—', isSubRecipe: true };
    }

    if (visitedRecipes.has(String(subRecipe.id))) {
      return { cost: 0, name: `${subRecipe.name} (Ciclo evitado)`, unitPriceText: '—', isSubRecipe: true };
    }

    const nextVisited = new Set(visitedRecipes);
    nextVisited.add(String(subRecipe.id));
    const subCalc = calculateRecipeCosts(subRecipe, nextVisited);

    // Se a sub-receita tiver custo de gás próprio definido nela, considera; senão usa o custo dos insumos da base
    const hasCustomUtil = subRecipe.customUtilityCost !== null && subRecipe.customUtilityCost !== undefined && subRecipe.customUtilityCost !== '';
    const subBatchReferenceCost = hasCustomUtil
      ? subCalc.totalBatchCost
      : subCalc.rawIngredientsBatchCost;

    const usageUnit = (rIng.unit || 'g').toLowerCase();
    const usageQty = parseFloat(rIng.qty) || 0;

    if (usageUnit === 'un') {
      const subYield = parseFloat(subRecipe.yield) || 1;
      const costPerUn = subBatchReferenceCost / subYield;
      return {
        cost: costPerUn * usageQty,
        name: subRecipe.name,
        unitPriceText: `${formatCurrency(costPerUn)} / un`,
        isSubRecipe: true,
        subRecipeId: subRecipe.id
      };
    } else {
      const totalBaseWeight = subRecipe.baseYieldWeight > 0
        ? normalizeToSmallestUnit(subRecipe.baseYieldWeight, subRecipe.baseYieldUnit || 'g')
        : calculateRecipeAutoWeight(subRecipe) || 1;
      const usageInSmallest = normalizeToSmallestUnit(usageQty, usageUnit);
      const costPerGram = subBatchReferenceCost / totalBaseWeight;
      return {
        cost: costPerGram * usageInSmallest,
        name: subRecipe.name,
        unitPriceText: `${formatCurrency(subBatchReferenceCost)} / ${formatNumber(totalBaseWeight)}g`,
        isSubRecipe: true,
        subRecipeId: subRecipe.id
      };
    }
  }

  // Caso 2: É um Insumo normal do estoque
  const dbIng = appData.ingredients.find(i => String(i.id) === String(rIng.id));
  if (!dbIng) {
    return { cost: 0, name: 'Insumo excluído', unitPriceText: '—', isSubRecipe: false };
  }

  const stockQtyInSmallest = normalizeToSmallestUnit(dbIng.qty, dbIng.unit);
  const pricePerSmallest = stockQtyInSmallest > 0 ? dbIng.price / stockQtyInSmallest : 0;
  const recipeUnit = (rIng.unit || dbIng.unit || 'g').toLowerCase();
  const usageInSmallest = normalizeToSmallestUnit(rIng.qty, recipeUnit);
  const cost = pricePerSmallest * usageInSmallest;

  // Verifica se este insumo é vinculado a uma receita base para exibir badge informativo
  const linkedBase = LEGACY_BASE_INGREDIENT_LINKS.find(l => String(l.ingId) === String(dbIng.id));

  return {
    cost,
    name: dbIng.name,
    unitPriceText: `${formatCurrency(dbIng.price)} / ${formatNumber(dbIng.qty)}${formatUnitDisplay(dbIng.unit)}`,
    isSubRecipe: Boolean(linkedBase),
    subRecipeId: linkedBase ? linkedBase.baseRecipeId : null
  };
}

function calculateRecipeCosts(recipe, visitedRecipes = new Set()) {
  if (!recipe) {
    return {
      rawIngredientsBatchCost: 0,
      packagingBatchCost: 0,
      onlyIngredientsCost: 0,
      packagingCost: 0,
      wasteValuePerUnit: 0,
      utilityCostPerUnit: 0,
      additionalCosts: 0,
      totalUnitCost: 0,
      totalBatchCost: 0,
      suggestedPrice: 0,
      finalUnitPrice: 0,
      iFoodPrice: 0,
      debitPrice: 0,
      creditPrice: 0,
      profitPerUnit: 0,
      batchProfit: 0,
      batchRevenue: 0,
      effectiveMarginPercent: 0
    };
  }

  let rawIngredientsBatchCost = 0;
  const ingredientsList = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  ingredientsList.forEach(rIng => {
    const row = calculateIngredientRowCost(rIng, visitedRecipes);
    rawIngredientsBatchCost += row.cost;
  });

  let packagingBatchCost = 0;
  const packagingList = Array.isArray(recipe.packaging) ? recipe.packaging : [];
  packagingList.forEach(rPack => {
    const dbPack = appData.packaging.find(p => String(p.id) === String(rPack.id));
    if (dbPack && dbPack.qty > 0) {
      packagingBatchCost += (dbPack.price / dbPack.qty) * (parseFloat(rPack.qty) || 0);
    }
  });

  const yieldVal = parseFloat(recipe.yield) > 0 ? parseFloat(recipe.yield) : 1;

  const onlyIngredientsCostPerUnit = rawIngredientsBatchCost / yieldVal;
  const packagingCostPerUnit = packagingBatchCost / yieldVal;

  const wasteMarginUsed =
    recipe.customWasteMargin !== null && recipe.customWasteMargin !== undefined && recipe.customWasteMargin !== ''
      ? parseFloat(recipe.customWasteMargin) || 0
      : parseFloat(appData.settings.wasteMargin) || 0;

  const utilityCostUsed =
    recipe.customUtilityCost !== null && recipe.customUtilityCost !== undefined && recipe.customUtilityCost !== ''
      ? parseFloat(recipe.customUtilityCost) || 0
      : parseFloat(appData.settings.utilityCost) || 0;

  const profitMarginUsed =
    recipe.customProfitMargin !== null && recipe.customProfitMargin !== undefined && recipe.customProfitMargin !== ''
      ? parseFloat(recipe.customProfitMargin) || 0
      : parseFloat(appData.settings.profitMargin) || 0;

  const wasteValuePerUnit = onlyIngredientsCostPerUnit * (wasteMarginUsed / 100);
  const utilityCostPerUnit = utilityCostUsed / yieldVal;
  const additionalCostsPerUnit = wasteValuePerUnit + utilityCostPerUnit;

  const totalUnitCost = onlyIngredientsCostPerUnit + packagingCostPerUnit + additionalCostsPerUnit;
  const totalBatchCost =
    rawIngredientsBatchCost +
    packagingBatchCost +
    utilityCostPerUnit * yieldVal +
    wasteValuePerUnit * yieldVal;

  const marginDecimal = profitMarginUsed / 100;
  const suggestedPrice =
    marginDecimal < 1 && marginDecimal >= 0
      ? totalUnitCost / (1 - marginDecimal)
      : totalUnitCost * (1 + marginDecimal);

  const hasCustomPrice = parseFloat(recipe.customPrice) > 0;
  const finalUnitPrice = hasCustomPrice ? parseFloat(recipe.customPrice) : suggestedPrice;

  const ifoodDecimal = (parseFloat(appData.settings.ifoodFee) || 0) / 100;
  const iFoodPrice = ifoodDecimal < 1 ? finalUnitPrice / (1 - ifoodDecimal) : finalUnitPrice;

  const debitDecimal = (parseFloat(appData.settings.debitFee) || 0) / 100;
  const debitPrice = debitDecimal < 1 ? finalUnitPrice / (1 - debitDecimal) : finalUnitPrice;

  const creditDecimal = (parseFloat(appData.settings.creditFee) || 0) / 100;
  const creditPrice = creditDecimal < 1 ? finalUnitPrice / (1 - creditDecimal) : finalUnitPrice;

  const profitPerUnit = finalUnitPrice - totalUnitCost;
  const batchRevenue = finalUnitPrice * yieldVal;
  const batchProfit = profitPerUnit * yieldVal;
  const effectiveMarginPercent = finalUnitPrice > 0 ? (profitPerUnit / finalUnitPrice) * 100 : 0;

  return {
    rawIngredientsBatchCost,
    packagingBatchCost,
    onlyIngredientsCost: onlyIngredientsCostPerUnit,
    packagingCost: packagingCostPerUnit,
    wasteValuePerUnit,
    utilityCostPerUnit,
    additionalCosts: additionalCostsPerUnit,
    totalUnitCost,
    totalBatchCost,
    suggestedPrice,
    finalUnitPrice,
    hasCustomPrice,
    iFoodPrice,
    debitPrice,
    creditPrice,
    profitPerUnit,
    batchProfit,
    batchRevenue,
    effectiveMarginPercent,
    wasteMarginUsed,
    utilityCostUsed,
    profitMarginUsed
  };
}

// ============================================================================
// 4. INICIALIZAÇÃO, LOGIN FLUIDO E SINCRONIZAÇÃO FIREBASE (ISOLADA V2)
// ============================================================================

function getActiveDocId() {
  const savedDoc = localStorage.getItem(STORAGE_KEY_DOC_ID) || window.FIRESTORE_DOC_V2 || 'dados_v2';
  // Proteção absoluta: nunca retorna "dados" como documento de escrita da v2
  if (savedDoc.trim() === 'dados') return 'dados_v2';
  return savedDoc.trim();
}

function loadInitialLocalData() {
  const savedJson = localStorage.getItem(STORAGE_KEY_DATA);
  if (savedJson) {
    try {
      const parsed = JSON.parse(savedJson);
      if (parsed && Array.isArray(parsed.ingredients) && parsed.ingredients.length > 0) {
        appData = normalizeAppData(parsed);
        syncBaseRecipesToLinkedIngredients();
        return;
      }
    } catch (err) {
      console.warn('Erro ao ler cache local da v2, carregando seed-data:', err);
    }
  }

  if (window.GELACOST_INITIAL_DATA) {
    appData = normalizeAppData(window.GELACOST_INITIAL_DATA);
    syncBaseRecipesToLinkedIngredients();
    localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(appData));
  }
}

function initFirebaseSDK() {
  try {
    if (typeof firebase !== 'undefined' && window.DEFAULT_FIREBASE_CONFIG) {
      if (!firebase.apps.length) {
        fbApp = firebase.initializeApp(window.DEFAULT_FIREBASE_CONFIG);
      } else {
        fbApp = firebase.app();
      }
      fbDb = firebase.firestore();
      fbAuth = firebase.auth();
      return true;
    }
  } catch (err) {
    console.warn('Firebase SDK indisponível ou modo offline:', err);
  }
  return false;
}

function updateSyncBadge(status, text) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncStatusText');
  const modalTitle = document.getElementById('fbModalStatusTitle');
  const modalDesc = document.getElementById('fbModalStatusDesc');
  const docId = getActiveDocId();

  if (dot) {
    dot.className = 'sync-dot';
    if (status === 'online') dot.classList.add('online');
    else if (status === 'syncing') dot.classList.add('syncing');
    else if (status === 'error') dot.classList.add('error');
  }
  if (label) {
    label.textContent = text;
  }
  if (modalTitle && modalDesc) {
    if (status === 'online') {
      modalTitle.textContent = '🟢 Conectado e Sincronizado em Tempo Real';
      modalDesc.innerHTML = `Seus dados estão salvos com segurança na coleção <code>${window.FIRESTORE_COLLECTION || 'empresa'}/${escapeHtml(docId)}</code>. O banco antigo (<code>empresa/dados</code>) permanece 100% intocado.`;
    } else if (status === 'syncing') {
      modalTitle.textContent = '🟡 Sincronizando com a nuvem...';
      modalDesc.textContent = 'Enviando ou recebendo atualizações do Firebase Firestore.';
    } else {
      modalTitle.textContent = '⚪ Operando em Modo Local / Offline';
      modalDesc.textContent = 'Todas as alterações estão salvas no navegador deste aparelho. Conecte-se com a senha da equipe para sincronizar na nuvem.';
    }
  }
}

function unlockAndShowApp() {
  const loginScreen = document.getElementById('loginScreen');
  const appContent = document.getElementById('appContent');
  if (loginScreen) loginScreen.style.display = 'none';
  if (appContent) appContent.style.display = 'block';
  refreshAllViews();
}

function handleLoginSubmit(event) {
  if (event) event.preventDefault();
  const pwdInput = document.getElementById('sharedPasswordInput');
  const errorEl = document.getElementById('loginErrorMsg');
  const btnSubmit = document.getElementById('btnLoginSubmit');
  const rememberEl = document.getElementById('rememberAccessCheckbox');

  const password = pwdInput ? pwdInput.value.trim() : '';
  if (!password) return;

  if (errorEl) errorEl.style.display = 'none';
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = '⏳ Verificando acesso...';
  }

  const email = window.SHARED_AUTH_EMAIL || 'acesso@gelacost.com';

  if (fbAuth) {
    fbAuth
      .signInWithEmailAndPassword(email, password)
      .then(() => {
        if (rememberEl && rememberEl.checked) {
          localStorage.setItem(STORAGE_KEY_UNLOCKED, 'true');
        }
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = '🔓 Acessar Sistema';
        }
        unlockAndShowApp();
        startFirestoreRealtimeSync();
        showToast('☁️ Conectado e sincronizado com sucesso!', 'success');
      })
      .catch(err => {
        console.warn('Erro Firebase Auth:', err);
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = '🔓 Acessar Sistema';
        }
        // Caso esteja sem internet mas a senha seja a senha correta da equipe, libera o modo local
        if (password === 'caio1camily') {
          if (rememberEl && rememberEl.checked) {
            localStorage.setItem(STORAGE_KEY_UNLOCKED, 'true');
          }
          uiState.isOfflineMode = true;
          unlockAndShowApp();
          updateSyncBadge('offline', 'Modo Local (Sem internet)');
          showToast('🔓 Acesso liberado em modo local.', 'info');
        } else {
          if (errorEl) errorEl.style.display = 'block';
        }
      });
  } else {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = '🔓 Acessar Sistema';
    }
    if (password === 'caio1camily') {
      if (rememberEl && rememberEl.checked) {
        localStorage.setItem(STORAGE_KEY_UNLOCKED, 'true');
      }
      enterOfflineMode();
    } else if (errorEl) {
      errorEl.style.display = 'block';
    }
  }
}

function togglePasswordVisibility() {
  const input = document.getElementById('sharedPasswordInput');
  const icon = document.getElementById('pwdEyeIcon');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.textContent = '🙈';
  } else {
    input.type = 'password';
    if (icon) icon.textContent = '👁️';
  }
}

function enterOfflineMode() {
  uiState.isOfflineMode = true;
  localStorage.setItem(STORAGE_KEY_UNLOCKED, 'true');
  unlockAndShowApp();
  updateSyncBadge('offline', 'Modo Local • 34 Receitas');
  showToast('📂 Operando com banco local completo (61 insumos e 34 receitas).', 'info');
}

function handleLogout() {
  localStorage.removeItem(STORAGE_KEY_UNLOCKED);
  if (uiState.firestoreUnsubscribe) {
    uiState.firestoreUnsubscribe();
    uiState.firestoreUnsubscribe = null;
  }
  if (fbAuth && fbAuth.currentUser) {
    fbAuth.signOut().catch(() => {});
  }
  const pwdInput = document.getElementById('sharedPasswordInput');
  if (pwdInput) pwdInput.value = '';
  const appContent = document.getElementById('appContent');
  const loginScreen = document.getElementById('loginScreen');
  if (appContent) appContent.style.display = 'none';
  if (loginScreen) loginScreen.style.display = 'flex';
}

function startFirestoreRealtimeSync() {
  if (!fbDb) return;
  if (uiState.firestoreUnsubscribe) {
    uiState.firestoreUnsubscribe();
    uiState.firestoreUnsubscribe = null;
  }

  const collectionName = window.FIRESTORE_COLLECTION || 'empresa';
  const docId = getActiveDocId();
  const docRefV2 = fbDb.collection(collectionName).doc(docId);

  updateSyncBadge('syncing', `Conectando (${docId})...`);

  uiState.firestoreUnsubscribe = docRefV2.onSnapshot(
    docSnap => {
      uiState.firebaseConnected = true;
      if (docSnap.exists) {
        const cloudData = docSnap.data();
        if (cloudData && Array.isArray(cloudData.ingredients)) {
          appData = normalizeAppData(cloudData);
          syncBaseRecipesToLinkedIngredients();
          localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(appData));
          refreshAllViewsPreservingState();
          updateSyncBadge('online', `Nuvem v2 (${docId})`);
        }
      } else {
        // Primeiro acesso ao documento isolado "empresa/dados_v2":
        // Salva a cópia completa já carregada no appData para inicializar "empresa/dados_v2"
        saveDataToCloudAndLocal(true);
      }
    },
    err => {
      console.warn('Aviso no listener Firestore v2:', err);
      updateSyncBadge('offline', 'Local (Sem conexão nuvem)');
    }
  );
}

function saveDataToCloudAndLocal(silent = false) {
  syncBaseRecipesToLinkedIngredients();
  localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(appData));

  if (!fbDb || !fbAuth || !fbAuth.currentUser) {
    return;
  }

  const collectionName = window.FIRESTORE_COLLECTION || 'empresa';
  const docId = getActiveDocId();
  if (docId === 'dados') {
    console.error('Proteção ativada: tentativa de escrita em empresa/dados bloqueada.');
    return;
  }

  updateSyncBadge('syncing', 'Salvando na nuvem...');
  const cleanPayload = JSON.parse(JSON.stringify(appData));

  fbDb
    .collection(collectionName)
    .doc(docId)
    .set(cleanPayload)
    .then(() => {
      updateSyncBadge('online', `Nuvem v2 (${docId})`);
    })
    .catch(err => {
      console.error('Erro ao salvar no Firestore v2:', err);
      updateSyncBadge('error', 'Erro ao sincronizar');
      if (!silent) {
        showToast('⚠️ Salvo neste aparelho, mas houve falha ao enviar para a nuvem.', 'error');
      }
    });
}

/**
 * Importa uma cópia atualizada diretamente do documento antigo ("empresa/dados")
 * apenas como LEITURA, copiando para "empresa/dados_v2".
 */
function pullFreshCopyFromLegacyFirestore() {
  if (!fbDb || !fbAuth || !fbAuth.currentUser) {
    if (window.GELACOST_INITIAL_DATA) {
      if (!confirm('Você está no modo local. Deseja restaurar os 61 insumos, 22 embalagens e 34 receitas originais do GelaCost PRO?')) {
        return;
      }
      appData = normalizeAppData(window.GELACOST_INITIAL_DATA);
      saveDataToCloudAndLocal();
      refreshAllViews();
      closeDataModal();
      showToast('✅ Dados originais do GelaCost PRO restaurados com sucesso!', 'success');
    } else {
      showToast('⚠️ Faça login com a senha da equipe para buscar dados da nuvem.', 'error');
    }
    return;
  }

  if (!confirm('Deseja importar os dados atuais do GelaCost antigo (empresa/dados) para a versão 2.0 (empresa/dados_v2)? O sistema antigo NÃO será alterado.')) {
    return;
  }

  const collectionName = window.FIRESTORE_COLLECTION || 'empresa';
  const legacyDocId = window.FIRESTORE_DOC_LEGACY || 'dados';

  updateSyncBadge('syncing', 'Importando do GelaCost 1.0...');
  fbDb
    .collection(collectionName)
    .doc(legacyDocId)
    .get()
    .then(docSnap => {
      if (docSnap.exists) {
        const legacyData = docSnap.data();
        appData = normalizeAppData(legacyData);
        saveDataToCloudAndLocal();
        refreshAllViews();
        closeDataModal();
        showToast('✅ Cópia atualizada importada do GelaCost PRO com sucesso!', 'success');
      } else {
        showToast('⚠️ Documento original empresa/dados não encontrado.', 'error');
      }
    })
    .catch(err => {
      console.error('Erro ao ler documento legado:', err);
      showToast('⚠️ Erro ao ler dados da nuvem.', 'error');
    });
}

// ============================================================================
// 5. NAVEGAÇÃO ENTRE ABAS E ATUALIZAÇÃO DE KPIS SEM PERDER SCROLL
// ============================================================================

function switchTab(tabName) {
  uiState.activeTab = tabName;

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (tabName === 'recipes') {
    renderRecipes();
  } else if (tabName === 'ingredients') {
    renderIngredients();
  } else if (tabName === 'packagings') {
    renderPackagings();
  } else if (tabName === 'goals') {
    populateGoalSimulatorInputs();
    calculateAndRenderGoal();
    renderDashboardTable();
  } else if (tabName === 'options') {
    populateGlobalOptionsForm();
    renderCategoriesManager();
  }
}

function updateHeaderCountsAndKPIs() {
  const numRecipes = appData.recipes.length;
  const numIngs = appData.ingredients.length;
  const numPkgs = appData.packaging.length;
  const numCats = appData.categories.length;
  const numBases = appData.recipes.filter(r => r.isBase).length;

  const countRecipesEl = document.getElementById('countRecipes');
  const countIngEl = document.getElementById('countIngredients');
  const countPkgEl = document.getElementById('countPackagings');
  if (countRecipesEl) countRecipesEl.textContent = numRecipes;
  if (countIngEl) countIngEl.textContent = numIngs;
  if (countPkgEl) countPkgEl.textContent = numPkgs;

  const kpiTotalRecipes = document.getElementById('kpiTotalRecipes');
  const kpiRecipesDetail = document.getElementById('kpiRecipesDetail');
  const kpiTotalInputs = document.getElementById('kpiTotalInputs');
  const kpiInputsDetail = document.getElementById('kpiInputsDetail');
  const kpiDefaultMargin = document.getElementById('kpiDefaultMargin');
  const kpiDefaultExtras = document.getElementById('kpiDefaultExtras');
  const kpiMonthlyExpenses = document.getElementById('kpiMonthlyExpenses');

  if (kpiTotalRecipes) kpiTotalRecipes.textContent = `${numRecipes} produtos`;
  if (kpiRecipesDetail) kpiRecipesDetail.textContent = `${numCats} categorias • ${numBases} bases prontas`;
  if (kpiTotalInputs) kpiTotalInputs.textContent = `${numIngs + numPkgs} itens`;
  if (kpiInputsDetail) kpiInputsDetail.textContent = `${numIngs} insumos • ${numPkgs} embalagens`;
  if (kpiDefaultMargin) kpiDefaultMargin.textContent = `${formatNumber(appData.settings.profitMargin)}%`;
  if (kpiDefaultExtras) {
    kpiDefaultExtras.textContent = `Luz/Gás: ${formatCurrency(appData.settings.utilityCost)} • Perda: ${formatNumber(appData.settings.wasteMargin)}%`;
  }
  if (kpiMonthlyExpenses) {
    kpiMonthlyExpenses.textContent = formatCurrency(appData.settings.monthlyFixed || 0);
  }
}

function refreshAllViews() {
  updateHeaderCountsAndKPIs();
  renderRecipeCategoryPills();
  renderRecipes();
  renderIngredients();
  renderPackagings();
  populateGoalSimulatorInputs();
  calculateAndRenderGoal();
  renderDashboardTable();
  populateGlobalOptionsForm();
  renderCategoriesManager();
}

/**
 * Atualiza a interface quando chega atualização do Firebase onSnapshot,
 * preservando a posição da rolagem (scroll) e sem tocar no Modal de Receita se estiver aberto!
 */
function refreshAllViewsPreservingState() {
  const scrollY = window.scrollY;
  updateHeaderCountsAndKPIs();
  renderRecipeCategoryPills();
  renderRecipes(true);
  renderIngredients();
  renderPackagings();
  calculateAndRenderGoal();
  renderDashboardTable();
  renderCategoriesManager();
  window.scrollTo({ top: scrollY, behavior: 'instant' });
}

// ============================================================================
// 6. ABA 1: CATÁLOGO DE RECEITAS, FILTROS E CARDS 6 MÉTRICAS
// ============================================================================

function getCategoryName(catId) {
  const cat = appData.categories.find(c => String(c.id) === String(catId));
  return cat ? cat.name : 'Sem Categoria';
}

function setRecipeCategoryFilter(catId) {
  uiState.recipeCategoryFilter = String(catId);
  renderRecipeCategoryPills();
  renderRecipes();
}

function renderRecipeCategoryPills() {
  const bar = document.getElementById('recipeCategoryPills');
  if (!bar) return;

  const countsByCat = {};
  let baseCount = 0;
  appData.recipes.forEach(r => {
    const cid = String(r.categoryId || '');
    countsByCat[cid] = (countsByCat[cid] || 0) + 1;
    if (r.isBase) baseCount++;
  });

  const sortedCats = [...appData.categories].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  let html = `
    <button
      type="button"
      class="pill-btn ${uiState.recipeCategoryFilter === 'all' ? 'active' : ''}"
      onclick="setRecipeCategoryFilter('all')"
    >
      Todas (${appData.recipes.length})
    </button>
    <button
      type="button"
      class="pill-btn ${uiState.recipeCategoryFilter === 'bases' ? 'active' : ''}"
      onclick="setRecipeCategoryFilter('bases')"
      title="Mostrar apenas Sub-receitas e Bases usadas em outros produtos"
    >
      🍲 Bases / Sub-receitas (${baseCount})
    </button>
  `;

  sortedCats.forEach(cat => {
    const cCount = countsByCat[String(cat.id)] || 0;
    if (cCount === 0 && uiState.recipeCategoryFilter !== String(cat.id)) return;
    const isActive = uiState.recipeCategoryFilter === String(cat.id);
    html += `
      <button
        type="button"
        class="pill-btn ${isActive ? 'active' : ''}"
        onclick="setRecipeCategoryFilter('${escapeHtml(cat.id)}')"
      >
        ${escapeHtml(cat.name)} (${cCount})
      </button>
    `;
  });

  bar.innerHTML = html;
}

function toggleCategoryCollapse(catId) {
  const key = String(catId);
  if (uiState.collapsedCategories.has(key)) {
    uiState.collapsedCategories.delete(key);
  } else {
    uiState.collapsedCategories.add(key);
  }
  const body = document.getElementById(`cat-group-body-${key}`);
  const chevron = document.getElementById(`cat-group-chevron-${key}`);
  if (body) {
    const isCollapsed = uiState.collapsedCategories.has(key);
    body.style.display = isCollapsed ? 'none' : 'grid';
    if (chevron) chevron.textContent = isCollapsed ? '▶' : '▼';
  }
}

function toggleAllCategories() {
  const allCatIds = appData.categories.map(c => String(c.id));
  const shouldCollapseAll = uiState.collapsedCategories.size < allCatIds.length / 2;
  if (shouldCollapseAll) {
    allCatIds.forEach(id => uiState.collapsedCategories.add(id));
  } else {
    uiState.collapsedCategories.clear();
  }
  renderRecipes(true);
}

function renderRecipes(preserveScroll = false) {
  const container = document.getElementById('recipesContainer');
  if (!container) return;

  // Preserva quais <details> de detalhamento de lote estavam abertos
  const openDetailsIds = new Set();
  container.querySelectorAll('details.recipe-batch-details[open]').forEach(el => {
    if (el.dataset.recipeId) openDetailsIds.add(el.dataset.recipeId);
  });

  const searchInput = document.getElementById('searchRecipes');
  const clearBtn = document.getElementById('btnClearRecipeSearch');
  const sortSelect = document.getElementById('sortRecipesSelect');

  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (clearBtn) clearBtn.style.display = query.length > 0 ? 'flex' : 'none';
  const sortMode = sortSelect ? sortSelect.value : 'alpha';

  // Filtra receitas por busca (nome, categoria ou nome de insumo dentro da receita) e por categoria selecionada
  const filtered = appData.recipes.filter(recipe => {
    if (uiState.recipeCategoryFilter === 'bases') {
      if (!recipe.isBase) return false;
    } else if (uiState.recipeCategoryFilter !== 'all') {
      if (String(recipe.categoryId) !== String(uiState.recipeCategoryFilter)) return false;
    }

    if (!query) return true;

    const nameMatch = (recipe.name || '').toLowerCase().includes(query);
    const catMatch = getCategoryName(recipe.categoryId).toLowerCase().includes(query);
    if (nameMatch || catMatch) return true;

    // Também busca pelos ingredientes utilizados na receita!
    const hasIngMatch = (recipe.ingredients || []).some(rIng => {
      const rowInfo = calculateIngredientRowCost(rIng);
      return (rowInfo.name || '').toLowerCase().includes(query);
    });
    return hasIngMatch;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🍰</div>
        <h3>Nenhuma receita encontrada</h3>
        <p>Tente ajustar sua busca ou clique em <strong>"➕ Nova Receita"</strong> para cadastrar um produto.</p>
      </div>
    `;
    return;
  }

  // Pré-calcula os custos para permitir ordenação por preço ou lucro
  const enriched = filtered.map(recipe => ({
    recipe,
    calc: calculateRecipeCosts(recipe)
  }));

  enriched.sort((a, b) => {
    if (sortMode === 'price_asc') return a.calc.finalUnitPrice - b.calc.finalUnitPrice;
    if (sortMode === 'price_desc') return b.calc.finalUnitPrice - a.calc.finalUnitPrice;
    if (sortMode === 'profit_desc') return b.calc.profitPerUnit - a.calc.profitPerUnit;
    return a.recipe.name.localeCompare(b.recipe.name, 'pt-BR');
  });

  // Agrupa por categoria
  const grouped = {};
  enriched.forEach(item => {
    const cid = String(item.recipe.categoryId || 1);
    if (!grouped[cid]) grouped[cid] = [];
    grouped[cid].push(item);
  });

  const sortedCatIds = Object.keys(grouped).sort((a, b) =>
    getCategoryName(a).localeCompare(getCategoryName(b), 'pt-BR')
  );

  const ifoodFeePercent = formatNumber(appData.settings.ifoodFee || 12);

  let html = '';
  sortedCatIds.forEach(catId => {
    const catName = getCategoryName(catId);
    const items = grouped[catId];
    const isCollapsed = !query && uiState.collapsedCategories.has(catId);

    html += `
      <div class="category-group-block">
        <div class="category-group-header" onclick="toggleCategoryCollapse('${escapeHtml(catId)}')" title="Clique para recolher ou expandir esta categoria">
          <div class="category-group-title">
            <span>📂 ${escapeHtml(catName)}</span>
            <span class="category-count-pill">${items.length} ${items.length === 1 ? 'receita' : 'receitas'}</span>
          </div>
          <span class="category-chevron" id="cat-group-chevron-${escapeHtml(catId)}">${isCollapsed ? '▶' : '▼'}</span>
        </div>

        <div class="recipes-grid" id="cat-group-body-${escapeHtml(catId)}" style="display: ${isCollapsed ? 'none' : 'grid'};">
    `;

    items.forEach(({ recipe, calc }) => {
      const yieldText = `${formatNumber(recipe.yield)} ${escapeHtml(recipe.yieldUnit || 'unidades')}`;
      const isDetailsOpen = openDetailsIds.has(String(recipe.id));
      const totalItemsCount = (recipe.ingredients || []).length + (recipe.packaging || []).length;

      // Monta linhas da mini-tabela de detalhamento do lote
      let batchRowsHtml = '';
      (recipe.ingredients || []).forEach(rIng => {
        const info = calculateIngredientRowCost(rIng);
        const badge = info.isSubRecipe ? `<span class="badge badge-subrecipe" title="Sub-receita / Base">🍲 Base</span> ` : '';
        batchRowsHtml += `
          <tr>
            <td>${badge}${escapeHtml(info.name)}</td>
            <td>${formatNumber(rIng.qty, 3)} ${escapeHtml(formatUnitDisplay(rIng.unit))}</td>
            <td style="text-align: right; font-weight: 600;">${formatCurrency(info.cost)}</td>
          </tr>
        `;
      });

      (recipe.packaging || []).forEach(rPack => {
        const dbPack = appData.packaging.find(p => String(p.id) === String(rPack.id));
        if (dbPack) {
          const cost = dbPack.qty > 0 ? (dbPack.price / dbPack.qty) * (parseFloat(rPack.qty) || 0) : 0;
          batchRowsHtml += `
            <tr>
              <td style="color: var(--primary);">🎁 ${escapeHtml(dbPack.name)}</td>
              <td>${formatNumber(rPack.qty, 2)} un</td>
              <td style="text-align: right; color: var(--primary); font-weight: 600;">${formatCurrency(cost)}</td>
            </tr>
          `;
        }
      });

      const autoWeight = calculateRecipeAutoWeight(recipe);
      const baseWeightDisplay = recipe.isBase
        ? `<span class="badge badge-subrecipe" title="Esta receita pode ser usada como ingrediente em outras receitas">🍲 Base (${formatNumber(recipe.baseYieldWeight || autoWeight)}g)</span>`
        : '';

      html += `
        <article class="recipe-card" id="recipe-card-${escapeHtml(recipe.id)}">
          <div class="recipe-card-top">
            <div class="recipe-card-heading">
              <div class="recipe-card-title">
                <span>${escapeHtml(recipe.name)}</span>
                ${baseWeightDisplay}
              </div>
              <div class="recipe-yield-info">
                Rendimento: <strong>${yieldText}</strong>
              </div>
            </div>

            <div class="recipe-card-actions">
              <button type="button" class="btn btn-outline btn-sm" onclick="openRevealModal('${escapeHtml(recipe.id)}')" title="Abrir Ficha Técnica Completa e Preços de Cartão">
                📄 Ficha
              </button>
              <button type="button" class="btn btn-primary btn-sm" onclick="openRecipeModal('${escapeHtml(recipe.id)}')" title="Editar Receita">
                ✏️ Editar
              </button>
              <button type="button" class="btn btn-secondary btn-sm btn-icon-only" onclick="duplicateRecipe('${escapeHtml(recipe.id)}')" title="Duplicar Receita">
                📋
              </button>
              <button type="button" class="btn btn-danger btn-sm btn-icon-only" onclick="deleteRecipe('${escapeHtml(recipe.id)}')" title="Excluir Receita">
                🗑️
              </button>
            </div>
          </div>

          <!-- 3 Indicadores Essenciais Visíveis de Imediato -->
          <div class="recipe-stats-main">
            <div class="stat-cell stat-cost-total">
              <span class="s-label">Custo Unitário</span>
              <span class="s-val">${formatCurrency(calc.totalUnitCost)}</span>
              <span class="s-sub">Lote: ${formatCurrency(calc.totalBatchCost)}</span>
            </div>
            <div class="stat-cell stat-price-sell">
              <span class="s-label">${calc.hasCustomPrice ? 'Preço Praticado' : 'Preço Sugerido'}</span>
              <span class="s-val">${formatCurrency(calc.finalUnitPrice)}</span>
              <span class="s-sub">Lucro: ${formatCurrency(calc.profitPerUnit)} (${formatNumber(calc.effectiveMarginPercent, 0)}%)</span>
            </div>
            <div class="stat-cell stat-price-ifood">
              <span class="s-label">iFood (+${ifoodFeePercent}%)</span>
              <span class="s-val">${formatCurrency(calc.iFoodPrice)}</span>
              <span class="s-sub">Lucro Lote: ${formatCurrency(calc.batchProfit)}</span>
            </div>
          </div>

          <!-- Detalhamento de Custos e Ingredientes (Expansível ao clicar) -->
          <details class="recipe-batch-details" data-recipe-id="${escapeHtml(recipe.id)}" ${isDetailsOpen ? 'open' : ''}>
            <summary class="batch-summary-toggle">
              <span class="summary-left">
                <span class="summary-arrow">▶</span>
                <span>Ver composição de custos e insumos (${totalItemsCount} ${totalItemsCount === 1 ? 'item' : 'itens'})</span>
              </span>
              <span class="summary-right">Custo Lote: <strong>${formatCurrency(calc.totalBatchCost)}</strong></span>
            </summary>

            <div class="batch-details-content">
              <div class="recipe-substats-row">
                <div class="substat-item">
                  <span>Ingredientes / un</span>
                  <strong>${formatCurrency(calc.onlyIngredientsCost)}</strong>
                </div>
                <div class="substat-item">
                  <span>Embalagem / un</span>
                  <strong>${formatCurrency(calc.packagingCost)}</strong>
                </div>
                <div class="substat-item" title="Luz/Gás (${formatCurrency(calc.utilityCostPerUnit)}/un) + Desperdício (${formatCurrency(calc.wasteValuePerUnit)}/un)">
                  <span>Custos Adic. / un</span>
                  <strong>${formatCurrency(calc.additionalCosts)}</strong>
                </div>
              </div>

              <div class="table-responsive">
                <table class="mini-batch-table">
                  <thead>
                    <tr>
                      <th>Ingrediente / Embalagem</th>
                      <th>Qtd no Lote</th>
                      <th style="text-align: right;">Custo</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${batchRowsHtml || '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">Nenhum item cadastrado nesta receita.</td></tr>'}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colspan="2">CUSTO TOTAL DO LOTE (${yieldText})</td>
                      <td style="text-align: right;">${formatCurrency(calc.totalBatchCost)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </details>
        </article>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// ============================================================================
// 7. MODAL FLUIDO DE CRIAÇÃO / EDIÇÃO DE RECEITA (COM RASCUNHO SEGURO)
// ============================================================================

function openRecipeModal(recipeId = null) {
  const modal = document.getElementById('recipeModal');
  const titleEl = document.getElementById('recipeModalTitle');
  const inlineCatBox = document.getElementById('inlineNewCatBox');
  const quickIngBox = document.getElementById('modalQuickNewIngBox');
  const quickPkgBox = document.getElementById('modalQuickNewPkgBox');

  if (inlineCatBox) inlineCatBox.style.display = 'none';
  if (quickIngBox) quickIngBox.style.display = 'none';
  if (quickPkgBox) quickPkgBox.style.display = 'none';

  const existing = recipeId !== null && recipeId !== undefined
    ? appData.recipes.find(r => String(r.id) === String(recipeId))
    : null;

  if (existing) {
    uiState.draftRecipe = JSON.parse(JSON.stringify(existing));
    if (titleEl) titleEl.textContent = `✏️ Editando: ${existing.name}`;
  } else {
    const defaultCatId =
      uiState.recipeCategoryFilter !== 'all' && uiState.recipeCategoryFilter !== 'bases'
        ? uiState.recipeCategoryFilter
        : appData.categories[0]?.id || 1;

    uiState.draftRecipe = {
      id: null,
      name: '',
      categoryId: defaultCatId,
      time: 30,
      yield: 10,
      yieldUnit: 'unidades',
      isBase: uiState.recipeCategoryFilter === 'bases',
      baseYieldWeight: null,
      baseYieldUnit: 'g',
      customUtilityCost: null,
      customWasteMargin: null,
      customProfitMargin: null,
      customPrice: null,
      notes: '',
      ingredients: [],
      packaging: []
    };
    if (titleEl) titleEl.textContent = '➕ Nova Receita / Produto';
  }

  const d = uiState.draftRecipe;

  document.getElementById('recId').value = d.id || '';
  document.getElementById('recName').value = d.name || '';
  document.getElementById('recYieldQty').value = d.yield || 10;
  document.getElementById('recYieldUnit').value = d.yieldUnit || 'unidades';
  document.getElementById('recIsBase').checked = Boolean(d.isBase);
  document.getElementById('recBaseYieldWeight').value = d.baseYieldWeight > 0 ? d.baseYieldWeight : '';
  document.getElementById('recBaseYieldUnit').value = d.baseYieldUnit || 'g';

  document.getElementById('recCustomUtility').value =
    d.customUtilityCost !== null && d.customUtilityCost !== undefined ? d.customUtilityCost : '';
  document.getElementById('recCustomWaste').value =
    d.customWasteMargin !== null && d.customWasteMargin !== undefined ? d.customWasteMargin : '';
  document.getElementById('recCustomMargin').value =
    d.customProfitMargin !== null && d.customProfitMargin !== undefined ? d.customProfitMargin : '';
  document.getElementById('recCustomPrice').value =
    d.customPrice !== null && d.customPrice !== undefined && d.customPrice > 0 ? d.customPrice : '';
  document.getElementById('recNotes').value = d.notes || '';

  const defaultsHint = document.getElementById('modalGlobalDefaultsHint');
  if (defaultsHint) {
    defaultsHint.textContent = `Luz/Gás: ${formatCurrency(appData.settings.utilityCost)} • Perda: ${formatNumber(appData.settings.wasteMargin)}% • Margem: ${formatNumber(appData.settings.profitMargin)}%`;
  }

  onToggleRecIsBase();
  populateModalCategorySelect(d.categoryId);

  const ingFilterInput = document.getElementById('ingSearchFilterInput');
  const pkgFilterInput = document.getElementById('pkgSearchFilterInput');
  if (ingFilterInput) ingFilterInput.value = '';
  if (pkgFilterInput) pkgFilterInput.value = '';
  document.getElementById('modalAddIngQty').value = '';
  document.getElementById('modalAddPkgQty').value = '';

  filterModalIngSelect();
  filterModalPkgSelect();
  renderDraftIngredientsList();
  renderDraftPackagingsList();
  updateRecipeLivePreview();

  if (modal) modal.classList.add('open');
  setTimeout(() => {
    const nameInput = document.getElementById('recName');
    if (nameInput && !existing) nameInput.focus();
  }, 80);
}

function closeRecipeModal() {
  const modal = document.getElementById('recipeModal');
  if (modal) modal.classList.remove('open');
  uiState.draftRecipe = null;
}

function populateModalCategorySelect(selectedCatId) {
  const select = document.getElementById('recCategorySelect');
  if (!select) return;

  const sortedCats = [...appData.categories].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  let html = '';
  sortedCats.forEach(cat => {
    const isSel = String(cat.id) === String(selectedCatId);
    html += `<option value="${escapeHtml(cat.id)}" ${isSel ? 'selected' : ''}>${escapeHtml(cat.name)}</option>`;
  });
  html += `<option value="__new__" style="font-weight: 700; color: var(--primary);">➕ Criar Nova Categoria...</option>`;
  select.innerHTML = html;
}

function onModalCategorySelectChange(selectEl) {
  if (!selectEl) return;
  if (selectEl.value === '__new__') {
    toggleInlineNewCatBox(true);
  } else if (uiState.draftRecipe) {
    uiState.draftRecipe.categoryId = selectEl.value;
  }
}

function toggleInlineNewCatBox(forceShow = null) {
  const box = document.getElementById('inlineNewCatBox');
  const input = document.getElementById('inlineNewCatInput');
  if (!box) return;
  const show = forceShow !== null ? forceShow : box.style.display === 'none';
  box.style.display = show ? 'flex' : 'none';
  if (show && input) {
    input.value = '';
    input.focus();
  }
}

function confirmInlineNewCategory() {
  const input = document.getElementById('inlineNewCatInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    showToast('Digite o nome da nova categoria.', 'error');
    return;
  }

  const newCat = { id: generateId(), name };
  appData.categories.push(newCat);
  saveDataToCloudAndLocal();
  renderRecipeCategoryPills();
  renderCategoriesManager();

  if (uiState.draftRecipe) {
    uiState.draftRecipe.categoryId = newCat.id;
  }
  populateModalCategorySelect(newCat.id);
  toggleInlineNewCatBox(false);
  showToast(`🏷️ Categoria "${name}" criada e selecionada!`, 'success');
}

function onToggleRecIsBase() {
  const checkbox = document.getElementById('recIsBase');
  const group = document.getElementById('recBaseWeightGroup');
  if (!checkbox || !group) return;
  group.style.display = checkbox.checked ? 'flex' : 'none';
  updateRecipeLivePreview();
}

/**
 * Filtra o <select id="modalAddIngSelect"> combinando Sub-receitas Base e Insumos do estoque
 */
function filterModalIngSelect() {
  const select = document.getElementById('modalAddIngSelect');
  const filterInput = document.getElementById('ingSearchFilterInput');
  if (!select) return;

  const q = filterInput ? filterInput.value.trim().toLowerCase() : '';
  const currentDraftId = uiState.draftRecipe ? String(uiState.draftRecipe.id || '') : '';

  // 1. Sub-receitas / Bases disponíveis (exclui a própria receita que está sendo editada)
  const baseRecipes = appData.recipes
    .filter(r => String(r.id) !== currentDraftId && (r.isBase || KNOWN_BASE_RECIPE_IDS.has(Number(r.id))))
    .filter(r => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  // 2. Insumos do estoque
  const stockIngs = appData.ingredients
    .filter(i => !q || i.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  let html = `<option value="">-- Selecione o Insumo ou Sub-receita (${baseRecipes.length + stockIngs.length} encontrados) --</option>`;

  if (baseRecipes.length > 0) {
    html += `<optgroup label="🍲 SUB-RECEITAS & BASES PRONTAS (Cálculo Automático)">`;
    baseRecipes.forEach(br => {
      const autoW = br.baseYieldWeight || calculateRecipeAutoWeight(br);
      const bCalc = calculateRecipeCosts(br);
      const unitHint = autoW > 0 ? `${formatNumber(autoW)}g` : `${formatNumber(br.yield)} un`;
      html += `<option value="sub:${escapeHtml(br.id)}" data-unit="${autoW > 0 ? 'g' : 'un'}">🍲 [Base] ${escapeHtml(br.name)} (Lote: ${unitHint} = ${formatCurrency(bCalc.rawIngredientsBatchCost)})</option>`;
    });
    html += `</optgroup>`;
  }

  if (stockIngs.length > 0) {
    html += `<optgroup label="🥣 INSUMOS DO ESTOQUE (Matérias-Primas)">`;
    stockIngs.forEach(ing => {
      const uDisp = formatUnitDisplay(ing.unit);
      html += `<option value="${escapeHtml(ing.id)}" data-unit="${escapeHtml(ing.unit)}">${escapeHtml(ing.name)} (${formatCurrency(ing.price)} / ${formatNumber(ing.qty)}${uDisp})</option>`;
    });
    html += `</optgroup>`;
  }

  select.innerHTML = html;

  // Se o usuário digitou na busca e há resultados, pré-seleciona o primeiro resultado automaticamente!
  if (q && (baseRecipes.length + stockIngs.length > 0)) {
    select.selectedIndex = 1;
    onModalAddIngSelectChange();
  }
}

function onModalAddIngSelectChange() {
  const select = document.getElementById('modalAddIngSelect');
  const unitSelect = document.getElementById('modalAddIngUnit');
  if (!select || !unitSelect) return;

  const opt = select.options[select.selectedIndex];
  if (!opt || !opt.value) return;

  const rawUnit = (opt.getAttribute('data-unit') || 'g').toLowerCase();
  if (rawUnit === 'kg') unitSelect.value = 'g';
  else if (rawUnit === 'l') unitSelect.value = 'ml';
  else unitSelect.value = rawUnit;
}

function addSelectedIngToDraft() {
  if (!uiState.draftRecipe) return;
  const select = document.getElementById('modalAddIngSelect');
  const qtyInput = document.getElementById('modalAddIngQty');
  const unitSelect = document.getElementById('modalAddIngUnit');
  const filterInput = document.getElementById('ingSearchFilterInput');

  const val = select ? select.value : '';
  const qty = parseFloat(qtyInput ? qtyInput.value : 0);
  const unit = unitSelect ? unitSelect.value : 'g';

  if (!val) {
    showToast('Selecione um insumo ou sub-receita na lista.', 'error');
    if (filterInput) filterInput.focus();
    return;
  }
  if (!qty || qty <= 0) {
    showToast('Informe uma quantidade válida maior que zero.', 'error');
    if (qtyInput) qtyInput.focus();
    return;
  }

  if (val.startsWith('sub:')) {
    const subId = val.replace(/^sub:/, '');
    const numSubId = isNaN(Number(subId)) ? subId : Number(subId);
    uiState.draftRecipe.ingredients.push({
      id: `sub:${numSubId}`,
      type: 'subrecipe',
      subRecipeId: numSubId,
      qty,
      unit
    });
  } else {
    const ingId = isNaN(Number(val)) ? val : Number(val);
    uiState.draftRecipe.ingredients.push({
      id: ingId,
      type: 'ingredient',
      qty,
      unit
    });
  }

  if (qtyInput) qtyInput.value = '';
  if (filterInput) {
    filterInput.value = '';
    filterModalIngSelect();
  }

  renderDraftIngredientsList();
  updateRecipeLivePreview();
}

function updateDraftIngField(index, field, value) {
  if (!uiState.draftRecipe || !uiState.draftRecipe.ingredients[index]) return;
  if (field === 'qty') {
    uiState.draftRecipe.ingredients[index].qty = parseFloat(value) || 0;
  } else if (field === 'unit') {
    uiState.draftRecipe.ingredients[index].unit = value;
  }
  // Atualiza o custo exibido no próprio item sem recriar os inputs (para não perder o foco de digitação!)
  const itemRowCostEl = document.getElementById(`draft-ing-cost-${index}`);
  if (itemRowCostEl) {
    const info = calculateIngredientRowCost(uiState.draftRecipe.ingredients[index]);
    itemRowCostEl.textContent = formatCurrency(info.cost);
  }
  updateRecipeLivePreview();
}

function removeDraftIng(index) {
  if (!uiState.draftRecipe) return;
  uiState.draftRecipe.ingredients.splice(index, 1);
  renderDraftIngredientsList();
  updateRecipeLivePreview();
}

function renderDraftIngredientsList() {
  const container = document.getElementById('draftIngredientsContainer');
  if (!container || !uiState.draftRecipe) return;

  const list = uiState.draftRecipe.ingredients || [];
  if (list.length === 0) {
    container.innerHTML = `<div class="draft-empty">Nenhum ingrediente adicionado ainda. Use a busca acima para adicionar insumos ou sub-receitas.</div>`;
    return;
  }

  let html = '';
  list.forEach((rIng, idx) => {
    const info = calculateIngredientRowCost(rIng);
    const curUnit = (rIng.unit || 'g').toLowerCase();
    const badgeHtml = info.isSubRecipe
      ? `<span class="badge badge-subrecipe">🍲 Sub-receita</span>`
      : `<span class="badge badge-unit">🥣 Insumo</span>`;

    html += `
      <div class="draft-item-row">
        <div class="draft-item-name">
          ${badgeHtml}
          <span>${escapeHtml(info.name)}</span>
          <small style="color: var(--text-muted); font-weight: 400;">(${escapeHtml(info.unitPriceText)})</small>
        </div>

        <div class="draft-item-controls">
          <input
            type="number"
            inputmode="decimal"
            step="any"
            min="0"
            value="${rIng.qty}"
            oninput="updateDraftIngField(${idx}, 'qty', this.value)"
            title="Quantidade usada na receita"
          />
          <select onchange="updateDraftIngField(${idx}, 'unit', this.value)">
            <option value="g" ${curUnit === 'g' ? 'selected' : ''}>g</option>
            <option value="kg" ${curUnit === 'kg' ? 'selected' : ''}>kg</option>
            <option value="ml" ${curUnit === 'ml' ? 'selected' : ''}>ml</option>
            <option value="l" ${curUnit === 'l' ? 'selected' : ''}>L</option>
            <option value="un" ${curUnit === 'un' ? 'selected' : ''}>un</option>
          </select>
          <span class="draft-item-cost" id="draft-ing-cost-${idx}">${formatCurrency(info.cost)}</span>
          <button type="button" class="btn-remove-item" onclick="removeDraftIng(${idx})" title="Remover item">&times;</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// --- Cadastro Rápido de Insumo dentro do Modal de Receita ---
function toggleQuickNewIngInModal() {
  const box = document.getElementById('modalQuickNewIngBox');
  if (!box) return;
  const isHidden = box.style.display === 'none';
  box.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    document.getElementById('qIngName').value = '';
    document.getElementById('qIngPrice').value = '';
    document.getElementById('qIngQty').value = '';
    document.getElementById('qIngUnit').value = 'g';
    document.getElementById('qIngName').focus();
  }
}

function saveQuickIngFromRecipeModal() {
  const name = document.getElementById('qIngName').value.trim();
  const price = parseFloat(document.getElementById('qIngPrice').value);
  const qty = parseFloat(document.getElementById('qIngQty').value);
  const unit = document.getElementById('qIngUnit').value;

  if (!name || isNaN(price) || isNaN(qty) || qty <= 0) {
    showToast('Preencha nome, preço e quantidade do pacote do novo insumo.', 'error');
    return;
  }

  const newIng = { id: generateId(), name, price, qty, unit };
  appData.ingredients.push(newIng);
  saveDataToCloudAndLocal();
  renderIngredients();
  updateHeaderCountsAndKPIs();

  toggleQuickNewIngInModal();
  filterModalIngSelect();

  const select = document.getElementById('modalAddIngSelect');
  if (select) {
    select.value = String(newIng.id);
    onModalAddIngSelectChange();
  }
  const qtyInput = document.getElementById('modalAddIngQty');
  if (qtyInput) qtyInput.focus();

  showToast(`🥣 Insumo "${name}" cadastrado! Digite a quantidade usada na receita.`, 'success');
}

// --- Embalagens dentro do Modal de Receita ---
function filterModalPkgSelect() {
  const select = document.getElementById('modalAddPkgSelect');
  const filterInput = document.getElementById('pkgSearchFilterInput');
  if (!select) return;

  const q = filterInput ? filterInput.value.trim().toLowerCase() : '';
  const pkgs = appData.packaging
    .filter(p => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  let html = `<option value="">-- Selecione a Embalagem (${pkgs.length} disponíveis) --</option>`;
  pkgs.forEach(p => {
    const unitCost = p.qty > 0 ? p.price / p.qty : 0;
    html += `<option value="${escapeHtml(p.id)}">🎁 ${escapeHtml(p.name)} (Pacote c/ ${formatNumber(p.qty)} = ${formatCurrency(unitCost)}/un)</option>`;
  });
  select.innerHTML = html;

  if (q && pkgs.length > 0) {
    select.selectedIndex = 1;
    onModalAddPkgSelectChange();
  }
}

function onModalAddPkgSelectChange() {
  const qtyInput = document.getElementById('modalAddPkgQty');
  const yieldInput = document.getElementById('recYieldQty');
  if (qtyInput && !qtyInput.value && yieldInput && yieldInput.value) {
    qtyInput.value = yieldInput.value;
  }
}

function setModalPkgQtyToYield() {
  const qtyInput = document.getElementById('modalAddPkgQty');
  const yieldInput = document.getElementById('recYieldQty');
  if (qtyInput && yieldInput) {
    qtyInput.value = parseFloat(yieldInput.value) || 1;
    qtyInput.focus();
  }
}

function addSelectedPkgToDraft() {
  if (!uiState.draftRecipe) return;
  const select = document.getElementById('modalAddPkgSelect');
  const qtyInput = document.getElementById('modalAddPkgQty');
  const filterInput = document.getElementById('pkgSearchFilterInput');

  const val = select ? select.value : '';
  const qty = parseFloat(qtyInput ? qtyInput.value : 0);

  if (!val) {
    showToast('Selecione uma embalagem na lista.', 'error');
    return;
  }
  if (!qty || qty <= 0) {
    showToast('Informe quantas unidades de embalagem são usadas na receita.', 'error');
    if (qtyInput) qtyInput.focus();
    return;
  }

  const pkgId = isNaN(Number(val)) ? val : Number(val);
  uiState.draftRecipe.packaging.push({ id: pkgId, qty });

  if (qtyInput) qtyInput.value = '';
  if (filterInput) {
    filterInput.value = '';
    filterModalPkgSelect();
  }

  renderDraftPackagingsList();
  updateRecipeLivePreview();
}

function updateDraftPkgQty(index, value) {
  if (!uiState.draftRecipe || !uiState.draftRecipe.packaging[index]) return;
  const qty = parseFloat(value) || 0;
  uiState.draftRecipe.packaging[index].qty = qty;

  const costEl = document.getElementById(`draft-pkg-cost-${index}`);
  if (costEl) {
    const rPack = uiState.draftRecipe.packaging[index];
    const dbPack = appData.packaging.find(p => String(p.id) === String(rPack.id));
    const cost = dbPack && dbPack.qty > 0 ? (dbPack.price / dbPack.qty) * qty : 0;
    costEl.textContent = formatCurrency(cost);
  }
  updateRecipeLivePreview();
}

function removeDraftPkg(index) {
  if (!uiState.draftRecipe) return;
  uiState.draftRecipe.packaging.splice(index, 1);
  renderDraftPackagingsList();
  updateRecipeLivePreview();
}

function renderDraftPackagingsList() {
  const container = document.getElementById('draftPackagingsContainer');
  if (!container || !uiState.draftRecipe) return;

  const list = uiState.draftRecipe.packaging || [];
  if (list.length === 0) {
    container.innerHTML = `<div class="draft-empty">Nenhuma embalagem vinculada (ideal para Receitas Base ou produtos sem embalagem).</div>`;
    return;
  }

  let html = '';
  list.forEach((rPack, idx) => {
    const dbPack = appData.packaging.find(p => String(p.id) === String(rPack.id));
    const name = dbPack ? dbPack.name : 'Embalagem excluída';
    const unitPrice = dbPack && dbPack.qty > 0 ? dbPack.price / dbPack.qty : 0;
    const totalCost = unitPrice * (parseFloat(rPack.qty) || 0);

    html += `
      <div class="draft-item-row">
        <div class="draft-item-name">
          <span class="badge badge-cat">🎁 Emb.</span>
          <span>${escapeHtml(name)}</span>
          <small style="color: var(--text-muted); font-weight: 400;">(${formatCurrency(unitPrice)} / un)</small>
        </div>

        <div class="draft-item-controls">
          <input
            type="number"
            inputmode="decimal"
            step="any"
            min="0"
            value="${rPack.qty}"
            oninput="updateDraftPkgQty(${idx}, this.value)"
            title="Unidades usadas para o lote inteiro"
          />
          <span style="font-size: 0.82rem; color: var(--text-muted); width: 28px;">un</span>
          <span class="draft-item-cost" id="draft-pkg-cost-${idx}">${formatCurrency(totalCost)}</span>
          <button type="button" class="btn-remove-item" onclick="removeDraftPkg(${idx})" title="Remover embalagem">&times;</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function toggleQuickNewPkgInModal() {
  const box = document.getElementById('modalQuickNewPkgBox');
  if (!box) return;
  const isHidden = box.style.display === 'none';
  box.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    document.getElementById('qPkgName').value = '';
    document.getElementById('qPkgPrice').value = '';
    document.getElementById('qPkgQty').value = '';
    document.getElementById('qPkgName').focus();
  }
}

function saveQuickPkgFromRecipeModal() {
  const name = document.getElementById('qPkgName').value.trim();
  const price = parseFloat(document.getElementById('qPkgPrice').value);
  const qty = parseFloat(document.getElementById('qPkgQty').value);

  if (!name || isNaN(price) || isNaN(qty) || qty <= 0) {
    showToast('Preencha nome, preço do pacote e unidades no pacote.', 'error');
    return;
  }

  const newPkg = { id: generateId(), name, price, qty };
  appData.packaging.push(newPkg);
  saveDataToCloudAndLocal();
  renderPackagings();
  updateHeaderCountsAndKPIs();

  toggleQuickNewPkgInModal();
  filterModalPkgSelect();

  const select = document.getElementById('modalAddPkgSelect');
  if (select) select.value = String(newPkg.id);
  setModalPkgQtyToYield();

  showToast(`🎁 Embalagem "${name}" cadastrada!`, 'success');
}

/**
 * Sincroniza os campos do formulário no draftRecipe e atualiza o Live Preview na hora
 */
function syncFormFieldsToDraftRecipe() {
  if (!uiState.draftRecipe) return;
  const d = uiState.draftRecipe;

  d.name = document.getElementById('recName').value;
  const catSelVal = document.getElementById('recCategorySelect').value;
  if (catSelVal && catSelVal !== '__new__') {
    d.categoryId = isNaN(Number(catSelVal)) ? catSelVal : Number(catSelVal);
  }
  d.yield = parseFloat(document.getElementById('recYieldQty').value) > 0
    ? parseFloat(document.getElementById('recYieldQty').value)
    : 1;
  d.yieldUnit = document.getElementById('recYieldUnit').value.trim() || 'unidades';
  d.isBase = document.getElementById('recIsBase').checked;

  const bwVal = document.getElementById('recBaseYieldWeight').value;
  d.baseYieldWeight = bwVal !== '' && parseFloat(bwVal) > 0 ? parseFloat(bwVal) : null;
  d.baseYieldUnit = document.getElementById('recBaseYieldUnit').value || 'g';

  const utilVal = document.getElementById('recCustomUtility').value;
  d.customUtilityCost = utilVal !== '' ? parseFloat(utilVal) : null;

  const wasteVal = document.getElementById('recCustomWaste').value;
  d.customWasteMargin = wasteVal !== '' ? parseFloat(wasteVal) : null;

  const marginVal = document.getElementById('recCustomMargin').value;
  d.customProfitMargin = marginVal !== '' ? parseFloat(marginVal) : null;

  const customPriceVal = document.getElementById('recCustomPrice').value;
  d.customPrice = customPriceVal !== '' && parseFloat(customPriceVal) > 0 ? parseFloat(customPriceVal) : null;

  d.notes = document.getElementById('recNotes').value;
}

function updateRecipeLivePreview() {
  if (!uiState.draftRecipe) return;
  syncFormFieldsToDraftRecipe();

  const d = uiState.draftRecipe;
  const calc = calculateRecipeCosts(d);

  const autoW = calculateRecipeAutoWeight(d);
  const autoHint = document.getElementById('recAutoWeightHint');
  if (autoHint) {
    autoHint.textContent = autoW > 0 ? `(Soma automática dos ingredientes: ${formatNumber(autoW)}g)` : '';
  }

  document.getElementById('livePreviewYieldText').textContent =
    `Rendimento: ${formatNumber(d.yield)} ${d.yieldUnit || 'unidades'}`;
  document.getElementById('prevBatchCost').textContent = formatCurrency(calc.totalBatchCost);
  document.getElementById('prevBatchSub').textContent =
    `Ins: ${formatCurrency(calc.rawIngredientsBatchCost)} • Emb: ${formatCurrency(calc.packagingBatchCost)}`;

  document.getElementById('prevUnitCost').textContent = formatCurrency(calc.totalUnitCost);
  document.getElementById('prevUnitBreakdown').textContent =
    `Ins: ${formatCurrency(calc.onlyIngredientsCost)} • Adic: ${formatCurrency(calc.additionalCosts)}`;

  document.getElementById('prevSuggestedPrice').textContent = formatCurrency(calc.finalUnitPrice);
  document.getElementById('prevProfitSub').textContent =
    `Lucro: ${formatCurrency(calc.profitPerUnit)} / un`;

  document.getElementById('prevIfoodLabel').textContent =
    `Preço iFood (+${formatNumber(appData.settings.ifoodFee)}%)`;
  document.getElementById('prevIfoodPrice').textContent = formatCurrency(calc.iFoodPrice);

  document.getElementById('prevBatchProfit').textContent = formatCurrency(calc.batchProfit);
  document.getElementById('prevMarginSub').textContent =
    `Margem efetiva: ${formatNumber(calc.effectiveMarginPercent, 1)}%`;
}

function saveRecipeFromModal(event) {
  if (event) event.preventDefault();
  if (!uiState.draftRecipe) return;

  syncFormFieldsToDraftRecipe();
  const d = uiState.draftRecipe;

  if (!d.name || !d.name.trim()) {
    showToast('Informe o nome da receita/produto.', 'error');
    document.getElementById('recName').focus();
    return;
  }

  const scrollYBefore = window.scrollY;
  let savedId = d.id;

  if (savedId) {
    const idx = appData.recipes.findIndex(r => String(r.id) === String(savedId));
    if (idx !== -1) {
      appData.recipes[idx] = JSON.parse(JSON.stringify(d));
    } else {
      appData.recipes.push(JSON.parse(JSON.stringify(d)));
    }
  } else {
    savedId = generateId();
    d.id = savedId;
    appData.recipes.push(JSON.parse(JSON.stringify(d)));
  }

  saveDataToCloudAndLocal();
  closeRecipeModal();
  updateHeaderCountsAndKPIs();
  renderRecipeCategoryPills();
  renderRecipes(true);
  renderDashboardTable();
  calculateAndRenderGoal();

  // Mantém a posição exata da página e destaca suavemente o card salvo
  window.scrollTo({ top: scrollYBefore, behavior: 'instant' });
  const cardEl = document.getElementById(`recipe-card-${savedId}`);
  if (cardEl) {
    cardEl.style.boxShadow = '0 0 0 3px var(--primary)';
    setTimeout(() => {
      cardEl.style.boxShadow = '';
    }, 1800);
  }

  showToast(`✅ Receita "${d.name}" salva com sucesso!`, 'success');
}

function duplicateRecipe(recipeId) {
  const orig = appData.recipes.find(r => String(r.id) === String(recipeId));
  if (!orig) return;

  const copy = JSON.parse(JSON.stringify(orig));
  copy.id = generateId();
  copy.name = `${orig.name} (Cópia)`;

  appData.recipes.push(copy);
  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderRecipeCategoryPills();
  renderRecipes(true);
  showToast(`📋 Receita duplicada: "${copy.name}"`, 'success');
}

function deleteRecipe(recipeId) {
  const orig = appData.recipes.find(r => String(r.id) === String(recipeId));
  if (!orig) return;

  if (!confirm(`Deseja realmente excluir a receita "${orig.name}"?`)) return;

  const scrollYBefore = window.scrollY;
  appData.recipes = appData.recipes.filter(r => String(r.id) !== String(recipeId));
  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderRecipeCategoryPills();
  renderRecipes(true);
  renderDashboardTable();
  window.scrollTo({ top: scrollYBefore, behavior: 'instant' });
  showToast(`🗑️ Receita "${orig.name}" removida.`, 'info');
}

// ============================================================================
// 8. MODAL DE FICHA TÉCNICA COMPLETA ("REVELAR")
// ============================================================================

function openRevealModal(recipeId) {
  const recipe = appData.recipes.find(r => String(r.id) === String(recipeId));
  if (!recipe) return;

  const modal = document.getElementById('revealModal');
  const titleEl = document.getElementById('revealTitle');
  const bodyEl = document.getElementById('revealBody');
  const editBtn = document.getElementById('btnRevealEdit');

  const calc = calculateRecipeCosts(recipe);
  const catName = getCategoryName(recipe.categoryId);
  const yieldVal = parseFloat(recipe.yield) || 1;
  const yieldUnit = recipe.yieldUnit || 'unidades';

  if (titleEl) titleEl.textContent = `📄 Ficha Técnica: ${recipe.name}`;
  if (editBtn) {
    editBtn.onclick = () => {
      closeRevealModal();
      openRecipeModal(recipe.id);
    };
  }

  let ingRowsHtml = '';
  (recipe.ingredients || []).forEach(rIng => {
    const info = calculateIngredientRowCost(rIng);
    const qtyPerUnit = (parseFloat(rIng.qty) || 0) / yieldVal;
    const sharePercent = calc.rawIngredientsBatchCost > 0 ? (info.cost / calc.rawIngredientsBatchCost) * 100 : 0;
    ingRowsHtml += `
      <tr>
        <td><strong>${escapeHtml(info.name)}</strong> ${info.isSubRecipe ? '<span class="badge badge-subrecipe">🍲 Base</span>' : ''}</td>
        <td>${formatNumber(rIng.qty, 3)} ${escapeHtml(formatUnitDisplay(rIng.unit))}</td>
        <td>${formatNumber(qtyPerUnit, 2)} ${escapeHtml(formatUnitDisplay(rIng.unit))}</td>
        <td>${formatCurrency(info.cost)}</td>
        <td>${formatNumber(sharePercent, 1)}%</td>
      </tr>
    `;
  });

  let pkgRowsHtml = '';
  (recipe.packaging || []).forEach(rPack => {
    const dbPack = appData.packaging.find(p => String(p.id) === String(rPack.id));
    if (dbPack) {
      const unitCost = dbPack.qty > 0 ? dbPack.price / dbPack.qty : 0;
      const batchCost = unitCost * (parseFloat(rPack.qty) || 0);
      pkgRowsHtml += `
        <tr>
          <td>🎁 ${escapeHtml(dbPack.name)}</td>
          <td>${formatNumber(rPack.qty, 2)} un</td>
          <td>${formatCurrency(unitCost)} / un</td>
          <td>${formatCurrency(batchCost)}</td>
        </tr>
      `;
    }
  });

  bodyEl.innerHTML = `
    <div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.75rem; margin-bottom: 1rem;">
      <div>
        <span class="badge badge-cat">${escapeHtml(catName)}</span>
        <span class="badge badge-unit">Rendimento: ${formatNumber(yieldVal)} ${escapeHtml(yieldUnit)}</span>
        ${recipe.isBase ? '<span class="badge badge-subrecipe">🍲 Receita Base</span>' : ''}
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted);">
        Luz/Gás: <strong>${formatCurrency(calc.utilityCostUsed)}</strong> • Perda: <strong>${formatNumber(calc.wasteMarginUsed)}%</strong>
      </div>
    </div>

    <div class="recipe-stats-6" style="margin-bottom: 1.25rem;">
      <div class="stat-cell">
        <span class="s-label">Custo Unitário</span>
        <span class="s-val">${formatCurrency(calc.totalUnitCost)}</span>
        <span class="s-sub">Lote: ${formatCurrency(calc.totalBatchCost)}</span>
      </div>
      <div class="stat-cell stat-price">
        <span class="s-label">Venda Direta / PIX</span>
        <span class="s-val">${formatCurrency(calc.finalUnitPrice)}</span>
        <span class="s-sub">Lucro: ${formatCurrency(calc.profitPerUnit)}/un</span>
      </div>
      <div class="stat-cell">
        <span class="s-label">Cartão Débito (+${formatNumber(appData.settings.debitFee)}%)</span>
        <span class="s-val">${formatCurrency(calc.debitPrice)}</span>
      </div>
      <div class="stat-cell">
        <span class="s-label">Cartão Crédito (+${formatNumber(appData.settings.creditFee)}%)</span>
        <span class="s-val">${formatCurrency(calc.creditPrice)}</span>
      </div>
      <div class="stat-cell stat-ifood">
        <span class="s-label">Preço iFood (+${formatNumber(appData.settings.ifoodFee)}%)</span>
        <span class="s-val">${formatCurrency(calc.iFoodPrice)}</span>
      </div>
      <div class="stat-cell">
        <span class="s-label">Lucro do Lote (${formatNumber(yieldVal)} un)</span>
        <span class="s-val" style="color: var(--success);">${formatCurrency(calc.batchProfit)}</span>
        <span class="s-sub">Faturamento: ${formatCurrency(calc.batchRevenue)}</span>
      </div>
    </div>

    <h4 style="margin-bottom: 0.5rem; font-size: 0.95rem;">🥣 Composição de Ingredientes e Sub-receitas</h4>
    <div class="table-responsive" style="margin-bottom: 1.25rem;">
      <table class="data-table">
        <thead>
          <tr>
            <th>Ingrediente</th>
            <th>Qtd no Lote</th>
            <th>Qtd por Unidade</th>
            <th>Custo no Lote</th>
            <th>% dos Insumos</th>
          </tr>
        </thead>
        <tbody>
          ${ingRowsHtml || '<tr><td colspan="5" style="text-align:center;">Sem ingredientes</td></tr>'}
        </tbody>
      </table>
    </div>

    ${
      pkgRowsHtml
        ? `
      <h4 style="margin-bottom: 0.5rem; font-size: 0.95rem;">🎁 Embalagens Utilizadas no Lote</h4>
      <div class="table-responsive" style="margin-bottom: 1.25rem;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Embalagem</th>
              <th>Qtd no Lote</th>
              <th>Custo Unitário Emb.</th>
              <th>Custo no Lote</th>
            </tr>
          </thead>
          <tbody>${pkgRowsHtml}</tbody>
        </table>
      </div>
    `
        : ''
    }

    ${
      recipe.notes
        ? `
      <div class="card" style="background: var(--bg-subtle); padding: 0.9rem;">
        <strong>📝 Modo de Preparo / Observações:</strong>
        <p style="margin-top: 0.35rem; white-space: pre-wrap; font-size: 0.9rem;">${escapeHtml(recipe.notes)}</p>
      </div>
    `
        : ''
    }
  `;

  if (modal) modal.classList.add('open');
}

function closeRevealModal() {
  const modal = document.getElementById('revealModal');
  if (modal) modal.classList.remove('open');
}

// ============================================================================
// 9. ABA 2: INSUMOS (COM EDIÇÃO INLINE DE PREÇO E QUANTIDADE EM 1 CLIQUE)
// ============================================================================

function setIngUnitFilter(unitGroup) {
  uiState.ingUnitFilter = unitGroup;
  document.querySelectorAll('#ingUnitFilterBar .pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-unit') === unitGroup);
  });
  renderIngredients();
}

function setIngViewMode(mode) {
  uiState.ingViewMode = mode;
  document.getElementById('btnIngViewTable')?.classList.toggle('active', mode === 'table');
  document.getElementById('btnIngViewCards')?.classList.toggle('active', mode === 'cards');
  renderIngredients();
}

function saveIngredient(event) {
  if (event) event.preventDefault();
  const idVal = document.getElementById('ingId').value;
  const name = document.getElementById('ingName').value.trim();
  const price = parseFloat(document.getElementById('ingPrice').value);
  const qty = parseFloat(document.getElementById('ingQty').value);
  const unit = document.getElementById('ingUnit').value;

  if (!name || isNaN(price) || isNaN(qty) || qty <= 0) {
    showToast('Preencha nome, preço e quantidade válida.', 'error');
    return;
  }

  if (idVal) {
    const idx = appData.ingredients.findIndex(i => String(i.id) === String(idVal));
    if (idx !== -1) {
      appData.ingredients[idx] = { ...appData.ingredients[idx], name, price, qty, unit };
    }
    showToast(`✅ Insumo "${name}" atualizado e receitas recalculadas!`, 'success');
  } else {
    appData.ingredients.push({ id: generateId(), name, price, qty, unit });
    showToast(`➕ Insumo "${name}" cadastrado no estoque!`, 'success');
  }

  resetIngredientForm();
  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderIngredients();
  renderRecipes(true);
  renderDashboardTable();
}

function resetIngredientForm() {
  document.getElementById('ingId').value = '';
  document.getElementById('ingName').value = '';
  document.getElementById('ingPrice').value = '';
  document.getElementById('ingQty').value = '';
  document.getElementById('ingUnit').value = 'g';
  document.getElementById('ingredientFormTitle').textContent = '➕ Cadastrar Novo Insumo';
  document.getElementById('btnSaveIng').textContent = '💾 Salvar Insumo';
  document.getElementById('btnCancelIng').style.display = 'none';
}

function editIngredient(id) {
  const ing = appData.ingredients.find(i => String(i.id) === String(id));
  if (!ing) return;

  document.getElementById('ingId').value = ing.id;
  document.getElementById('ingName').value = ing.name;
  document.getElementById('ingPrice').value = ing.price;
  document.getElementById('ingQty').value = ing.qty;
  document.getElementById('ingUnit').value = ing.unit;
  document.getElementById('ingredientFormTitle').textContent = `✏️ Editando Insumo: ${ing.name}`;
  document.getElementById('btnSaveIng').textContent = '💾 Atualizar Insumo';
  document.getElementById('btnCancelIng').style.display = 'inline-flex';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('ingName').focus();
}

/**
 * Edição rápida diretamente na tabela ou no card de insumos (sem abrir formulário!)
 */
function inlineUpdateIngredient(id, field, rawVal, inputEl) {
  const ing = appData.ingredients.find(i => String(i.id) === String(id));
  if (!ing) return;

  if (field === 'price') {
    const val = parseFloat(rawVal);
    if (isNaN(val) || val < 0) return;
    if (ing.price === val) return;
    ing.price = val;
  } else if (field === 'qty') {
    const val = parseFloat(rawVal);
    if (isNaN(val) || val <= 0) return;
    if (ing.qty === val) return;
    ing.qty = val;
  } else if (field === 'name') {
    const val = String(rawVal || '').trim();
    if (!val || ing.name === val) return;
    ing.name = val;
  }

  if (inputEl) {
    inputEl.classList.add('saved-flash');
    setTimeout(() => inputEl.classList.remove('saved-flash'), 900);
  }

  saveDataToCloudAndLocal(true);

  // Atualiza o texto de custo fracionado da linha imediatamente
  const unitCostCell = document.getElementById(`ing-unit-cost-${id}`);
  if (unitCostCell) {
    unitCostCell.textContent = formatIngredientFractionalCost(ing);
  }

  renderRecipes(true);
  renderDashboardTable();
  calculateAndRenderGoal();
  showToast(`⚡ "${ing.name}" atualizado! Todas as receitas foram recalculadas.`, 'success');
}

function deleteIngredient(id) {
  const ing = appData.ingredients.find(i => String(i.id) === String(id));
  if (!ing) return;

  const usedIn = appData.recipes.filter(r =>
    (r.ingredients || []).some(ri => String(ri.id) === String(id))
  );
  const warnMsg =
    usedIn.length > 0
      ? `Este insumo é utilizado em ${usedIn.length} receita(s). Deseja realmente excluir "${ing.name}"?`
      : `Deseja realmente excluir o insumo "${ing.name}"?`;

  if (!confirm(warnMsg)) return;

  appData.ingredients = appData.ingredients.filter(i => String(i.id) !== String(id));
  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderIngredients();
  renderRecipes(true);
  showToast(`🗑️ Insumo "${ing.name}" excluído.`, 'info');
}

function formatIngredientFractionalCost(ing) {
  const smallest = normalizeToSmallestUnit(ing.qty, ing.unit);
  if (smallest <= 0) return '—';
  const u = (ing.unit || 'g').toLowerCase();
  if (u === 'g' || u === 'kg') {
    const per100g = (ing.price / smallest) * 100;
    const perKg = (ing.price / smallest) * 1000;
    return `${formatCurrency(per100g)} / 100g (${formatCurrency(perKg)}/kg)`;
  }
  if (u === 'ml' || u === 'l') {
    const per100ml = (ing.price / smallest) * 100;
    const perL = (ing.price / smallest) * 1000;
    return `${formatCurrency(per100ml)} / 100ml (${formatCurrency(perL)}/L)`;
  }
  const perUn = ing.price / smallest;
  return `${formatCurrency(perUn)} / un`;
}

function countRecipesUsingIngredient(ingId) {
  return appData.recipes.filter(r =>
    (r.ingredients || []).some(ri => String(ri.id) === String(ingId))
  ).length;
}

function renderIngredients() {
  const wrapper = document.getElementById('ingredientsListWrapper');
  if (!wrapper) return;

  const searchInput = document.getElementById('searchIngredients');
  const clearBtn = document.getElementById('btnClearIngSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (clearBtn) clearBtn.style.display = query.length > 0 ? 'flex' : 'none';

  const filtered = appData.ingredients
    .filter(ing => {
      if (uiState.ingUnitFilter === 'weight' && !['g', 'kg'].includes((ing.unit || '').toLowerCase())) return false;
      if (uiState.ingUnitFilter === 'volume' && !['ml', 'l'].includes((ing.unit || '').toLowerCase())) return false;
      if (uiState.ingUnitFilter === 'unit' && (ing.unit || '').toLowerCase() !== 'un') return false;
      if (query && !ing.name.toLowerCase().includes(query)) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  if (filtered.length === 0) {
    wrapper.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🥣</div>
        <h3>Nenhum insumo encontrado</h3>
        <p>Use o formulário acima para cadastrar um novo ingrediente.</p>
      </div>
    `;
    return;
  }

  if (uiState.ingViewMode === 'cards') {
    let cardsHtml = `<div class="stock-cards-grid">`;
    filtered.forEach(ing => {
      const uDisp = formatUnitDisplay(ing.unit);
      const usedCount = countRecipesUsingIngredient(ing.id);
      cardsHtml += `
        <div class="stock-item-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem;">
            <div class="stock-item-title">${escapeHtml(ing.name)}</div>
            <span class="badge badge-unit">${usedCount} rec.</span>
          </div>
          <div class="stock-item-meta" id="ing-unit-cost-${escapeHtml(ing.id)}">${formatIngredientFractionalCost(ing)}</div>
          <div class="stock-edit-row">
            <div>
              <label style="font-size: 0.72rem;">Preço Pago (R$)</label>
              <div class="inline-input-group">
                <span class="prefix">R$</span>
                <input
                  type="number"
                  inputmode="decimal"
                  step="0.01"
                  class="inline-edit-input"
                  style="width: 100%;"
                  value="${ing.price}"
                  onchange="inlineUpdateIngredient('${escapeHtml(ing.id)}', 'price', this.value, this)"
                  onkeydown="if(event.key==='Enter'){this.blur();}"
                />
              </div>
            </div>
            <div>
              <label style="font-size: 0.72rem;">Pacote (${escapeHtml(uDisp)})</label>
              <div class="inline-input-group">
                <input
                  type="number"
                  inputmode="decimal"
                  step="any"
                  class="inline-edit-input"
                  style="width: 100%;"
                  value="${ing.qty}"
                  onchange="inlineUpdateIngredient('${escapeHtml(ing.id)}', 'qty', this.value, this)"
                  onkeydown="if(event.key==='Enter'){this.blur();}"
                />
                <span class="suffix">${escapeHtml(uDisp)}</span>
              </div>
            </div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 0.35rem; margin-top: 0.25rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="editIngredient('${escapeHtml(ing.id)}')">✏️ Editar</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteIngredient('${escapeHtml(ing.id)}')">🗑️</button>
          </div>
        </div>
      `;
    });
    cardsHtml += `</div>`;
    wrapper.innerHTML = cardsHtml;
    return;
  }

  // Visão em Tabela Rápida (Padrão Fluido)
  let rowsHtml = '';
  filtered.forEach(ing => {
    const uDisp = formatUnitDisplay(ing.unit);
    const usedCount = countRecipesUsingIngredient(ing.id);
    const linkedBase = LEGACY_BASE_INGREDIENT_LINKS.find(l => String(l.ingId) === String(ing.id));
    const baseTag = linkedBase
      ? `<span class="badge badge-subrecipe" title="Atualizado automaticamente pela Receita Base">🍲 Vinculado à Base</span>`
      : '';

    rowsHtml += `
      <tr>
        <td>
          <strong>${escapeHtml(ing.name)}</strong> ${baseTag}
        </td>
        <td>
          <div class="inline-input-group">
            <span class="prefix">R$</span>
            <input
              type="number"
              inputmode="decimal"
              step="0.01"
              min="0"
              class="inline-edit-input"
              value="${ing.price}"
              title="Altere o preço e pressione Enter para atualizar na hora"
              onchange="inlineUpdateIngredient('${escapeHtml(ing.id)}', 'price', this.value, this)"
              onkeydown="if(event.key==='Enter'){this.blur();}"
            />
          </div>
        </td>
        <td>
          <div class="inline-input-group">
            <input
              type="number"
              inputmode="decimal"
              step="any"
              min="0.0001"
              class="inline-edit-input"
              value="${ing.qty}"
              title="Altere a quantidade da embalagem e pressione Enter"
              onchange="inlineUpdateIngredient('${escapeHtml(ing.id)}', 'qty', this.value, this)"
              onkeydown="if(event.key==='Enter'){this.blur();}"
            />
            <span class="suffix">${escapeHtml(uDisp)}</span>
          </div>
        </td>
        <td id="ing-unit-cost-${escapeHtml(ing.id)}" style="color: var(--text-muted); font-size: 0.84rem;">
          ${formatIngredientFractionalCost(ing)}
        </td>
        <td>
          <span class="badge badge-unit">${usedCount} ${usedCount === 1 ? 'receita' : 'receitas'}</span>
        </td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 0.35rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="editIngredient('${escapeHtml(ing.id)}')" title="Editar nome ou unidade">✏️</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteIngredient('${escapeHtml(ing.id)}')" title="Excluir insumo">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  });

  wrapper.innerHTML = `
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th>Nome do Insumo</th>
            <th>Preço Pago (Edição Rápida)</th>
            <th>Qtd. na Embalagem</th>
            <th>Custo Proporcional</th>
            <th>Uso</th>
            <th style="text-align: right;">Ações</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// 10. ABA 3: EMBALAGENS (COM EDIÇÃO INLINE EM 1 CLIQUE)
// ============================================================================

function setPkgViewMode(mode) {
  uiState.pkgViewMode = mode;
  document.getElementById('btnPkgViewTable')?.classList.toggle('active', mode === 'table');
  document.getElementById('btnPkgViewCards')?.classList.toggle('active', mode === 'cards');
  renderPackagings();
}

function savePackaging(event) {
  if (event) event.preventDefault();
  const idVal = document.getElementById('pkgId').value;
  const name = document.getElementById('pkgName').value.trim();
  const price = parseFloat(document.getElementById('pkgPrice').value);
  const qty = parseFloat(document.getElementById('pkgQty').value);

  if (!name || isNaN(price) || isNaN(qty) || qty <= 0) {
    showToast('Preencha nome, preço e unidades no pacote.', 'error');
    return;
  }

  if (idVal) {
    const idx = appData.packaging.findIndex(p => String(p.id) === String(idVal));
    if (idx !== -1) {
      appData.packaging[idx] = { ...appData.packaging[idx], name, price, qty };
    }
    showToast(`✅ Embalagem "${name}" atualizada!`, 'success');
  } else {
    appData.packaging.push({ id: generateId(), name, price, qty });
    showToast(`➕ Embalagem "${name}" cadastrada!`, 'success');
  }

  resetPackagingForm();
  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderPackagings();
  renderRecipes(true);
  renderDashboardTable();
}

function resetPackagingForm() {
  document.getElementById('pkgId').value = '';
  document.getElementById('pkgName').value = '';
  document.getElementById('pkgPrice').value = '';
  document.getElementById('pkgQty').value = '';
  document.getElementById('packagingFormTitle').textContent = '➕ Cadastrar Nova Embalagem';
  document.getElementById('btnSavePkg').textContent = '💾 Salvar Embalagem';
  document.getElementById('btnCancelPkg').style.display = 'none';
}

function editPackaging(id) {
  const pkg = appData.packaging.find(p => String(p.id) === String(id));
  if (!pkg) return;

  document.getElementById('pkgId').value = pkg.id;
  document.getElementById('pkgName').value = pkg.name;
  document.getElementById('pkgPrice').value = pkg.price;
  document.getElementById('pkgQty').value = pkg.qty;
  document.getElementById('packagingFormTitle').textContent = `✏️ Editando Embalagem: ${pkg.name}`;
  document.getElementById('btnSavePkg').textContent = '💾 Atualizar Embalagem';
  document.getElementById('btnCancelPkg').style.display = 'inline-flex';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('pkgName').focus();
}

function inlineUpdatePackaging(id, field, rawVal, inputEl) {
  const pkg = appData.packaging.find(p => String(p.id) === String(id));
  if (!pkg) return;

  if (field === 'price') {
    const val = parseFloat(rawVal);
    if (isNaN(val) || val < 0 || pkg.price === val) return;
    pkg.price = val;
  } else if (field === 'qty') {
    const val = parseFloat(rawVal);
    if (isNaN(val) || val <= 0 || pkg.qty === val) return;
    pkg.qty = val;
  }

  if (inputEl) {
    inputEl.classList.add('saved-flash');
    setTimeout(() => inputEl.classList.remove('saved-flash'), 900);
  }

  saveDataToCloudAndLocal(true);

  const unitCell = document.getElementById(`pkg-unit-cost-${id}`);
  if (unitCell) {
    const unitCost = pkg.qty > 0 ? pkg.price / pkg.qty : 0;
    unitCell.textContent = `${formatCurrency(unitCost)} / un`;
  }

  renderRecipes(true);
  renderDashboardTable();
  calculateAndRenderGoal();
  showToast(`⚡ Embalagem "${pkg.name}" atualizada! Receitas recalculadas.`, 'success');
}

function deletePackaging(id) {
  const pkg = appData.packaging.find(p => String(p.id) === String(id));
  if (!pkg) return;

  if (!confirm(`Deseja realmente excluir a embalagem "${pkg.name}"?`)) return;

  appData.packaging = appData.packaging.filter(p => String(p.id) !== String(id));
  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderPackagings();
  renderRecipes(true);
  showToast(`🗑️ Embalagem "${pkg.name}" excluída.`, 'info');
}

function renderPackagings() {
  const wrapper = document.getElementById('packagingsListWrapper');
  if (!wrapper) return;

  const searchInput = document.getElementById('searchPackagings');
  const clearBtn = document.getElementById('btnClearPkgSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (clearBtn) clearBtn.style.display = query.length > 0 ? 'flex' : 'none';

  const filtered = appData.packaging
    .filter(p => !query || p.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  if (filtered.length === 0) {
    wrapper.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎁</div>
        <h3>Nenhuma embalagem encontrada</h3>
        <p>Cadastre potes, etiquetas, saquinhos ou caixas no formulário acima.</p>
      </div>
    `;
    return;
  }

  if (uiState.pkgViewMode === 'cards') {
    let cardsHtml = `<div class="stock-cards-grid">`;
    filtered.forEach(p => {
      const unitCost = p.qty > 0 ? p.price / p.qty : 0;
      cardsHtml += `
        <div class="stock-item-card">
          <div class="stock-item-title">🎁 ${escapeHtml(p.name)}</div>
          <div class="stock-item-meta" id="pkg-unit-cost-${escapeHtml(p.id)}">Custo Unitário: <strong>${formatCurrency(unitCost)} / un</strong></div>
          <div class="stock-edit-row">
            <div>
              <label style="font-size: 0.72rem;">Preço Pacote (R$)</label>
              <div class="inline-input-group">
                <span class="prefix">R$</span>
                <input
                  type="number"
                  inputmode="decimal"
                  step="0.01"
                  class="inline-edit-input"
                  style="width: 100%;"
                  value="${p.price}"
                  onchange="inlineUpdatePackaging('${escapeHtml(p.id)}', 'price', this.value, this)"
                  onkeydown="if(event.key==='Enter'){this.blur();}"
                />
              </div>
            </div>
            <div>
              <label style="font-size: 0.72rem;">Qtd. no Pacote</label>
              <div class="inline-input-group">
                <input
                  type="number"
                  inputmode="decimal"
                  step="any"
                  class="inline-edit-input"
                  style="width: 100%;"
                  value="${p.qty}"
                  onchange="inlineUpdatePackaging('${escapeHtml(p.id)}', 'qty', this.value, this)"
                  onkeydown="if(event.key==='Enter'){this.blur();}"
                />
                <span class="suffix">un</span>
              </div>
            </div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 0.35rem; margin-top: 0.25rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="editPackaging('${escapeHtml(p.id)}')">✏️ Editar</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deletePackaging('${escapeHtml(p.id)}')">🗑️</button>
          </div>
        </div>
      `;
    });
    cardsHtml += `</div>`;
    wrapper.innerHTML = cardsHtml;
    return;
  }

  let rowsHtml = '';
  filtered.forEach(p => {
    const unitCost = p.qty > 0 ? p.price / p.qty : 0;
    const usedCount = appData.recipes.filter(r =>
      (r.packaging || []).some(rp => String(rp.id) === String(p.id))
    ).length;

    rowsHtml += `
      <tr>
        <td><strong>🎁 ${escapeHtml(p.name)}</strong></td>
        <td>
          <div class="inline-input-group">
            <span class="prefix">R$</span>
            <input
              type="number"
              inputmode="decimal"
              step="0.01"
              min="0"
              class="inline-edit-input"
              value="${p.price}"
              onchange="inlineUpdatePackaging('${escapeHtml(p.id)}', 'price', this.value, this)"
              onkeydown="if(event.key==='Enter'){this.blur();}"
            />
          </div>
        </td>
        <td>
          <div class="inline-input-group">
            <input
              type="number"
              inputmode="decimal"
              step="any"
              min="0.0001"
              class="inline-edit-input"
              value="${p.qty}"
              onchange="inlineUpdatePackaging('${escapeHtml(p.id)}', 'qty', this.value, this)"
              onkeydown="if(event.key==='Enter'){this.blur();}"
            />
            <span class="suffix">un</span>
          </div>
        </td>
        <td id="pkg-unit-cost-${escapeHtml(p.id)}" style="font-weight: 700; color: var(--primary);">
          ${formatCurrency(unitCost)} / un
        </td>
        <td>
          <span class="badge badge-unit">${usedCount} ${usedCount === 1 ? 'receita' : 'receitas'}</span>
        </td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 0.35rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="editPackaging('${escapeHtml(p.id)}')">✏️</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deletePackaging('${escapeHtml(p.id)}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  });

  wrapper.innerHTML = `
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th>Nome da Embalagem</th>
            <th>Preço Pacote (Edição Rápida)</th>
            <th>Unidades no Pacote</th>
            <th>Custo Unitário</th>
            <th>Uso</th>
            <th style="text-align: right;">Ações</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// 11. ABA 4: SIMULADOR DE METAS (COM AUTO-SAVE) E RESUMO DE RENTABILIDADE
// ============================================================================

function getCatalogAverages() {
  const sellableRecipes = appData.recipes.filter(r => !r.isBase);
  const list = sellableRecipes.length > 0 ? sellableRecipes : appData.recipes;
  if (list.length === 0) return { avgUnitCost: 0, avgSellPrice: 0 };

  let sumCost = 0;
  let sumPrice = 0;
  list.forEach(r => {
    const c = calculateRecipeCosts(r);
    sumCost += c.totalUnitCost;
    sumPrice += c.finalUnitPrice;
  });

  return {
    avgUnitCost: sumCost / list.length,
    avgSellPrice: sumPrice / list.length
  };
}

function populateGoalSimulatorInputs() {
  const fixedEl = document.getElementById('goalFixedCost');
  const priceEl = document.getElementById('goalTargetPrice');
  const daysEl = document.getElementById('goalWorkDays');

  const { avgSellPrice } = getCatalogAverages();

  if (fixedEl) fixedEl.value = appData.settings.monthlyFixed || 0;
  if (priceEl) {
    const savedTarget = parseFloat(appData.settings.targetPrice) || 0;
    priceEl.value = savedTarget > 0 ? savedTarget : Number(avgSellPrice.toFixed(2));
  }
  if (daysEl) daysEl.value = appData.settings.workDays || 26;
}

function fillAverageCatalogPrice() {
  const { avgSellPrice } = getCatalogAverages();
  const priceEl = document.getElementById('goalTargetPrice');
  if (priceEl) {
    priceEl.value = Number(avgSellPrice.toFixed(2));
    onGoalInputsChange();
    showToast(`✨ Preço médio do catálogo (${formatCurrency(avgSellPrice)}) aplicado!`, 'info');
  }
}

function onGoalInputsChange() {
  const fixedVal = parseFloat(document.getElementById('goalFixedCost')?.value) || 0;
  const targetVal = parseFloat(document.getElementById('goalTargetPrice')?.value) || 0;
  const daysVal = parseInt(document.getElementById('goalWorkDays')?.value, 10) || 26;

  appData.settings.monthlyFixed = fixedVal;
  appData.settings.targetPrice = targetVal;
  appData.settings.workDays = daysVal;

  updateHeaderCountsAndKPIs();
  calculateAndRenderGoal();

  if (uiState.goalSaveTimeout) clearTimeout(uiState.goalSaveTimeout);
  uiState.goalSaveTimeout = setTimeout(() => {
    saveDataToCloudAndLocal(true);
  }, 600);
}

function calculateAndRenderGoal() {
  const banner = document.getElementById('goalResultBanner');
  const avgHint = document.getElementById('goalCatalogAvgHint');
  if (!banner) return;

  const { avgUnitCost, avgSellPrice } = getCatalogAverages();
  if (avgHint) {
    avgHint.textContent = `Custo médio das receitas: ${formatCurrency(avgUnitCost)} • Preço sugerido médio: ${formatCurrency(avgSellPrice)}`;
  }

  const fixedCost = parseFloat(appData.settings.monthlyFixed) || 0;
  const targetPrice = parseFloat(appData.settings.targetPrice) > 0
    ? parseFloat(appData.settings.targetPrice)
    : avgSellPrice;
  const workDays = parseInt(appData.settings.workDays, 10) > 0 ? parseInt(appData.settings.workDays, 10) : 26;

  if (fixedCost <= 0 || targetPrice <= 0) {
    banner.innerHTML = `
      <div class="goal-banner warning">
        <div>
          <strong>ℹ️ Preencha suas Despesas Fixas Mensais e o Preço de Venda Médio acima</strong>
          <div style="font-size: 0.85rem; margin-top: 0.25rem;">
            O simulador calculará quantas unidades você precisa vender por mês e por dia para pagar todas as contas e repor o estoque.
          </div>
        </div>
      </div>
    `;
    return;
  }

  const profitPerUnit = targetPrice - avgUnitCost;
  if (profitPerUnit <= 0) {
    banner.innerHTML = `
      <div class="goal-banner danger">
        <div>
          <strong>⚠️ Atenção! Preço de venda abaixo do custo médio de produção (${formatCurrency(avgUnitCost)}).</strong>
          <div style="font-size: 0.86rem; margin-top: 0.25rem;">
            Aumente o preço de venda médio (ou clique em "Usar Preço Médio do Catálogo") para ter margem positiva.
          </div>
        </div>
      </div>
    `;
    return;
  }

  const unitsMonth = Math.ceil(fixedCost / profitPerUnit);
  const unitsDay = Math.ceil(unitsMonth / workDays);
  const monthlyRevenue = unitsMonth * targetPrice;

  banner.innerHTML = `
    <div class="goal-banner">
      <div>
        <div style="font-size: 0.85rem; opacity: 0.9; font-weight: 600;">META PARA PAGAR AS CONTAS E REPOR ESTOQUE:</div>
        <div class="goal-big-number">${unitsMonth} unidades / mês</div>
        <div style="font-size: 0.9rem; opacity: 0.95; margin-top: 0.2rem;">
          Equivale a cerca de <strong>${unitsDay} unidades por dia</strong> (em ${workDays} dias trabalhados).
        </div>
      </div>
      <div style="background: rgba(255,255,255,0.14); padding: 0.85rem 1.1rem; border-radius: 10px; min-width: 220px;">
        <div style="font-size: 0.78rem; opacity: 0.85;">Faturamento Bruto no Ponto de Equilíbrio</div>
        <div style="font-size: 1.3rem; font-weight: 800;">${formatCurrency(monthlyRevenue)}</div>
        <div style="font-size: 0.76rem; opacity: 0.85; margin-top: 0.2rem;">
          Lucro médio: ${formatCurrency(profitPerUnit)}/un (Custo médio: ${formatCurrency(avgUnitCost)})
        </div>
      </div>
    </div>
  `;
}

function renderDashboardTable() {
  const tbody = document.getElementById('dashboardTableBody');
  const catFilterSelect = document.getElementById('filterDashboardCategory');
  const searchInput = document.getElementById('searchDashboard');
  if (!tbody) return;

  if (catFilterSelect) {
    const currentVal = catFilterSelect.value || 'all';
    const sortedCats = [...appData.categories].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    let optHtml = `<option value="all">Todas as Categorias</option>`;
    sortedCats.forEach(c => {
      optHtml += `<option value="${escapeHtml(c.id)}" ${String(c.id) === String(currentVal) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`;
    });
    catFilterSelect.innerHTML = optHtml;
  }

  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const selectedCat = catFilterSelect ? catFilterSelect.value : 'all';

  const filtered = appData.recipes
    .filter(r => {
      if (selectedCat !== 'all' && String(r.categoryId) !== String(selectedCat)) return false;
      if (query && !r.name.toLowerCase().includes(query)) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">Nenhuma receita encontrada para este filtro.</td></tr>`;
    return;
  }

  let rowsHtml = '';
  filtered.forEach(recipe => {
    const calc = calculateRecipeCosts(recipe);
    const catName = getCategoryName(recipe.categoryId);

    rowsHtml += `
      <tr>
        <td>
          <strong>${escapeHtml(recipe.name)}</strong>
          ${recipe.isBase ? '<span class="badge badge-subrecipe">🍲 Base</span>' : ''}
        </td>
        <td><span class="badge badge-cat">${escapeHtml(catName)}</span></td>
        <td>${formatNumber(recipe.yield)} ${escapeHtml(recipe.yieldUnit || 'un')}</td>
        <td style="font-weight: 600;">${formatCurrency(calc.totalUnitCost)}</td>
        <td>
          <span style="background: var(--success-bg); color: var(--success); font-weight: 800; padding: 0.25rem 0.55rem; border-radius: 6px;">
            ${formatCurrency(calc.finalUnitPrice)}
          </span>
        </td>
        <td style="color: var(--ifood); font-weight: 700;">${formatCurrency(calc.iFoodPrice)}</td>
        <td style="color: var(--success); font-weight: 700;">${formatCurrency(calc.profitPerUnit)}</td>
        <td><span class="badge badge-unit">${formatNumber(calc.effectiveMarginPercent, 0)}%</span></td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 0.35rem;">
            <button type="button" class="btn btn-outline btn-sm" onclick="openRevealModal('${escapeHtml(recipe.id)}')" title="Ver Ficha Técnica">📄</button>
            <button type="button" class="btn btn-primary btn-sm" onclick="openRecipeModal('${escapeHtml(recipe.id)}')" title="Editar Receita">✏️</button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;
}

// ============================================================================
// 12. ABA 5: OPÇÕES GLOBAIS E GERENCIADOR INLINE DE CATEGORIAS (SEM PROMPT!)
// ============================================================================

function populateGlobalOptionsForm() {
  const s = appData.settings;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? 0;
  };
  setVal('optProfitMargin', s.profitMargin);
  setVal('optUtilityCost', s.utilityCost);
  setVal('optWasteMargin', s.wasteMargin);
  setVal('optIfoodFee', s.ifoodFee);
  setVal('optDebitFee', s.debitFee);
  setVal('optCreditFee', s.creditFee);
}

function saveGlobalOptions(event) {
  if (event) event.preventDefault();

  appData.settings.profitMargin = parseFloat(document.getElementById('optProfitMargin').value) || 0;
  appData.settings.utilityCost = parseFloat(document.getElementById('optUtilityCost').value) || 0;
  appData.settings.wasteMargin = parseFloat(document.getElementById('optWasteMargin').value) || 0;
  appData.settings.ifoodFee = parseFloat(document.getElementById('optIfoodFee').value) || 0;
  appData.settings.debitFee = parseFloat(document.getElementById('optDebitFee').value) || 0;
  appData.settings.creditFee = parseFloat(document.getElementById('optCreditFee').value) || 0;

  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderRecipes(true);
  renderDashboardTable();
  calculateAndRenderGoal();

  showToast('⚙️ Configurações globais salvas e aplicadas a todas as receitas!', 'success');
}

function handleCreateCategory(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('newCategoryNameInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  appData.categories.push({ id: generateId(), name });
  input.value = '';
  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderRecipeCategoryPills();
  renderCategoriesManager();
  renderRecipes(true);
  showToast(`🏷️ Categoria "${name}" criada com sucesso!`, 'success');
}

function inlineUpdateCategoryName(catId, newName, inputEl) {
  const cat = appData.categories.find(c => String(c.id) === String(catId));
  if (!cat) return;
  const trimmed = String(newName || '').trim();
  if (!trimmed || trimmed === cat.name) {
    if (inputEl) inputEl.value = cat.name;
    return;
  }

  cat.name = trimmed;
  if (inputEl) {
    inputEl.classList.add('saved-flash');
    setTimeout(() => inputEl.classList.remove('saved-flash'), 900);
  }

  saveDataToCloudAndLocal(true);
  renderRecipeCategoryPills();
  renderRecipes(true);
  renderDashboardTable();
  showToast(`🏷️ Categoria renomeada para "${trimmed}"!`, 'success');
}

function deleteCategory(catId) {
  if (appData.categories.length <= 1) {
    showToast('⚠️ O sistema precisa ter pelo menos uma categoria.', 'error');
    return;
  }

  const cat = appData.categories.find(c => String(c.id) === String(catId));
  if (!cat) return;

  const linkedRecipes = appData.recipes.filter(r => String(r.categoryId) === String(catId));
  const msg =
    linkedRecipes.length > 0
      ? `Excluir a categoria "${cat.name}"? As ${linkedRecipes.length} receita(s) dela serão movidas para outra categoria automaticamente.`
      : `Deseja excluir a categoria "${cat.name}"?`;

  if (!confirm(msg)) return;

  appData.categories = appData.categories.filter(c => String(c.id) !== String(catId));
  const fallbackCatId = appData.categories[0].id;
  appData.recipes.forEach(r => {
    if (String(r.categoryId) === String(catId)) {
      r.categoryId = fallbackCatId;
    }
  });

  if (String(uiState.recipeCategoryFilter) === String(catId)) {
    uiState.recipeCategoryFilter = 'all';
  }

  saveDataToCloudAndLocal();
  updateHeaderCountsAndKPIs();
  renderRecipeCategoryPills();
  renderCategoriesManager();
  renderRecipes(true);
  renderDashboardTable();
  showToast(`🗑️ Categoria "${cat.name}" removida.`, 'info');
}

function renderCategoriesManager() {
  const container = document.getElementById('categoriesManagerList');
  if (!container) return;

  const sortedCats = [...appData.categories].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  let html = '';

  sortedCats.forEach(cat => {
    const count = appData.recipes.filter(r => String(r.categoryId) === String(cat.id)).length;
    html += `
      <div class="category-manager-row">
        <span style="font-size: 1rem;">🏷️</span>
        <input
          type="text"
          value="${escapeHtml(cat.name)}"
          title="Altere o nome aqui mesmo e pressione Enter"
          onchange="inlineUpdateCategoryName('${escapeHtml(cat.id)}', this.value, this)"
          onkeydown="if(event.key==='Enter'){this.blur();}"
        />
        <span class="badge badge-unit">${count} ${count === 1 ? 'receita' : 'receitas'}</span>
        <button
          type="button"
          class="btn btn-danger btn-sm"
          onclick="deleteCategory('${escapeHtml(cat.id)}')"
          title="Excluir categoria"
        >🗑️</button>
      </div>
    `;
  });

  container.innerHTML = html;
}

// ============================================================================
// 13. MODAIS DE BACKUP / IMPORTAÇÃO E CONFIGURAÇÃO FIREBASE
// ============================================================================

function openDataModal() {
  document.getElementById('dataModal')?.classList.add('open');
}

function closeDataModal() {
  document.getElementById('dataModal')?.classList.remove('open');
}

function exportBackupJSON() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const jsonStr = JSON.stringify(appData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `backup_doce_calculo_v2_${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  showToast('💾 Arquivo de backup (.JSON) baixado com sucesso!', 'success');
}

function importBackupJSON(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || (!Array.isArray(parsed.ingredients) && !Array.isArray(parsed.recipes))) {
        showToast('⚠️ Arquivo JSON inválido.', 'error');
        return;
      }
      appData = normalizeAppData(parsed);
      saveDataToCloudAndLocal();
      refreshAllViews();
      closeDataModal();
      showToast('✅ Backup restaurado e sincronizado com sucesso!', 'success');
    } catch (err) {
      console.error('Erro ao importar JSON:', err);
      showToast('⚠️ Erro ao ler o arquivo JSON.', 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function openFirebaseModal() {
  const input = document.getElementById('fbStoreDocId');
  if (input) input.value = getActiveDocId();
  updateSyncBadge(
    uiState.firebaseConnected ? 'online' : 'offline',
    document.getElementById('syncStatusText')?.textContent || ''
  );
  document.getElementById('firebaseModal')?.classList.add('open');
}

function closeFirebaseModal() {
  document.getElementById('firebaseModal')?.classList.remove('open');
}

function saveCustomDocId() {
  const input = document.getElementById('fbStoreDocId');
  const raw = input ? input.value.trim() : 'dados_v2';
  if (!raw || raw === 'dados') {
    showToast('⚠️ Por segurança, use um nome diferente de "dados" (ex: dados_v2) para não alterar a versão 1.0.', 'error');
    if (input) input.value = 'dados_v2';
    return;
  }
  localStorage.setItem(STORAGE_KEY_DOC_ID, raw);
  closeFirebaseModal();
  if (fbAuth && fbAuth.currentUser) {
    startFirestoreRealtimeSync();
  }
  showToast(`☁️ Documento de sincronização definido para: empresa/${raw}`, 'success');
}

// ============================================================================
// 14. ATALHOS DE TECLADO GLOBAIS E INICIALIZAÇÃO DOM
// ============================================================================

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('recipeModal')?.classList.contains('open')) {
      closeRecipeModal();
    } else if (document.getElementById('revealModal')?.classList.contains('open')) {
      closeRevealModal();
    } else if (document.getElementById('dataModal')?.classList.contains('open')) {
      closeDataModal();
    } else if (document.getElementById('firebaseModal')?.classList.contains('open')) {
      closeFirebaseModal();
    }
  }
});

window.addEventListener('DOMContentLoaded', () => {
  // 1. Carrega os 61 insumos, 22 embalagens, 10 categorias e 34 receitas imediatamente
  loadInitialLocalData();

  // 2. Inicializa o SDK do Firebase
  const fbReady = initFirebaseSDK();

  // 3. Verifica se o usuário já estava autenticado no Firebase ou com acesso desbloqueado
  const wasUnlocked = localStorage.getItem(STORAGE_KEY_UNLOCKED) === 'true';

  if (fbReady && fbAuth) {
    fbAuth.onAuthStateChanged(user => {
      if (user) {
        unlockAndShowApp();
        startFirestoreRealtimeSync();
      } else if (wasUnlocked) {
        unlockAndShowApp();
        updateSyncBadge('offline', 'Modo Local • 34 Receitas');
      } else {
        const loginScreen = document.getElementById('loginScreen');
        if (loginScreen) loginScreen.style.display = 'flex';
        setTimeout(() => document.getElementById('sharedPasswordInput')?.focus(), 100);
      }
    });
  } else if (wasUnlocked) {
    enterOfflineMode();
  } else {
    const loginScreen = document.getElementById('loginScreen');
    if (loginScreen) loginScreen.style.display = 'flex';
  }
});
