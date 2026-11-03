/* =============================================================
   teste-suitelet.js — valida o Suitelet do NetSuite (duco-suitelet.js)
   -------------------------------------------------------------
   O Suitelet é SuiteScript 2.1 (ES modules: import/export). Aqui lemos o
   fonte, trocamos os imports por módulos N/* falsos e avaliamos num escopo
   controlado, com um context de Suitelet falso (request/response):

    1) núcleo SHA1 (DUCO-S1A) contra o crypto do Node;
    2) busca de nonce (mesma regra do minerador oficial);
    3) onRequest GET sem ação -> serve a página HTML (Bootstrap+jQuery+WS);
    4) onRequest POST acao=minerar -> resolve o nonce (nuvem);
    5) PARALELIZAÇÃO: vários POSTs acao=minerar independentes;
    6) roteamento JSON: saldo, preço, verificar, converter, ajuda;
    7) fatiamento por maxMs e governança (esgotado + proximo).

   Uso:  node suitelet/teste-suitelet.js   (Node 22+; NetSuite não é tocado)
   ============================================================= */
'use strict';

const crypto = require('crypto');
const path = require('path');
const assert = require('assert');

let falhas = 0;
let provas = 0;
function ok(condicao, texto) {
  provas++;
  if (condicao) { console.log(`✅ ${texto}`); return true; }
  falhas++;
  console.log(`❌ ${texto}`);
  return false;
}

// =============================================================
// Falsos do SuiteScript: define + N/log, N/http, N/runtime, N/file
// =============================================================
const respostasFalsas = {
  '/balances/duco': { success: true, result: { balance: 123.45, username: 'duco' } },
  '/statistics': { 'Duco price': 0.0000643, 'Current difficulty': 20000 },
};

const falsoHttp = {
  get(opcoes) {
    const caminho = opcoes.url.replace('https://server.duinocoin.com', '').split('?')[0];
    const corpo = respostasFalsas[caminho];
    if (!corpo) return { code: 404, body: JSON.stringify({ success: false }) };
    return { code: 200, body: JSON.stringify(corpo) };
  },
  post() { return { code: 200, body: JSON.stringify({ success: true, result: 'OK' }) }; },
};

let unidadesRestantes = 1000000;
const falsoRuntime = { getCurrentScript: () => ({ getRemainingUsage: () => unidadesRestantes }) };
const falsoFile = { load: () => ({ getContents: () => '' }) };
const falsoLog = { error() {}, debug() {}, audit() {} };

// O Suitelet agora é SuiteScript 2.1 (ES modules: import/export). Para testar
// em Node CommonJS, lemos o fonte e transformamos:
//   import * as X from 'N/...'  ->  const X = __mocks['N/...'];
//   export { a, b }             ->  module.exports = { a, b };
// e avaliamos num escopo controlado com os módulos N/* falsos.
const fs = require('fs');
const mocks = {
  'N/log': falsoLog, 'N/http': falsoHttp,
  'N/runtime': falsoRuntime, 'N/file': falsoFile,
};

let fonte = fs.readFileSync(path.join(__dirname, 'duco-suitelet.js'), 'utf8');
assert.ok(/@NApiVersion 2\.1/.test(fonte), 'o Suitelet deveria declarar @NApiVersion 2.1');
assert.ok(/@NScriptType Suitelet/i.test(fonte), 'o Suitelet deveria declarar @NScriptType Suitelet');

fonte = fonte
  .replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)';?\s*$/gm,
    (m, nome, mod) => `const ${nome} = __mocks[${JSON.stringify(mod)}];`)
  .replace(/^export\s*\{([^}]+)\};?\s*$/gm,
    (m, nomes) => `module.exports = { ${nomes} };`);

const moduleObj = { exports: {} };
const carregar = new Function('__mocks', 'module', 'exports', fonte);
carregar(mocks, moduleObj, moduleObj.exports);

const suitelet = moduleObj.exports;
assert.ok(suitelet && typeof suitelet.onRequest === 'function', 'onRequest não foi exportado');
const { sha1Hex, criarBuscador, palavrasDoHex } = suitelet._interno;
const sha1Node = (t) => crypto.createHash('sha1').update(t, 'latin1').digest('hex');

