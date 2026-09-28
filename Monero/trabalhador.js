/* ============================================================================
 * trabalhador.js — Monero: Web Worker que minera RandomX no navegador
 *
 * É o "nervo" do minerador (mesmo desenho do trabalhador.js do Duino-Coin):
 *   1) valida o endereço XMR localmente (base58 + keccak-256 + pontos ed25519);
 *   2) fala stratum com o pool via WebSocket (a ponte repassa para o TCP);
 *   3) minera RandomX em WebAssembly (modo luz: cache de 256 MB);
 *   4) compara o hash com o alvo e envia os shares.
 *
 * Por que WebAssembly? O RandomX só tem implementações nativas (C/Rust) — o
 * navegador não roda código nativo. A lib vendored (randomx-web.js, licença
 * BSD-3 de tevador + l-m) compila o RandomX original para WASM e usa o modo
 * "luz" (light mode). É bem mais lento que o xmrig nativo, mas é o que dá para
 * rodar dentro de uma página.
 *
 * Protocolo stratum (JSON-RPC 2.0 sobre TCP, uma mensagem por linha):
 *   → login   {"method":"login","params":{"login":"<endereço>","pass":"x","agent":"..."}}
 *   ← job     {"result":{"id":"<sessão>","job":{...}},"error":null}
 *   ← push    {"method":"job","params":{...}}          (chega job novo a cada bloco)
 *   → submit  {"method":"submit","params":{"job_id":"...","nonce":"...","result":"..."}}
 *   ← resposta {"id":"<n>","result":{"status":"OK"},"error":null}
 *   → keepalived {"method":"keepalived","params":{"id":"<sessão>"}}   (a cada 60 s)
 *
 * Regra do alvo (validada contra share real aceito pelo MoneroOcean):
 *   o hash e o alvo são lidos como inteiro de 256 bits em little-endian e
 *   vale quando  hash < (alvo << (256 - 8*tamanho_do_alvo)).
 *
 * Posição do nonce no blob (validada contra share real):
 *   major_version (varint) + minor_version (varint) + timestamp (varint)
 *   + prev_id (32 bytes)  →  o nonce são os 4 bytes seguintes (39 no blob atual),
 *   escrito em little-endian (os mesmos bytes vão no campo "nonce" do submit).
 *
 * Roda no navegador (Worker) e também no Node (usado pelo teste-monero.js):
 * no Node, o require('./randomx-web.js') carrega a lib no escopo global.
 * ==========================================================================*/
'use strict';

const contexto = typeof self !== 'undefined' ? self : globalThis;

// Carrega o RandomX (WASM). No Worker é importScripts; no Node (teste) é require.
// A lib vendored expõe tudo em globalThis.RandomX (ela faz isso no último trecho).
if (typeof importScripts === 'function') {
  importScripts('randomx-web.js');
} else if (typeof require === 'function') {
  require('./randomx-web.js');
}

function apiRandomX() {
  const api = contexto.RandomX;
  if (!api || typeof api.randomx_init_cache !== 'function' || typeof api.randomx_create_vm !== 'function') {
    throw new Error('randomx-web.js não carregou (globalThis.RandomX ausente)');
  }
  return api;
}

const postar = (obj) => contexto.postMessage(obj);
const agora = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// =============================================================
// FERRAMENTAS (bytes / hex)
// =============================================================
function bytesParaHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function hexParaBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

// =============================================================
// KECCAK-256 (usado no checksum do endereço do Monero)
// Implementação própria com BigInt (mesma que usamos nas sondagens e
// validada contra os vetores conhecidos: vazio, "abc", ...).
// =============================================================
const MASCARA64 = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Deslocamentos do rho em [y][x]
const KECCAK_RHO = [
  [0, 1, 62, 28, 27],
  [36, 44, 6, 55, 20],
  [3, 10, 43, 25, 39],
  [41, 45, 15, 21, 8],
  [18, 2, 61, 56, 14],
];
const rodar = (v, n) => ((v << n) | (v >> (64n - n))) & MASCARA64;

function keccakF(A) {
  for (let rodada = 0; rodada < 24; rodada++) {
    // theta
    const C = new Array(5);
    const D = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rodar(C[(x + 1) % 5], 1n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D[x];
    // rho + pi
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      B[y + 5 * ((2 * x + 3 * y) % 5)] = rodar(A[x + 5 * y], BigInt(KECCAK_RHO[y][x]));
    }
    // chi
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y]);
    }
    // iota
    A[0] ^= KECCAK_RC[rodada];
  }
}

