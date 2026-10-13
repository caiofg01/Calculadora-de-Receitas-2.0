# 🧁 Doce Cálculo 2.0 — Precificação de Receitas para Loja de Doces

Aplicação web completa e de fácil uso para cadastro de ingredientes, embalagens, controle de gastos mensais (MEI e custos fixos), fichas técnicas de receitas e cálculo automático de preços de venda com sincronização em tempo real pelo **Firebase Firestore** (banco único compartilhado, sem necessidade de login).

---

## 🚀 Como Abrir e Usar

1. **No seu computador**: Basta dar dois cliques no arquivo [`index.html`](file:///c:/Users/ResTIC55/Desktop/Calculadora%20de%20receitas%202.0/index.html) para abrir direto no seu navegador (Chrome, Edge, etc.).
2. **Para compartilhar o acesso na internet com toda a loja**:
   - Você pode hospedar gratuitamente estes 4 arquivos (`index.html`, `styles.css`, `app.js`, `firebase-config.js`) no **Firebase Hosting**, **Netlify** (arrastando a pasta no site `app.netlify.com/drop`) ou **Vercel**.

---

## ☁️ Como Conectar o Banco de Dados Único no Firebase (Sem Login)

O sistema já funciona imediatamente salvando seus dados localmente e permite conectar ao **Firebase Firestore** para que todos os celulares e computadores da sua loja vejam e editem os mesmos dados em tempo real:

1. Acesse [console.firebase.google.com](https://console.firebase.google.com/) e clique em **Criar um projeto**.
2. Na tela inicial do projeto, clique no ícone Web **`</>`**, dê um nome (ex: `Loja de Doces`) e copie o bloco `firebaseConfig`.
3. No menu lateral do Firebase, acesse **Criação → Firestore Database → Criar banco de dados**.
4. Escolha **Iniciar no modo de teste** (ou, na aba *Regras*, mantenha `allow read, write: if true;` para que toda a equipe acesse sem precisar de login).
5. Abra a aplicação e clique no botão **"☁️ Conectar Firebase"** no canto superior direito (ou cole as credenciais diretamente dentro do arquivo [`firebase-config.js`](file:///c:/Users/ResTIC55/Desktop/Calculadora%20de%20receitas%202.0/firebase-config.js)).

---

## ✨ Funcionalidades Incluídas

- **🥣 Cadastro de Ingredientes**:
  - Suporte a **Unidades (`un`)**, **Litros (`L`)**, **Mililitros (`ml`)**, **Quilogramas (`kg`)** e **Gramas (`g`)**.
  - Conversão automática inteligente: cadastre um pacote em `kg` ou `L` e use em `g` ou `ml` na receita sem precisar fazer contas manuais.
  - Sempre que o preço de um ingrediente mudar, **todas as receitas são recalculadas automaticamente**.
- **🎁 Cadastro de Embalagens**:
  - Controle de forminhas, caixas, potes, fitas, sacolas e adesivos com cálculo automático do custo unitário.
- **📊 Gastos Mensais Fixos (MEI) & Taxas**:
  - Cadastre a taxa **DAS do MEI**, internet, energia fixa e outros gastos mensais.
  - Diluição automática (rateio) por unidade vendida no mês.
  - Configuração de **Custos Invisíveis (%)** (gás, luz, água, detergente), **Margem de Lucro / Markup (%)** e **Taxas de Venda** (Cartão de Débito, Cartão de Crédito e iFood/Delivery).
- **🍰 Receitas & Ficha Técnica ("Revelar" e Editar)**:
  - Crie receitas informando o rendimento, ingredientes e embalagens com **prévia do preço e lucro em tempo real**.
  - Botão **👁️ Revelar / Ficha Técnica** mostra o detalhamento completo de custos, gráfico de composição do preço, preços sugeridos para **Pix/Dinheiro, Débito, Crédito e iFood**, além de opção para **Imprimir / Salvar PDF**.
