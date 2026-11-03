/* =============================================================
   teste-restlet.js — valida o Restlet do NetSuite (duco-restlet.js)
   -------------------------------------------------------------
   O Restlet roda dentro do NetSuite (define + módulos N/*). Aqui
   injetamos um define() falso e N/* falsos para carregar o MESMO
   arquivo que vai para o NetSuite e testá-lo em Node:

   1) núcleo SHA1 (DUCO-S1A) contra o crypto do Node;
   2) busca de nonce: acha o mesmo nonce do duco-miner.js validado;
   3) roteamento GET/POST: saldo, estatísticas, preço, proxy, ajuda;
   4) mineração fatiada: tempo, retomada por "proximo" e governança;
   5) verificação de nonce e conversão DUCO -> R$.

   Uso:  node restlet/teste-restlet.js
   Requer Node.js 22+ (o NetSuite não é tocado: http é simulado).
   ============================================================= */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
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
// Falsos do SuiteScript: define + N/log, N/http, N/runtime
// =============================================================
const chamadasHttp = [];                 // histórico para asserções de URL

const respostasFalsas = {
  '/balances/duco': { success: true, result: { balance: 123.45, username: 'duco' } },
  '/statistics': { 'Duco price': 0.0000643, 'Current difficulty': 20000 },
  '/users/duco': { success: true, result: { balance: { balance: 123.45 }, miners: [], transactions: [] } },
  '/all_pools': { success: true, result: [{ name: 'magi', url: 'server.duinocoin.com' }] },
  '/statistics2': {},
};

const falsoHttp = {
  get(opcoes) {
    chamadasHttp.push({ metodo: 'GET', url: opcoes.url });
    const caminho = opcoes.url.replace('https://server.duinocoin.com', '').split('?')[0];
    const corpo = respostasFalsas[caminho];
    if (!corpo) return { code: 404, body: JSON.stringify({ success: false, result: 'não encontrado' }) };
    return { code: 200, body: JSON.stringify(corpo) };
  },
  post(opcoes) {
    chamadasHttp.push({ metodo: 'POST', url: opcoes.url, body: opcoes.body });
    return { code: 200, body: JSON.stringify({ success: true, result: 'OK simulado', eco: opcoes.body }) };
  },
};

let unidadesRestantes = 1000000;         // governança simulada
const falsoRuntime = {
  getCurrentScript: () => ({ getRemainingUsage: () => unidadesRestantes }),
};

const falsoLog = { error() {}, debug() {}, audit() {} };

let definiDoRestlet = null;
global.define = (deps, factory) => {
  const mapa = { 'N/log': falsoLog, 'N/http': falsoHttp, 'N/runtime': falsoRuntime };
  definiDoRestlet = factory(...deps.map((d) => mapa[d]));
};

// Carrega o Restlet REAL (o mesmo arquivo enviado ao NetSuite).
require(path.join(__dirname, 'duco-restlet.js'));
assert.ok(definiDoRestlet, 'define() não foi chamado — arquivo inválido');
const restlet = definiDoRestlet;
const { sha1Hex, criarBuscador, palavrasDoHex, minerar, verificar } = restlet._interno;

const sha1Node = (texto) => crypto.createHash('sha1').update(texto, 'latin1').digest('hex');

// =============================================================
// 1) O SHA1 do núcleo é SHA1 de verdade?
// =============================================================
console.log('\n— 1) Núcleo SHA1 contra o crypto do Node —');
ok(sha1Hex('abc') === 'a9993e364706816aba3e25717850c26c9cd0d89d', 'vetor conhecido: SHA1("abc")');
ok(sha1Hex('') === 'da39a3ee5e6b4b0d3255bfef95601890afd80709', 'vetor conhecido: SHA1("")');
ok(sha1Hex('x'.repeat(64)) === sha1Node('x'.repeat(64)), 'mensagem de exatamente 1 bloco (64 bytes)');
ok(sha1Hex('x'.repeat(119)) === sha1Node('x'.repeat(119)), 'mensagem que exige bloco extra de padding (119 bytes)');

let iguais = 0;
for (let i = 0; i < 300; i++) {
  const tamanho = Math.floor(Math.random() * 200);
  const texto = crypto.randomBytes(tamanho).toString('latin1');
  if (sha1Hex(texto) === sha1Node(texto)) iguais++;
}
ok(iguais === 300, `300 mensagens aleatórias (0 a 199 bytes) conferem: ${iguais}/300`);