function keccak256(mensagem) {
  const TAXA = 136;                       // 1088 bits (Keccak-256, não SHA-3)
  const A = new Array(25).fill(0n);
  const bytes = Array.from(mensagem);
  bytes.push(0x01);                        // padding do Keccak original
  while (bytes.length % TAXA !== 0) bytes.push(0x00);
  bytes[bytes.length - 1] |= 0x80;

  for (let off = 0; off < bytes.length; off += TAXA) {
    for (let i = 0; i < TAXA / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(bytes[off + i * 8 + j]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  const saida = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let j = 0; j < 8; j++) { saida[i * 8 + j] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return saida;
}

// =============================================================
// CURVA ED25519 (só o que o endereço precisa: conferir se as chaves
// públicas são pontos de verdade na curva — foi exatamente isso que fez
// o pool rejeitar endereços gerados com bytes aleatórios nas sondagens)
// =============================================================
const P_ED25519 = (1n << 255n) - 19n;

function modpow(base, expoente, modulo) {
  let r = 1n;
  base %= modulo;
  while (expoente > 0n) {
    if (expoente & 1n) r = (r * base) % modulo;
    base = (base * base) % modulo;
    expoente >>= 1n;
  }
  return r;
}
const D_ED25519 = ((P_ED25519 - 121665n) * modpow(121666n, P_ED25519 - 2n, P_ED25519)) % P_ED25519;
const RAIZ_DE_MENOS_1 = modpow(2n, (P_ED25519 - 1n) / 4n, P_ED25519);

// Descomprime y e confere a existência do x (curve25519: -x² + y² = 1 + d·x²·y²)
function pontoValido(chave) {
  if (!chave || chave.length !== 32) return false;
  let valor = 0n;
  for (let i = 31; i >= 0; i--) valor = (valor << 8n) | BigInt(chave[i]);
  const sinal = valor >> 255n;
  const y = valor & ((1n << 255n) - 1n);
  if (y >= P_ED25519) return false;

  const y2 = (y * y) % P_ED25519;
  const v = (D_ED25519 * y2 + 1n) % P_ED25519;
  const rhs = (((y2 - 1n + P_ED25519) % P_ED25519) * modpow(v, P_ED25519 - 2n, P_ED25519)) % P_ED25519;

  let x = modpow(rhs, (P_ED25519 + 3n) / 8n, P_ED25519);
  if ((x * x) % P_ED25519 !== rhs) {
    x = (x * RAIZ_DE_MENOS_1) % P_ED25519;
    if ((x * x) % P_ED25519 !== rhs) return false;   // não existe x: ponto inválido
  }
  if (x === 0n && sinal === 1n) return false;
  return true;
}

// =============================================================
// ENDEREÇO DO MONERO (base58 por blocos + checksum keccak-256 + pontos)
// =============================================================
const ALFABETO_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TAM_BLOCO_B58 = { 0: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8 };
const PREFIXOS_ACEITOS = [0x12, 0x2a];    // 0x12 = carteira padrão; 0x2a = subendereço

function decodificarBase58(texto) {
  if (typeof texto !== 'string' || texto.length === 0) return null;
  const saida = [];
  for (let i = 0; i < texto.length; i += 11) {
    const bloco = texto.slice(i, i + 11);
    const tam = TAM_BLOCO_B58[bloco.length];
    if (tam === undefined) return null;
    let num = 0n;
    for (let k = 0; k < bloco.length; k++) {
      const digito = ALFABETO_B58.indexOf(bloco[k]);
      if (digito < 0) return null;
      num = num * 58n + BigInt(digito);
    }
    if (num >= (1n << BigInt(8 * tam))) return null;   // bloco estourou os bytes disponíveis
    const bytes = new Array(tam);
    for (let j = tam - 1; j >= 0; j--) { bytes[j] = Number(num & 0xffn); num >>= 8n; }
    for (const b of bytes) saida.push(b);
  }
  return Uint8Array.from(saida);
}

// Devolve { ok, motivo } — o motivo aparece no log do painel se der errado
function analisarEndereco(endereco) {
  const bruto = decodificarBase58(String(endereco || '').trim());
  if (!bruto || bruto.length !== 69) {
    return { ok: false, motivo: 'não é um endereço Monero de 95 caracteres (base58 de 69 bytes)' };
  }
  if (bruto[0] === 0x13) {
    return { ok: false, motivo: 'é um endereço integrado (começa com 9): os pools não aceitam para pagamento' };
  }
  if (!PREFIXOS_ACEITOS.includes(bruto[0])) {
    return { ok: false, motivo: `prefixo de rede 0x${bruto[0].toString(16)} desconhecido (esperado 0x12)` };
  }
  const conferencia = keccak256(bruto.subarray(0, 65));
  for (let i = 0; i < 4; i++) {
    if (bruto[65 + i] !== conferencia[i]) {
      return { ok: false, motivo: 'checksum (keccak-256) não confere — endereço digitado/copiado errado' };
    }
  }
  if (!pontoValido(bruto.subarray(1, 33))) {
    return { ok: false, motivo: 'a chave pública de gasto não é ponto válido na curva ed25519' };
  }
  if (!pontoValido(bruto.subarray(33, 65))) {
    return { ok: false, motivo: 'a chave pública de visualização não é ponto válido na curva ed25519' };
  }
  return { ok: true, prefixo: bruto[0] };
}
function enderecoValido(endereco) { return analisarEndereco(endereco).ok; }

// =============================================================
// PROVA DE TRABALHO: varints do blob, alvo e dificuldade
// =============================================================
function lerVarint(bytes, pos) {
  let valor = 0;
  let deslocamento = 0;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    valor += (b & 0x7f) * 2 ** deslocamento;
    deslocamento += 7;
    if (deslocamento > 63) throw new Error('varint maior que o esperado');
    if (!(b & 0x80)) return { valor, pos };
  }
  throw new Error('varint cortado no fim do blob');
}

// Onde começa o nonce (4 bytes) dentro do blob do bloco:
//   major_version | minor_version | timestamp | prev_id (32 bytes) | nonce (4) | ...
// Nos blocos atuais isso dá 39 (o mesmo offset que o webminerpool usava, mas
// aqui é calculado — assim continua certo se o varint do timestamp mudar).
function offsetNonce(blob) {
  try {
    let p = 0;
    p = lerVarint(blob, p).pos;    // major_version
    p = lerVarint(blob, p).pos;    // minor_version
    p = lerVarint(blob, p).pos;    // timestamp
    const offset = p + 32;         // prev_id
    if (offset + 4 > blob.length) return null;
    return offset;
  } catch {
    return null;
  }
}

function bytesParaIntLe(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

// hash < (alvo << (256 - 8 * bytes_do_alvo)), os dois lidos em little-endian
function alvoOK(hash, alvoHex) {
  const alvo = hexParaBytes(alvoHex);
  if (!alvo || !alvo.length || !hash || hash.length !== 32) return false;
  const limite = bytesParaIntLe(alvo) << (256n - 8n * BigInt(alvo.length));
  return bytesParaIntLe(hash) < limite;
}

// dificuldade ≈ (2^(8n) - 1) / alvo  (n = bytes do alvo; 4 bytes -> ex.: 4294967295/429496 = 10000)
function dificuldadeDe(alvoHex) {
  const alvo = hexParaBytes(alvoHex);
  if (!alvo || !alvo.length) return 0;
  const n = BigInt(alvo.length);
  const t = bytesParaIntLe(alvo);
  if (t === 0n) return 0;
  return Number(((1n << (8n * n)) - 1n) / t);
}

// =============================================================
// ESTADO DO TRABALHADOR
// =============================================================
let config = null;              // { endereco, senha, ponte, poolHost, poolPort, identificador, idTrabalhador }
let canalWs = null;             // WebSocket com a ponte
let parado = true;
let sessao = null;              // id da sessão devolvido no login
let sequencia = 1;
const pendentes = new Map();    // id da mensagem -> { tipo, t0 } para casar perguntas e respostas
let cacheRx = null;             // cache do RandomX (256 MB)
let vmRx = null;                // VM do RandomX (vm.calculate_hash)
let sementeAtual = null;        // seed_hash que está no cache
let blob = null;                // Uint8Array do job atual
let offset = 39;
let alvoHex = null;
let jobId = null;
let geracao = 0;                // sobe a cada job novo (mata o laço antigo)
let nonce = 0;
let lacoDaGeracao = 0;          // geração do laço de mineração que está rodando (0 = nenhum)
let hashesNaRodada = 0;
let tInicioRodada = 0;
let tUltimoProgresso = 0;
let latencia = null;
let relogioKeepalive = null;

const registrar = (texto, nivel = 'info') => postar({ tipo: 'log', nivel, texto });
const aoEstado = (valor, motivo) => postar({ tipo: 'estado', estado: valor, motivo });

function enviar(metodo, parametros) {
  if (!canalWs || canalWs.readyState !== 1) return null;
  const id = String(sequencia++);
  pendentes.set(id, { tipo: metodo, t0: agora() });
  canalWs.send(JSON.stringify({ id, jsonrpc: '2.0', method: metodo, params: parametros }));
  return id;
}

// =============================================================
// STRATUM (as linhas chegam prontas pela ponte)
// =============================================================
function tratarLinha(linha) {
  let j;
  try { j = JSON.parse(linha); } catch { return; }   // o pool às vezes manda lixo: ignora
  const id = j.id !== undefined && j.id !== null ? String(j.id) : null;
  const pendente = id ? pendentes.get(id) : null;

  // resposta do login: traz a sessão e o primeiro job
  if (pendente && pendente.tipo === 'login') {
    pendentes.delete(id);
    latencia = Math.round(agora() - pendente.t0);
    if (j.error) {
      const msg = (j.error && j.error.message) || JSON.stringify(j.error);
      registrar(`o pool recusou o login: ${msg}`, 'erro');
      registrar('dica: confira se o endereço é uma carteira Monero válida (95 caracteres) da sua carteira oficial — a ponte só repassa, quem valida é o pool.', 'aviso');
      return parar(true);
    }
    if (j.result && j.result.id) sessao = j.result.id;
    registrar(`login aceito pelo pool (sessão ${sessao}) — latência ${latencia} ms`, 'ok');
    aoEstado('conectado');
    if (j.result && j.result.job) tratarJob(j.result.job);
    return;
  }

  // resposta de submit: GOOD (aceito) ou BAD (recusado)
  if (pendente && pendente.tipo === 'submit') {
    pendentes.delete(id);
    latencia = Math.round(agora() - pendente.t0);
    if (j.error) {
      const msg = (j.error && j.error.message) || JSON.stringify(j.error);
      postar({ tipo: 'share', worker: config.idTrabalhador, aceito: false, mensagem: msg, latencia });
      registrar(`share recusado pelo pool: ${msg}`, 'aviso');
    } else {
      postar({ tipo: 'share', worker: config.idTrabalhador, aceito: true, latencia });
      registrar(`share aceito pelo pool (latência ${latencia} ms)`, 'ok');
    }
    return;
  }

  // resposta do keepalived: só serve para medir a latência
  if (pendente && pendente.tipo === 'keepalived') {
    pendentes.delete(id);
    latencia = Math.round(agora() - pendente.t0);
    return;
  }

  // job empurrado pelo pool (bloco novo)
  if (j.method === 'job' && j.params) { tratarJob(j.params); return; }

  // qualquer outra coisa: mostra cortado, só para depurar
  registrar(`mensagem inesperada do pool: ${String(linha).slice(0, 160)}`, 'aviso');
}

function tratarJob(job) {
  try {
    if (!job || typeof job.blob !== 'string' || job.blob.length % 2 !== 0 || job.blob.length < 86) {
      throw new Error('blob do bloco ausente ou inválido');
    }
    if (typeof job.target !== 'string' || job.target.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(job.target)) {
      throw new Error('alvo (target) inválido');
    }
    if (job.job_id === undefined || job.job_id === null) throw new Error('job sem job_id');
    if (job.algo && job.algo !== 'rx/0') {
      registrar(`o pool pediu o algoritmo "${job.algo}" — este minerador só sabe rx/0 (RandomX). Aguardando o próximo job…`, 'aviso');
      return;
    }
    if (job.seed_hash && !/^[0-9a-fA-F]{64}$/.test(job.seed_hash)) throw new Error('seed_hash inválido');

    // trocou a epoch: refaz o cache de 256 MB (leva ~1 s e reaproveita a memória alocada)
    if ((job.seed_hash || null) !== sementeAtual) {
      const t0 = agora();
      const chave = job.seed_hash ? hexParaBytes(job.seed_hash) : undefined;
      const api = apiRandomX();
      registrar('preparando o RandomX: cache de 256 MB (trava ~1 s — a página não morreu)…', 'aviso');
      cacheRx = cacheRx ? api.randomx_init_cache(chave, cacheRx) : api.randomx_init_cache(chave);
      vmRx = api.randomx_create_vm(cacheRx);
      sementeAtual = job.seed_hash || null;
      registrar(`RandomX pronto em ${Math.round(agora() - t0)} ms (epoch ${job.seed_hash ? `${job.seed_hash.slice(0, 12)}…` : 'do pool'})`, 'ok');
    }

    blob = hexParaBytes(job.blob);
    const pos = offsetNonce(blob);
    if (pos === null) throw new Error('não achei o nonce dentro do blob');
    offset = pos;
    alvoHex = job.target.toLowerCase();
    jobId = String(job.job_id);
    geracao++;

    const dificuldade = dificuldadeDe(alvoHex);
    postar({
      tipo: 'job', worker: config.idTrabalhador, dificuldade,
      latencia, altura: job.height === undefined ? null : job.height, algo: job.algo || 'rx/0',
    });
    registrar(`job ${jobId} — dificuldade ≈ ${dificuldade}${job.height ? `, altura ${job.height}` : ''}`, 'info');
    iniciarMineracao();
  } catch (e) {
    registrar(`job inválido: ${e.message}`, 'erro');
  }
}

// =============================================================
// A MINERAÇÃO (RandomX + conferência do alvo)
// =============================================================
function iniciarMineracao() {
  if (parado || !vmRx || !blob) return;
  if (lacoDaGeracao === geracao) return;   // já existe um laço trabalhando neste job
  lacoDaGeracao = geracao;                 // este laço é o dono desta geração
  const minhaGeracao = geracao;
  const meuBlob = blob;
  const meuAlvo = alvoHex;
  const meuJob = jobId;
  const meuOffset = offset;
  hashesNaRodada = 0;
  tInicioRodada = agora();
  if (!nonce) nonce = Math.floor(Math.random() * 0xffffffff) >>> 0;   // começa num ponto aleatório

  const passo = async () => {
    // sai se pararam, se veio job novo (geração mudou) ou se o canal fechou
    if (parado || geracao !== minhaGeracao || lacoDaGeracao !== minhaGeracao
      || !canalWs || canalWs.readyState !== 1) return;
    // nonce little-endian nos 4 bytes do blob (mesma ordem enviada no submit)
    meuBlob[meuOffset] = nonce & 0xff;
    meuBlob[meuOffset + 1] = (nonce >>> 8) & 0xff;
    meuBlob[meuOffset + 2] = (nonce >>> 16) & 0xff;
    meuBlob[meuOffset + 3] = (nonce >>> 24) & 0xff;

    const hash = vmRx.calculate_hash(meuBlob);
    hashesNaRodada++;

    if (alvoOK(hash, meuAlvo)) {
      // se o job mudou enquanto a gente calculava, o share seria velho: nem manda
      if (geracao === minhaGeracao) {
        const nonceHex = bytesParaHex(meuBlob.subarray(meuOffset, meuOffset + 4));
        enviar('submit', { job_id: meuJob, nonce: nonceHex, result: bytesParaHex(hash) });
        registrar(`deu alvo! nonce ${nonceHex} (${hashesNaRodada} hashes nesta rodada) — enviando ao pool`, 'ok');
      }
    }

    nonce = (nonce + 1) >>> 0;

    const t = agora();
    if (t - tUltimoProgresso >= 1000) {
      tUltimoProgresso = t;
      const segundos = (t - tInicioRodada) / 1000;
      postar({
        tipo: 'progresso', worker: config.idTrabalhador,
        hashrate: segundos > 0 ? hashesNaRodada / segundos : 0,
        nonce: bytesParaHex(meuBlob.subarray(meuOffset, meuOffset + 4)),
        dificuldade: dificuldadeDe(meuAlvo), latencia,
      });
    }

    // devolve o controle para o Worker: é aqui que "parar" e job novo entram
    setTimeout(passo, 0);
  };
  passo();
}

// =============================================================
// CONEXÃO COM A PONTE
// =============================================================
function conectar() {
  if (parado) return;
  aoEstado(canalWs ? 'reconectando' : 'conectando');
  const url = `${config.ponte}${config.ponte.includes('?') ? '&' : '?'}pool=${encodeURIComponent(`${config.poolHost}:${config.poolPort}`)}`;
  try {
    canalWs = new contexto.WebSocket(url);
  } catch (e) {
    registrar(`não consegui abrir o WebSocket da ponte: ${e.message}`, 'erro');
    return parar(true);
  }

  canalWs.onopen = () => {
    registrar(`conectado à ponte ${config.ponte}`, 'info');
    enviar('login', {
      login: config.endereco,
      pass: config.senha,
      agent: `${config.identificador}/${config.idTrabalhador}`,
    });
    clearInterval(relogioKeepalive);
    relogioKeepalive = setInterval(() => {
      if (sessao && canalWs && canalWs.readyState === 1) enviar('keepalived', { id: sessao });
    }, 60000);
    if (relogioKeepalive && typeof relogioKeepalive.unref === 'function') relogioKeepalive.unref();
  };
  canalWs.onmessage = (evento) => {
    try { tratarLinha(String(evento.data)); } catch (e) { registrar(`falha ao tratar mensagem do pool: ${e.message}`, 'erro'); }
  };
  canalWs.onerror = () => { /* quem conta o que houve é o onclose */ };
  canalWs.onclose = () => {
    clearInterval(relogioKeepalive);
    relogioKeepalive = null;
    lacoDaGeracao = -1;               // nenhum laço válido (o laço atual se encerra sozinho)
    if (parado) return;
    registrar('a ponte caiu — tentando de novo em 15 s (a ponte está no ar? node ponte.js)', 'aviso');
    aoEstado('reconectando');
    setTimeout(conectar, 15000);
  };
}

function parar(porErro) {
  parado = true;
  lacoDaGeracao = -1;                 // o laço da mineração vai se encerrar no próximo passo
  clearInterval(relogioKeepalive);
  relogioKeepalive = null;
  if (canalWs) {
    try { canalWs.close(); } catch { /* já fechado */ }
    canalWs = null;
  }
  sessao = null;
  pendentes.clear();
  aoEstado(porErro ? 'erro' : 'parado');
}

// =============================================================
// MENSAGENS DO PAINEL
// =============================================================
contexto.onmessage = (evento) => {
  const msg = evento.data || {};

  if (msg.tipo === 'iniciar') {
    const endereco = String(msg.endereco || '').trim();
    const analise = analisarEndereco(endereco);
    if (!analise.ok) {
      registrar(`endereço XMR recusado: ${analise.motivo}`, 'erro');
      aoEstado('erro', 'endereço inválido');
      return;
    }
    const poolHost = String(msg.poolHost || '').trim();
    const poolPort = Number(msg.poolPort);
    if (!/^[A-Za-z0-9.\-]+$/.test(poolHost) || !Number.isInteger(poolPort) || poolPort < 1 || poolPort > 65535) {
      registrar('pool inválido: informe o host (ex.: gulf.moneroocean.stream) e a porta (ex.: 10001)', 'erro');
      aoEstado('erro', 'pool inválido');
      return;
    }
    if (!String(msg.ponte || '').startsWith('ws')) {
      registrar('endereço da ponte inválido: precisa começar com ws:// (ex.: ws://127.0.0.1:8080/ws)', 'erro');
      aoEstado('erro', 'ponte inválida');
      return;
    }
    config = {
      endereco,
      senha: String(msg.senha || 'x').slice(0, 64) || 'x',
      ponte: String(msg.ponte).replace(/\?$/, ''),
      poolHost,
      poolPort,
      identificador: String(msg.identificador || 'GitHubPages-Monero').slice(0, 32),
      idTrabalhador: Number(msg.idTrabalhador) || 1,
    };
    parado = false;
    sessao = null;
    nonce = 0;
    registrar(`trabalhador ${config.idTrabalhador}: endereço ok — falando com ${config.poolHost}:${config.poolPort} pela ponte`, 'info');
    conectar();
    return;
  }

  if (msg.tipo === 'parar') parar(false);
};

// =============================================================
// EXPORTADO PARA O TESTE (dentro do Worker isso é ignorado)
// =============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    keccak256, decodificarBase58, analisarEndereco, enderecoValido, pontoValido,
    lerVarint, offsetNonce, bytesParaIntLe, alvoOK, dificuldadeDe, hexParaBytes, bytesParaHex,
  };
}


