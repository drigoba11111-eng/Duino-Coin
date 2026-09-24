/* =============================================================
   trabalhador.js — Web Worker do minerador para GitHub Pages
   -------------------------------------------------------------
   Por que um Worker separado?
   • O navegador NÃO abre socket TCP cru (o protocolo do DUCO é TCP), mas o
     Duino-Coin mantém um gateway WebSocket oficial justamente para o web
     miner:  wss://magi.duinocoin.com:8443  (é o que o site oficial usa).
   • A busca do nonce é pesada; no Worker ela não trava a interface.

   Protocolo (idêntico ao web miner oficial v3.4):
     servidor envia a versão  ->  nós enviamos  JOB,usuario,dificuldade,miner_key
     servidor envia o job      ->  "lastBlockHash,hashEsperado,dificuldade"
     achamos o nonce           ->  nonce,hashrate,identificador,rigid,,wallet_id
     servidor responde         ->  GOOD,<saldo>  ou  BAD

   Este arquivo roda no navegador E no Node (o teste teste-githubpages.js
   aponta o contexto para globalThis), por isso nada de `self.` fixo:
   usamos `contexto`.
   ============================================================= */
'use strict';

const contexto = typeof self !== 'undefined' ? self : globalThis;
const postar = (obj) => contexto.postMessage(obj);
const agora = () => performance.now();

// =============================================================
// #region nucleo-ducos1 — SHA1 do Duino-Coin (DUCO-S1A) em JS puro
// -------------------------------------------------------------
// A mensagem minerada é sempre lastBlockHash(40 caracteres) + nonce(decimal):
// 41..52 bytes, ou seja cabe SEMPRE em um único bloco de 64 bytes do SHA1.
// Então o bloco é montado uma vez por job e só os dígitos mudam:
//   • bytes 0..39 -> os 40 caracteres ASCII do lastBlockHash (fixos)
//   • bytes 40..  -> dígitos do nonce, 0x80 e o tamanho em bits
// Cada candidato custa exatamente 1 compressão SHA1 (80 rodadas).
// =============================================================

const H0 = 0x67452301;
const H1 = 0xefcdab89 | 0;
const H2 = 0x98badcfe | 0;
const H3 = 0x10325476;
const H4 = 0xc3d2e1f0 | 0;

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) | 0;

const saidaDigest = new Int32Array(5);      // reaproveitado: zero alocação por nonce