// =============================================================
// 2) A busca de nonce acha o mesmo nonce do duco-miner.js?
// =============================================================
console.log('\n— 2) Busca de nonce (mesma regra do duco-miner.js) —');
let achados = 0;
for (let i = 0; i < 60; i++) {
  const prefixo = crypto.randomBytes(20).toString('hex');
  const nonceCerto = Math.floor(Math.random() * 500000);
  const hashCerto = sha1Node(prefixo + nonceCerto);
  if (criarBuscador(prefixo).procurar(palavrasDoHex(hashCerto), 0, nonceCerto + 1, { maxMs: 30000 }).nonce === nonceCerto) achados++;
}
ok(achados === 60, `60 jobs gerados aleatoriamente resolvidos: ${achados}/60`);

const exemplo = { prefixo: '8a1d5f0b3c7e9d2a4f6b8c0e1d3f5a7b9c1e3d5f', nonce: 12345 };
exemplo.hash = sha1Node(exemplo.prefixo + exemplo.nonce);
ok(criarBuscador(exemplo.prefixo).procurar(palavrasDoHex(exemplo.hash), 0, 20000, { maxMs: 30000 }).nonce === exemplo.nonce,
  `job de exemplo: nonce ${exemplo.nonce} encontrado (hash ${exemplo.hash.slice(0, 12)}...)`);
ok(criarBuscador(exemplo.prefixo).procurar(palavrasDoHex('0'.repeat(40)), 0, 5000, { maxMs: 5000 }).nonce === -1,
  'hash impossível: devolve -1 (nunca inventa nonce)');
// =============================================================
// 3) Roteamento GET/POST (com N/http simulado)
// =============================================================
console.log('\n— 3) Roteamento do Restlet —');

const ajuda = restlet.get({ acao: 'ajuda' });
ok(ajuda.sucesso === true && Object.keys(ajuda.acoes).length >= 15,
  `ajuda lista ${Object.keys(ajuda.acoes).length} funcionalidades`);

const saldo = restlet.get({ acao: 'saldo', usuario: 'duco' });
ok(saldo.success === true && saldo.result.balance === 123.45,
  'saldo repassa /balances/<usuario> da API oficial');
ok(chamadasHttp.some((c) => c.url === 'https://server.duinocoin.com/balances/duco'),
  'URL do saldo montada corretamente');

const usuario = restlet.get({ acao: 'usuarios', usuario: 'duco', limite: 3 });
ok(usuario.success === true && Array.isArray(usuario.result.miners),
  'usuário completo (saldo + mineradores + transações)');
ok(chamadasHttp.some((c) => c.url === 'https://server.duinocoin.com/users/duco?limit=3'),
  'parâmetro limite vira ?limit=3 no upstream');

const preco = restlet.get({ acao: 'preco' });
ok(preco.sucesso === true && preco.precoUsd === 0.0000643, 'preço extraído de /statistics');

const pools = restlet.get({ acao: 'pools' });
ok(pools.success === true && pools.result[0].name === 'magi', 'pools via /all_pools');

const proxyGet = restlet.get({ acao: 'proxy', caminho: '/statistics', extra: 'x' });
ok(proxyGet['Duco price'] === 0.0000643, 'proxy GET repassa /statistics');
ok(chamadasHttp.some((c) => c.url === 'https://server.duinocoin.com/statistics?extra=x'),
  'proxy GET envia sobras de parâmetros ao upstream (sem acao/caminho)');

const proxyPost = restlet.post({ acao: 'proxy', caminho: '/mining_key', u: 'duco', k: 'NOVA', senha: 's' });
ok(proxyPost.success === true && proxyPost.result === 'OK simulado', 'proxy POST repassa JSON ao upstream');
const chamadaPost = chamadasHttp.find((c) => c.metodo === 'POST');
ok(chamadaPost && JSON.parse(chamadaPost.body).senha === 's',
  'POST envia o corpo JSON como está (parâmetros originais preservados)');
ok(chamadaPost && !('acao' in JSON.parse(chamadaPost.body)) && !('caminho' in JSON.parse(chamadaPost.body)),
  'parâmetros de roteamento não vazam para o upstream');

const erroAcao = restlet.get({ acao: 'inexistente' });
ok(erroAcao.sucesso === false && /ajuda/.test(erroAcao.erro), 'ação desconhecida explica e manda pra ajuda');

const erroSaldo = restlet.get({ acao: 'saldo' });
ok(erroSaldo.sucesso === false && /usuario/.test(erroSaldo.erro), 'saldo sem usuário dá erro claro');

const transferir = restlet.post({
  acao: 'transferir', usuario: 'duco', senha: 's', destinatario: 'outro', valor: '1.5',
});
ok(chamadasHttp.some((c) => c.url.includes('/transaction?username=duco') &&
  c.url.includes('recipient=outro') && c.url.includes('amount=1.5')),
  'transferência monta /transaction com os parâmetros certos');

const semAcao = restlet.post({ lastBlockHash: 'x'.repeat(40) });
ok(semAcao.sucesso === false, 'POST sem ação nem job completo retorna erro explicativo');