// context de Suitelet falso: captura o que onRequest escreve.
function contexto(metodo, params, corpo) {
  const capturado = { cabecalhos: {}, corpo: '' };
  return {
    request: { method: metodo, parameters: params || {}, body: corpo },
    response: {
      setHeader: (h) => { capturado.cabecalhos[h.name] = h.value; },
      write: (s) => { capturado.corpo += s; },
    },
    capturado,
  };
}

// =============================================================
// 1) SHA1 contra o crypto do Node
// =============================================================
console.log('\n— 1) Núcleo SHA1 contra o crypto do Node —');
ok(sha1Hex('abc') === 'a9993e364706816aba3e25717850c26c9cd0d89d', 'vetor conhecido: SHA1("abc")');
ok(sha1Hex('') === 'da39a3ee5e6b4b0d3255bfef95601890afd80709', 'vetor conhecido: SHA1("")');
let iguais = 0;
for (let i = 0; i < 300; i++) {
  const t = crypto.randomBytes(Math.floor(Math.random() * 200)).toString('latin1');
  if (sha1Hex(t) === sha1Node(t)) iguais++;
}
ok(iguais === 300, `300 mensagens aleatórias conferem: ${iguais}/300`);

// =============================================================
// 2) Busca de nonce
// =============================================================
console.log('\n— 2) Busca de nonce —');
const exPrefixo = '8a1d5f0b3c7e9d2a4f6b8c0e1d3f5a7b9c1e3d5f';
const exNonce = 12345;
const exHash = sha1Node(exPrefixo + exNonce);
ok(criarBuscador(exPrefixo).procurar(palavrasDoHex(exHash), 0, 20000, { maxMs: 30000 }).nonce === exNonce,
  'nonce do exemplo encontrado');
ok(criarBuscador(exPrefixo).procurar(palavrasDoHex('0'.repeat(40)), 0, 5000, { maxMs: 5000 }).nonce === -1,
  'hash impossível devolve -1');

// =============================================================
// 3) GET sem ação -> serve a página HTML
// =============================================================
console.log('\n— 3) Suitelet serve a página (Bootstrap + jQuery + WebSocket) —');
const ctxPag = contexto('GET', {});
suitelet.onRequest(ctxPag);
const html = ctxPag.capturado.corpo;
ok(/text\/html/.test(ctxPag.capturado.cabecalhos['Content-Type'] || ''), 'Content-Type é text/html');
ok(html.indexOf('bootstrap') >= 0, 'página inclui Bootstrap');
ok(html.indexOf('jquery') >= 0, 'página inclui jQuery');
ok(html.indexOf('wss://magi.duinocoin.com:8443') >= 0, 'página aponta pro gateway WebSocket do DUCO');
ok(html.indexOf('new WebSocket') >= 0, 'página cria WebSocket no navegador (parte TCP)');
ok(html.indexOf('minerar') >= 0, 'página chama acao=minerar na nuvem');
ok(html.indexOf('</html>') >= 0, 'HTML está completo/fechado');

// =============================================================
// 4) POST acao=minerar -> resolve na nuvem
// =============================================================
console.log('\n— 4) Mineração na nuvem (POST acao=minerar) —');
const ctxMin = contexto('POST', {}, JSON.stringify({
  acao: 'minerar', lastBlockHash: exPrefixo, hashEsperado: exHash, dificuldade: 200,
}));
suitelet.onRequest(ctxMin);
const r1 = JSON.parse(ctxMin.capturado.corpo);
ok(/application\/json/.test(ctxMin.capturado.cabecalhos['Content-Type'] || ''), 'POST responde JSON');
ok(r1.sucesso === true && r1.encontrado === true && r1.nonce === exNonce, 'nuvem achou o nonce do exemplo');
ok(r1.hash === exHash, 'hash devolvido bate com o esperado');

