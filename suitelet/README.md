# Suitelet do NetSuite — Duino-Coin híbrido (nuvem + TCP no navegador)

Um **Suitelet** (SuiteScript 2.1) que faz a **divisão de responsabilidades** ideal para
minerar DUCO a partir do NetSuite:

```
suitelet/
├── duco-suitelet.js  ← Suitelet: serve a página Bootstrap/jQuery + processa o nonce
├── teste-suitelet.js ← teste em Node (SHA1 + página + mineração + paralelização)
└── README.md         ← este arquivo
```

## A arquitetura (por que Suitelet e não Restlet)

O SuiteScript **não abre WebSocket nem socket TCP**. Então a mineração DUCO é dividida:

| Peça | Onde roda | O que faz |
|---|---|---|
| **Parte TCP** | 🌐 **navegador** | Abre `wss://magi.duinocoin.com:8443`, pede o job (`JOB,...`) e **submete** o share (`GOOD`/`BAD`) |
| **Processamento do nonce** | ☁️ **NetSuite (Suitelet)** | Recebe o job por `POST acao=minerar`, resolve o nonce (DUCO-S1A) e devolve `{ nonce, hash, hashrate }` |
| **Página** | ☁️ **NetSuite (Suitelet)** | `GET /` serve HTML com **Bootstrap + jQuery** que orquestra tudo |

O **Restlet** não serve essa arquitetura porque só fala JSON — não entrega HTML. O **Suitelet**
serve a página *e* processa o nonce, por isso é a escolha certa aqui.

## Publicar no NetSuite

1. **Customization → Script → New → Script**:
   - *Type*: **Suitelet**
   - *ID*: `_duco_suitelet` (gera `customscript_duco_suitelet`)
   - Cole o conteúdo de `duco-suitelet.js`. As diretivas no topo definem o tipo:
     `@NApiVersion 2.1` e `@NScriptType Suitelet`. O arquivo usa o estilo nativo do 2.1
     (`import * as … from 'N/…'` e `export { onRequest, _interno }`).
2. **Save** → **Deploy Script** (New Deployment) escolhendo role/subsidiary.
3. Copie a **External URL** do deployment e abra no navegador — a página aparece.

## Testes (Node 22+)

```bash
node suitelet/teste-suitelet.js   # 23 verificações: SHA1, página, mineração, paralelização
```

O teste carrega o **mesmo** `duco-suitelet.js` (SuiteScript 2.1, ES modules): ele troca os
`import` por módulos `N/*` falsos, avalia num escopo controlado e usa um `context` de Suitelet
falso — não toca no NetSuite. Valida o SHA1 contra o `crypto` do Node,
confere que a página servida contém Bootstrap/jQuery/WebSocket, resolve o nonce via
`POST acao=minerar`, exercita a **paralelização** (12 POSTs independentes), o roteamento JSON
e o fatiamento por tempo/governança.

## Ações

| Método | Ação | O que faz |
|---|---|---|
| GET | `/` (sem ação) | serve a **página** (Bootstrap + jQuery + WebSocket no cliente) |
| POST | `acao=minerar` | **resolve o nonce na nuvem** e devolve `{ nonce, hash, hashrate, proximo }` |
| GET | `acao=saldo&usuario=X` | saldo (`/balances/X`) |
| GET | `acao=estatisticas` | estatísticas (`/statistics`) |
| GET | `acao=preco` | preço do DUCO em US$ |
| GET | `acao=verificar&lastBlockHash&hashEsperado&nonce` | valida um nonce (local) |
| GET | `acao=converter&duco&preco&cambio&taxa` | DUCO → US$ → R$ (local) |
| GET/POST | `acao=proxy&caminho=/statistics` | proxy genérico da API oficial |

### Exemplo: resolver um nonce na nuvem

```bash
curl -X POST "https://CONTA.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=ID&deploy=ID" \
  -H "Content-Type: application/json" \
  -d '{"acao":"minerar","lastBlockHash":"8a1d...","hashEsperado":"05ca...","dificuldade":200,"maxMs":2000}'
# -> { "sucesso": true, "encontrado": true, "nonce": 12345, "hash": "05ca...", "hashrate": ... }
```

Se `encontrado` for `false` e `esgotado` for `"tempo"` ou `"unidades"`, repita com
`"inicio": <proximo>` para retomar de onde parou (fatiamento).

## Paralelização e limites (leia antes de escalar)

- **No navegador**: o campo *Trabalhadores* abre N conexões WebSocket; cada uma pede job e
  dispara seu próprio `POST acao=minerar` ao Suitelet. É aí que entra o paralelismo.
- **Concorrência do NetSuite**: cada `POST` é uma requisição de RESTlet/Suitelet e conta no
  limite de **concorrência da conta** (~5 base, até 20+ por service tier/licença). Passou
  disso, as requisições excedentes voltam com erro — convém limitar os trabalhadores.
- **Governança do Suitelet**: teto de **5.000 usage units** e **300 s** por execução. A busca
  é fatiada por `maxMs` (padrão 2 s, teto 5 s) e por unidades restantes, devolvendo `proximo`.
- **O Kolka pune hashrate alto**: o DUCO-S1A num data center não rende mais que um Arduino —
  farms são desincentivados de propósito. Isto é um projeto **didático**.

> ⚠️ **Termos de Uso do DUCO**: uma conta só, sem VPN, sem VPS grátis. O minerador oficial
> continua sendo o recomendado para valer a pena.