/** Uma compressão SHA1 (80 rodadas) -> 5 palavras do digest (já com o estado somado). */
function comprimir(bloco, W, a, b, c, d, e) {
  const a0 = a; const b0 = b; const c0 = c; const d0 = d; const e0 = e;   // feed-forward
  for (let i = 0; i < 16; i++) {
    W[i] = (bloco[i * 4] << 24) | (bloco[i * 4 + 1] << 16) | (bloco[i * 4 + 2] << 8) | bloco[i * 4 + 3];
  }
  for (let i = 16; i < 80; i++) {
    const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
    W[i] = (x << 1) | (x >>> 31);
  }
  for (let i = 0; i < 20; i++) {
    const t = (rotl(a, 5) + ((b & c) | (~b & d)) + e + W[i] + 0x5a827999) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  for (let i = 20; i < 40; i++) {
    const t = (rotl(a, 5) + (b ^ c ^ d) + e + W[i] + 0x6ed9eba1) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  for (let i = 40; i < 60; i++) {
    const t = (rotl(a, 5) + ((b & c) | (b & d) | (c & d)) + e + W[i] + 0x8f1bbcdc) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  for (let i = 60; i < 80; i++) {
    const t = (rotl(a, 5) + (b ^ c ^ d) + e + W[i] + 0xca62c1d6) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  const h = saidaDigest;
  h[0] = (a + a0) | 0; h[1] = (b + b0) | 0; h[2] = (c + c0) | 0;
  h[3] = (d + d0) | 0; h[4] = (e + e0) | 0;
  return h;
}

/** SHA1 completo em hex, de um texto ASCII (usado pelo teste automatizado). */
function sha1Hex(texto) {
  const dados = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) dados[i] = texto.charCodeAt(i) & 0xff;

  let a = H0; let b = H1; let c = H2; let d = H3; let e = H4;
  const W = new Int32Array(80);
  const total = dados.length;
  const blocos = Math.ceil((total + 9) / 64);

  for (let i = 0; i < blocos; i++) {
    const bloco = new Uint8Array(64);
    const inicio = i * 64;
    const copiados = Math.max(0, Math.min(64, total - inicio));
    if (copiados > 0) bloco.set(dados.subarray(inicio, inicio + copiados));

    // O terminador 0x80 vem LOGO depois da mensagem: se não couber neste
    // bloco junto com o tamanho, ele fica aqui e o tamanho vai no próximo.
    const posTermo = total - inicio;
    if (posTermo >= 0 && posTermo < 64) bloco[posTermo] = 0x80;

    if (i === blocos - 1) {
      const bits = total * 8;                    // tamanho ocupa os ÚLTIMOS 8 bytes:
      bloco[60] = (bits >>> 24) & 0xff;          // parte baixa em 60..63
      bloco[61] = (bits >>> 16) & 0xff;          // (a parte alta, 56..59, fica zero)
      bloco[62] = (bits >>> 8) & 0xff;
      bloco[63] = bits & 0xff;
    }
    [a, b, c, d, e] = comprimir(bloco, W, a, b, c, d, e);
  }
  const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b) + hex(c) + hex(d) + hex(e);
}

/** "aabbcc..." (40 chars hex) -> 5 palavras de 32 bits do digest. */
function palavrasDoHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{40}$/.test(hex)) return null;
  const p = new Int32Array(5);
  for (let i = 0; i < 5; i++) p[i] = parseInt(hex.substr(i * 8, 8), 16) | 0;
  return p;
}
// =============================================================
// Buscador de nonce de um job do DUCO-S1A
// =============================================================
/**
 * @param {string} prefixoHex lastBlockHash do job (40 caracteres hex)
 */
function criarBuscador(prefixoHex) {
  if (!/^[0-9a-fA-F]{40}$/.test(String(prefixoHex || ''))) {
    throw new Error('lastBlockHash inválido no job');
  }
  const bloco = new Uint8Array(64);
  // O DUCO hasheia o TEXTO do job: o lastBlockHash entra como 40 caracteres
  // ASCII (não como 20 bytes binários) seguido dos dígitos do nonce.
  // É exatamente o que o duco-miner.js validado faz com sha1(lastBlockHash + nonce).
  for (let i = 0; i < 40; i++) bloco[i] = prefixoHex.charCodeAt(i);
  const W = new Int32Array(80);
  let digitos = 0;                     // dígitos do último nonce escrito

  /** Escreve o nonce em decimal a partir do byte 40; devolve nº de dígitos. */
  function escreverNonce(n) {
    let q = n;
    let feitos = 0;
    if (q === 0) { bloco[40] = 48; return 1; }
    while (q > 0) {                    // de trás para frente...
      bloco[40 + feitos] = 48 + (q % 10);
      q = (q / 10) | 0;
      feitos++;
    }
    for (let i = 0, j = feitos - 1; i < j; i++, j--) {   // ...e inverte no lugar
      const t = bloco[40 + i]; bloco[40 + i] = bloco[40 + j]; bloco[40 + j] = t;
    }
    return feitos;
  }

  /**
   * Procura em [inicio, fim) o nonce tal que SHA1(prefixo + nonce) = alvo.
   * @param {Int32Array} alvo 5 palavras do hash esperado
   * @param {function(number)} [aoProgresso] chamado de vez em quando (250 ms)
   * @returns {number} o nonce encontrado, ou -1
   */
  function procurar(alvo, inicio, fim, aoProgresso) {
    for (let i = 41; i < 64; i++) bloco[i] = 0;    // cauda limpa (0x80 entra depois)
    let ultimoAviso = agora();
    for (let n = inicio; n < fim; n++) {
      const d = escreverNonce(n);
      if (40 + d >= 56) throw new Error('nonce grande demais para um bloco SHA1');
      bloco[40 + d] = 0x80;                        // terminador logo após os dígitos
      if (d !== digitos) {                         // mudou a quantidade de dígitos
        digitos = d;
        const bits = (40 + d) * 8;
        bloco[60] = (bits >>> 24) & 0xff; bloco[61] = (bits >>> 16) & 0xff;
        bloco[62] = (bits >>> 8) & 0xff; bloco[63] = bits & 0xff;
      }
      const h = comprimir(bloco, W, H0, H1, H2, H3, H4);
      if (h[0] === alvo[0] && h[1] === alvo[1] && h[2] === alvo[2]
          && h[3] === alvo[3] && h[4] === alvo[4]) return n;
      if (aoProgresso) {
        const t = agora();
        if (t - ultimoAviso > 250) { ultimoAviso = t; aoProgresso(n); }
      }
    }
    return -1;
  }

  return { procurar };
}
// #endregion nucleo-ducos1