// =============================================================
// 4) Mineração: ponta a ponta, fatiamento por tempo e governança
// =============================================================
console.log('\n— 4) Mineração fatiada —');

const r1 = restlet.post({ acao: 'minerar', lastBlockHash: exemplo.prefixo, hashEsperado: exemplo.hash, dificuldade: 200 });
ok(r1.sucesso === true && r1.encontrado === true && r1.nonce === exemplo.nonce,
  `POST acao=minerar achou o nonce ${r1.nonce} (limite ${r1.limite})`);
ok(r1.hash === exemplo.hash, 'hash devolvido bate com o esperado');
ok(r1.hashrate > 0 && r1.testados === exemplo.nonce + 1, `hashrate ${r1.hashrate} H/s | testados ${r1.testados}`);
// Fatiamento: maxMs minúsculo força "esgotado: tempo" e devolve "proximo"
const prefixoLongo = crypto.randomBytes(20).toString('hex');
const nonceLongo = 700000;
const hashLongo = sha1Node(prefixoLongo + nonceLongo);
let inicio = 0;
let fatias = 0;
let achou = null;
while (fatias < 400) {
  const r = minerar({
    lastBlockHash: prefixoLongo, hashEsperado: hashLongo, dificuldade: 10000,
    inicio, maxMs: 30,
  });
  fatias++;
  if (r.encontrado) { achou = r; break; }
  if (r.esgotado === 'nonce') break;          // varreu tudo sem achar
  if (r.proximo <= inicio) break;             // não dá loop infinito se falhar
  inicio = r.proximo;
}
ok(achou !== null && achou.nonce === nonceLongo,
  `busca fatiada (${fatias} chamada(s) de 30 ms) achou o nonce ${nonceLongo}`);
ok(fatias > 1, `fatiamento funcionou de verdade (${fatias} chamadas)`);

// Governança: unidades acabando -> esgotado 'unidades'
unidadesRestantes = 10;
const rg = minerar({
  lastBlockHash: exemplo.prefixo, hashEsperado: exemplo.hash, dificuldade: 10000, maxMs: 30000,
});
unidadesRestantes = 1000000;
ok(rg.sucesso === true && rg.encontrado === false && rg.esgotado === 'unidades' && rg.proximo >= 0,
  'governança baixa interrompe a busca e devolve "proximo" para retomar');

const rErro = minerar({ lastBlockHash: 'curto', hashEsperado: exemplo.hash, dificuldade: 100 });
ok(rErro.sucesso === false && /lastBlockHash/.test(rErro.erro), 'job com lastBlockHash inválido é recusado');

const rDiff = minerar({ lastBlockHash: exemplo.prefixo, hashEsperado: exemplo.hash, dificuldade: 'abc' });
ok(rDiff.sucesso === false && /dificuldade/.test(rDiff.erro), 'dificuldade inválida é recusada');

// =============================================================
// 5) Verificação de nonce e conversão
// =============================================================
console.log('\n— 5) Verificação e conversão —');

const v = verificar({ lastBlockHash: exemplo.prefixo, hashEsperado: exemplo.hash, nonce: String(exemplo.nonce) });
ok(v.sucesso === true && v.valido === true, 'nonce certo é validado');

const vErrado = verificar({ lastBlockHash: exemplo.prefixo, hashEsperado: exemplo.hash, nonce: '999' });
ok(vErrado.sucesso === true && vErrado.valido === false, 'nonce errado é reprovado');

const getVerifica = restlet.get({
  acao: 'verificar', lastBlockHash: exemplo.prefixo, hashEsperado: exemplo.hash, nonce: String(exemplo.nonce),
});
ok(getVerifica.valido === true, 'GET acao=verificar funciona via roteamento');

const c = restlet.get({ acao: 'converter', duco: 1000, preco: 0.0000643, cambio: 5.1966, taxa: 3 });
ok(c.sucesso === true && Math.abs(c.brutoUsd - 0.0643) < 1e-12, 'bruto em US$ confere');
ok(Math.abs(c.liquidoUsd - 0.0643 * 0.97) < 1e-12, 'líquido após taxa de 3% confere');
ok(Math.abs(c.liquidoBrl - (0.0643 * 0.97) * 5.1966) < 1e-9, 'conversão para R$ confere');

const cErro = restlet.get({ acao: 'converter', duco: 1, preco: 1, cambio: 1, taxa: 200 });
ok(cErro.sucesso === false && /taxa/.test(cErro.erro), 'taxa acima de 100% é recusada');

// =============================================================
console.log(`\n${falhas === 0 ? '✅' : '❌'} ${provas - falhas}/${provas} verificações passaram — ${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);


