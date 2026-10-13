// ============================================================================
// CONFIGURAÇÃO DO FIREBASE — DOCE CÁLCULO 2.0 (EVOLUÇÃO GELACOST PRO)
// ============================================================================
// Conectado ao mesmo projeto Firebase do GelaCost PRO, porém salvando em um
// documento separado ("empresa/dados_v2") para NÃO alterar o sistema antigo ("empresa/dados").

window.DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDbpIzamb8kg9YLiz1__bSSKiLZN_DUBQU",
  authDomain: "calculadora-receitas-8c12e.firebaseapp.com",
  projectId: "calculadora-receitas-8c12e",
  storageBucket: "calculadora-receitas-8c12e.firebasestorage.app",
  messagingSenderId: "669197951172",
  appId: "1:669197951172:web:7c992b6a5cc9d2d6776991"
};

// E-mail compartilhado para autenticação por senha da equipe (Firebase Auth)
window.SHARED_AUTH_EMAIL = "acesso@gelacost.com";

// Coleção e documentos no Firestore:
// - FIRESTORE_DOC_V2: Documento exclusivo da versão 2.0 (isolado e seguro)
// - FIRESTORE_DOC_LEGACY: Documento original do GelaCost PRO (usado apenas para leitura/importação)
window.FIRESTORE_COLLECTION = "empresa";
window.FIRESTORE_DOC_V2 = "dados_v2";
window.FIRESTORE_DOC_LEGACY = "dados";