// =============================================================
// PROTOCOLO COM O GATEWAY WEBSOCKET DO DUINO-COIN
// =============================================================
const ENDERECO_PADRAO = 'wss://magi.duinocoin.com:8443';
const ESPERA_RECONEXAO = 15000;          // igual ao web miner oficial

let config = null;                       // { usuario, minerKey, dificuldade, identificador, rigid, endpoint, idTrabalhador }
let socket = null;
let parado = true;
let mandouJobEm = 0;
const idCarteira = 10000 + Math.floor(Math.random() * 89999);   // o oficial também manda um id aleatório

const registrar = (texto, nivel = 'info') => postar({ tipo: 'log', nivel, texto });
const enviarLinha = (linha) => {
  if (socket && socket.readyState === 1) socket.send(linha);    // 1 = OPEN
};

/** Pede um novo job (o gateway responde "lastBlockHash,hash,dificuldade"). */
function pedirJob() {
  enviarLinha(`JOB,${config.usuario},${config.dificuldade},${config.minerKey}`);
  return agora();
}

function conectar() {
  if (parado) return;
  postar({ tipo: 'estado', estado: socket ? 'reconectando' : 'conectando' });
  try {
    socket = new contexto.WebSocket(config.endpoint);
  } catch (e) {
    registrar(`Endereço WebSocket inválido (${config.endpoint}): ${e.message}`, 'erro');
    postar({ tipo: 'estado', estado: 'erro', motivo: 'endereço inválido' });
    return;
  }

  socket.onopen = () => {
    registrar(`Trabalhador ${config.idTrabalhador}: conectado a ${config.endpoint}`, 'ok');
    postar({ tipo: 'estado', estado: 'conectado' });
  };
  socket.onmessage = (ev) => {
    try {
      tratar(String(ev.data));
    } catch (e) {
      registrar(`Falha ao tratar a resposta do servidor: ${e.message}`, 'erro');
      mandouJobEm = pedirJob();
    }
  };
  socket.onerror = () => { /* o onclose avisa e reconecta */ };
  socket.onclose = () => {
    if (parado) return;
    registrar(`Trabalhador ${config.idTrabalhador}: conexão caiu — nova tentativa em ${ESPERA_RECONEXAO / 1000} s`, 'aviso');
    postar({ tipo: 'estado', estado: 'reconectando' });
    setTimeout(conectar, ESPERA_RECONEXAO);
  };
}

const numeroDepoisDe = (texto) => {
  const m = String(texto).match(/GOOD,?([\d.]+)?/);
  return m && m[1] ? Number(m[1]) : null;     // o saldo vem grudado no GOOD
};

function tratar(mensagem) {
  // 1) A primeira mensagem do servidor é a versão (ex.: "3.0")
  if (!mensagem.includes(',') && mensagem.includes('.')) {
    registrar(`Servidor do DUCO versão ${mensagem}`, 'ok');
    mandouJobEm = pedirJob();
    return;
  }
  // 2) Resultado do último share
  if (mensagem.includes('GOOD')) {
    postar({ tipo: 'share', aceito: true, saldo: numeroDepoisDe(mensagem) });
    mandouJobEm = pedirJob();
    return;
  }
  if (mensagem.includes('BAD')) {
    postar({ tipo: 'share', aceito: false });
    mandouJobEm = pedirJob();
    return;
  }
  // 3) Erros que não adianta insistir (não ficamos martelando o servidor)
  if (/doesn't exist|Too many workers|Invalid/i.test(mensagem)) {
    registrar(`O servidor recusou a mineração: ${mensagem}`, 'erro');
    parar(mensagem);
    return;
  }
  // 4) Job: "lastBlockHash,hashEsperado,dificuldade"
  if (mensagem.length > 40 && mensagem.split(',').length >= 3) {
    resolverJob(mensagem);
    return;
  }
  registrar(`Mensagem inesperada do servidor: ${mensagem}`, 'aviso');
}