// =============================================================
// 5) Paralelização: vários POSTs independentes (jobs diferentes)
// =============================================================
console.log('\n— 5) Paralelização —');
let paralelosOk = 0;
const total = 12;
for (let i = 0; i < total; i++) {
  const pfx = crypto.randomBytes(20).toString('hex');
  const nn = Math.floor(Math.random() * 40000);
  const c = contexto('POST', {}, JSON.stringify({
    acao: 'minerar', lastBlockHash: pfx, hashEsperado: sha1Node(pfx + nn),
    dificuldade: 500, maxMs: 5000,
  }));
  suitelet.onRequest(c);
  const r = JSON.parse(c.capturado.corpo);
  if (r.sucesso && r.encontrado && r.nonce === nn) paralelosOk++;
}
ok(paralelosOk === total, `${total} POSTs independentes resolvidos: ${paralelosOk}/${total}`);

// =============================================================
// 6) Roteamento JSON (saldo, preço, verificar, converter, ajuda)
// =============================================================
console.log('\n— 6) Roteamento JSON —');
const cSaldo = contexto('GET', { acao: 'saldo', usuario: 'duco' });
suitelet.onRequest(cSaldo);
ok(JSON.parse(cSaldo.capturado.corpo).result.balance === 123.45, 'saldo via proxy /balances/duco');

const cPreco = contexto('GET', { acao: 'preco' });
suitelet.onRequest(cPreco);
ok(JSON.parse(cPreco.capturado.corpo).precoUsd === 0.0000643, 'preço extraído de /statistics');

const cVer = contexto('GET', { acao: 'verificar', lastBlockHash: exPrefixo, hashEsperado: exHash, nonce: String(exNonce) });
suitelet.onRequest(cVer);
ok(JSON.parse(cVer.capturado.corpo).valido === true, 'verificar aprova o nonce certo');

const cConv = contexto('GET', { acao: 'converter', duco: 1000, preco: 0.0000643, cambio: 5.1966, taxa: 3 });
suitelet.onRequest(cConv);
ok(Math.abs(JSON.parse(cConv.capturado.corpo).liquidoBrl - (0.0643 * 0.97) * 5.1966) < 1e-9, 'conversão DUCO->R$ confere');

const cAjuda = contexto('GET', { acao: 'ajuda' });
suitelet.onRequest(cAjuda);
ok(JSON.parse(cAjuda.capturado.corpo).sucesso === true, 'ajuda responde');

// =============================================================
// 7) Fatiamento por maxMs e governança
// =============================================================
console.log('\n— 7) Fatiamento e governança —');
const pfxLongo = crypto.randomBytes(20).toString('hex');
const nnLongo = 700000;
const hashLongo = sha1Node(pfxLongo + nnLongo);
let inicio = 0, achou = null, fatias = 0;
while (fatias < 500) {
  const c = contexto('POST', {}, JSON.stringify({
    acao: 'minerar', lastBlockHash: pfxLongo, hashEsperado: hashLongo,
    dificuldade: 10000, inicio, maxMs: 30,
  }));
  suitelet.onRequest(c);
  const r = JSON.parse(c.capturado.corpo);
  fatias++;
  if (r.encontrado) { achou = r; break; }
  if (r.esgotado === 'nonce' || r.proximo <= inicio) break;
  inicio = r.proximo;
}
ok(achou && achou.nonce === nnLongo, `busca fatiada (${fatias} chamadas) achou o nonce ${nnLongo}`);

unidadesRestantes = 10;
const cGov = contexto('POST', {}, JSON.stringify({
  acao: 'minerar', lastBlockHash: exPrefixo, hashEsperado: exHash, dificuldade: 10000, maxMs: 5000,
}));
suitelet.onRequest(cGov);
const rGov = JSON.parse(cGov.capturado.corpo);
unidadesRestantes = 1000000;
ok(rGov.sucesso === true && rGov.encontrado === false && rGov.esgotado === 'unidades',
  'governança baixa interrompe e devolve "proximo"');

console.log(`\n${falhas === 0 ? '✅' : '❌'} ${provas - falhas}/${provas} verificações passaram — ${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