function resolverJob(linha) {
  const campos = linha.split(',');
  const lastBlockHash = campos[0].trim();
  const hashAlvo = campos[1].trim();
  const difficulty = Number(String(campos[2] || '').trim());

  if (!Number.isFinite(difficulty) || difficulty <= 0) {
    registrar(`Dificuldade inválida no job ("${campos[2]}") — pedindo outro`, 'erro');
    mandouJobEm = pedirJob();
    return;
  }
  const alvo = palavrasDoHex(hashAlvo);
  if (!alvo) {
    registrar(`Hash esperado inválido no job ("${hashAlvo}") — pedindo outro`, 'erro');
    mandouJobEm = pedirJob();
    return;
  }

  const latencia = Math.round(agora() - mandouJobEm);
  const limite = 100 * difficulty + 1;          // exatamente como o minerador oficial
  const t0 = agora();
  const buscador = criarBuscador(lastBlockHash);

  const nonce = buscador.procurar(alvo, 0, limite, (n) => {
    postar({
      tipo: 'progresso', worker: config.idTrabalhador, nonce: n,
      ms: agora() - t0, difficulty, latencia,
    });
  });

  const ms = Math.max(1, agora() - t0);
  const hashrate = (nonce < 0 ? limite : nonce + 1) / (ms / 1000);

  if (nonce < 0) {                              // não achou: pede outro job em vez de mandar lixo
    postar({ tipo: 'job', worker: config.idTrabalhador, difficulty, latencia, naoAchou: true, hashrate });
    mandouJobEm = pedirJob();
    return;
  }

  const hashrateDoJob = (nonce + 1) / (ms / 1000);
  postar({ tipo: 'job', worker: config.idTrabalhador, difficulty, latencia, nonce, ms, hashrateDoJob });
  // Mesmo formato do web miner oficial: nonce,hashrate,identificador,rigid,,wallet_id
  enviarLinha(`${nonce},${Math.round(hashrateDoJob)},${config.identificador},${config.rigid},,${idCarteira}`);
}

function fecharSocket() {
  if (socket) {
    try { socket.close(); } catch { /* já fechado */ }
    socket = null;
  }
}

function parar(motivo) {
  parado = true;
  fecharSocket();
  postar({ tipo: 'estado', estado: 'parado', motivo: motivo || null });
}

contexto.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.tipo === 'iniciar') {
    config = {
      usuario: String(msg.usuario || '').trim(),
      minerKey: String(msg.minerKey || 'None').trim() || 'None',
      dificuldade: String(msg.dificuldade || 'LOW').trim() || 'LOW',
      identificador: String(msg.identificador || 'GitHubPages-WebPanel').trim() || 'GitHubPages-WebPanel',
      rigid: String(msg.rigid || 'None').trim() || 'None',
      endpoint: String(msg.endpoint || ENDERECO_PADRAO).trim(),
      idTrabalhador: Number(msg.idTrabalhador) || 1,
    };
    if (!config.usuario) {
      registrar('Sem usuário: informe a carteira antes de iniciar.', 'erro');
      return;
    }
    fecharSocket();
    parado = false;
    registrar(`Trabalhador ${config.idTrabalhador}: iniciando (dificuldade ${config.dificuldade}, carteira ${idCarteira})`, 'info');
    conectar();
    return;
  }
  if (msg.tipo === 'parar') parar();
};

// O teste automatizado (teste-githubpages.js) importa o núcleo daqui.
// No navegador `module` não existe, então nada acontece.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sha1Hex, criarBuscador, palavrasDoHex, ENDERECO_PADRAO };
}
