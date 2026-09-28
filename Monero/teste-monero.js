/* ============================================================================
 * teste-monero.js — bateria de testes do minerador de Monero para navegador
 *
 *   node teste-monero.js              → tudo (a parte 5 precisa de internet)
 *   node teste-monero.js --offline    → pula a parte 5 (pool real)
 *   node teste-monero.js --navegador  → liga também a parte 6: abre o Chrome/Edge
 *                                       headless na página servida pela ponte e
 *                                       confere o painel pelo DevTools (CDP)
 *   node teste-monero.js --share      → modo caçada: 4 mineradores de verdade
 *                                       contra o MoneroOcean até sair um share
 *                                       aceito (esperado: alguns minutos)
 *
 * O que é testado:
 *   1) NÚCLEO      — keccak-256, validação de endereço XMR, vetores upstream
 *                    do RandomX (5/5) e reaproveitamento do cache de 256 MB;
 *   2) PROVA       — posição do nonce no blob (39) e a regra do alvo
 *                    (LE-256 < alvo << (256 - 8·n)), inclusive no share real
 *                    que o MoneroOcean aceitou durante as sondagens;
 *   3) ENDEREÇOS   — os mesmos endereços aceitos/recusados pelos pools reais;
 *   4) LOCAL       — sobe a ponte.js de verdade + um pool stratum falso e o
 *                    trabalhador.js de verdade; o pool falso RECALCULA o
 *                    RandomX do blob com o nonce recebido e só aprova o share
 *                    se o resultado bater (prova de que nossa conta está certa);
 *   5) AO VIVO     — login + job real no gulf.moneroocean.stream:10001 e
 *                    mineração de verdade por alguns segundos;
 *   6) NAVEGADOR   — (--navegador) abre o Chrome/Edge headless na página servida
 *                    pela ponte e lê o painel pelo DevTools: é o caminho real do
 *                    usuário (HTML + Web Worker + importScripts do WASM + WebSocket);
 *   EXTRA          — (--share) caçada de share real com 4 mineradores.
 * ==========================================================================*/
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PASTA = __dirname;
// Carrega o trabalhador de verdade (ele mesmo carrega o randomx-web.js)
const T = require(path.join(PASTA, 'trabalhador.js'));
const R = globalThis.RandomX;

const OFFLINE = process.argv.includes('--offline');
const MODO_CACADOR = process.argv.includes('--cacador');
const ID_CACADOR = Number(process.argv[process.argv.indexOf('--cacador') + 1] || 0);

// ---------------------------------------------------------------------------
// placar e espera
// ---------------------------------------------------------------------------
let passes = 0;
let falhas = 0;
function ok(nome, condicao, detalhe) {
  if (condicao) { passes++; console.log(`  \x1b[32mok  \x1b[0m${nome}${detalhe ? ` \x1b[90m(${detalhe})\x1b[0m` : ''}`); }
  else { falhas++; console.log(`  \x1b[31mFALHA\x1b[0m ${nome}${detalhe ? ` \x1b[90m(${detalhe})\x1b[0m` : ''}`); }
}
function secao(titulo) { console.log(`\n\x1b[36m== ${titulo} ==\x1b[0m`); }
const esperar = (condicao, ms = 30000, passo = 100) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    let r;
    try { r = condicao(); } catch { r = false; }
    if (r) return resolve(r);
    if (Date.now() - t0 > ms) return reject(new Error(`tempo esgotado (${ms} ms)`));
    setTimeout(tick, passo);
  };
  tick();
});
// mesma ideia, para condições que precisam de await (falar com o navegador)
const esperarAsync = async (condicao, ms = 30000, passo = 300) => {
  const t0 = Date.now();
  for (;;) {
    let r = null;
    try { r = await condicao(); } catch { r = null; }
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error(`tempo esgotado (${ms} ms)`);
    await new Promise((r2) => setTimeout(r2, passo));
  }
};

// ---------------------------------------------------------------------------
// FIXTURES REAIS (todas vieram das sondagens contra pools de verdade)
// ---------------------------------------------------------------------------
const ENDERECO_TEVADOR = '845xHUh5GvfHwc2R8DVJCE7BT2sd4YEcmjG8GNSdmeNsP5DTEjXd1CNgxTcjHjiFuthRHAoVEJjM7GyKzQKLJtbd56xbh7V';
const ENDERECO_ACEITO = '43ufTdDRU3bRbkyjrPDtJrd9sqnZJRF56RBJiqgfcQ95FVXT2ufjU8k5WSpCUoecr44ABfhoJFuf31ZExmP7u1isVnM8QUa';
const ENDERECO_RECUSADO = '48p7G7hBWunZ3nzvbVKiVUHn6i2149qCiR7ASTVexyF9jB4NEXsRhUVaAqLgyu6w15HHrHqvZhiK2hF6e6UnAVML3XYSjT4';
// bloco real do Monero (vetor upstream do RandomX): 108 bytes, nonce em 39 = 00000000
const BLOCO_REAL = '0b0b98bea7e805e0010a2126d287a2a0cc833d312cb786385a7c2f9de69d25537f584a9bc9977b00000000666fd8753bf61a8631f12984e3fd44f4014eca629276817b56f32e9b68bd82f416';
// share REAL que o MoneroOcean aceitou nas sondagens (alvo b88d0600 ≈ dificuldade 10000)
const SHARE_REAL = { nonce: 'e61fa3e0', hash: 'd45e409a2cccb9fe6bc5dc9ca81b63c96c36456e0b83035ecc6682e404d90000', alvo: 'b88d0600' };
const OFFSET_DO_POOL = 39;          // onde o POOL escreve o nonce (fonte independente)

// ---------------------------------------------------------------------------
// 1) NÚCLEO
// ---------------------------------------------------------------------------
function parte1() {
  secao('1) Núcleo: keccak-256, endereço XMR, RandomX (vetores upstream) e cache');

  ok('keccak-256 da mensagem vazia',
    T.bytesParaHex(T.keccak256(new TextEncoder().encode(''))) === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  ok('keccak-256 de "abc"',
    T.bytesParaHex(T.keccak256(new TextEncoder().encode('abc'))) === '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');

  const cache = R.randomx_init_cache('test key 000');
  const vm = R.randomx_create_vm(cache);
  let acertos = 0;
  const vetores000 = [
    ['This is a test', '639183aae1bf4c9a35884cb46b09cad9175f04efd7684e7262a0ac1c2f0b4e3f'],
    ['Lorem ipsum dolor sit amet', '300a0adb47603dedb42228ccb2b211104f4da45af709cd7547cd049e9489c969'],
    ['sed do eiusmod tempor incididunt ut labore et dolore magna aliqua', 'c36d4ed4191e617309867ed66a443be4075014e2b061bcdaf9ce7b721d2b77a8'],
  ];
  for (const [entrada, esperado] of vetores000) if (vm.calculate_hex_hash(entrada) === esperado) acertos++;
  ok('RandomX: vetores upstream da chave "test key 000"', acertos === 3, `${acertos}/3`);

  // reaproveitar o MESMO cache com outra chave (é o que acontece quando a epoch troca)
  const cache001 = R.randomx_init_cache('test key 001', cache);
  const vm001 = R.randomx_create_vm(cache001);
  let acertos2 = 0;
  if (vm001.calculate_hex_hash('sed do eiusmod tempor incididunt ut labore et dolore magna aliqua')
    === 'e9ff4503201c0c2cca26d285c93ae883f9b1d30c9eb240b820756f2d5a7905fc') acertos2++;
  if (vm001.calculate_hex_hash(T.hexParaBytes(BLOCO_REAL))
    === 'c56414121acda1713c2f2a819d8ae38aed7c80c35c2a769298d34f03833cd5f1') acertos2++;
  ok('RandomX: cache reaproveitado com a chave "test key 001"', acertos2 === 2, `${acertos2}/2`);
}

// ---------------------------------------------------------------------------
// 2) PROVA DE TRABALHO (nonce + alvo)
// ---------------------------------------------------------------------------
function blobSintetico(timestamp) {
  const bytes = [];
  const varint = (n) => {
    for (;;) {
      const b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) bytes.push(b | 0x80); else { bytes.push(b); return; }
    }
  };
  varint(16); varint(16); varint(timestamp);
  for (let i = 0; i < 32; i++) bytes.push(i);   // prev_id qualquer
  for (let i = 0; i < 4; i++) bytes.push(0);    // nonce
  for (let i = 0; i < 40; i++) bytes.push(0);   // resto do blob
  return Uint8Array.from(bytes);
}

function parte2() {
  secao('2) Prova de trabalho: posição do nonce e regra do alvo');

  const bloco = T.hexParaBytes(BLOCO_REAL);
  ok('nonce em 39 num bloco real do Monero', T.offsetNonce(bloco) === 39, `offset ${T.offsetNonce(bloco)}`);
  ok('os 4 bytes do nonce nesse bloco são zero', T.bytesParaHex(bloco.subarray(39, 43)) === '00000000');

  const agoraEmSegundos = Math.floor(Date.now() / 1000);
  ok('blob com timestamp atual → 39', T.offsetNonce(blobSintetico(agoraEmSegundos)) === 39);
  ok('blob com timestamp antigo (4 bytes) → 38', T.offsetNonce(blobSintetico(3000000)) === 38);

  // a regra do alvo aplicada ao share REAL aceito pelo MoneroOcean
  ok('alvoOK() aprova o share que o pool aceitou de verdade',
    T.alvoOK(T.hexParaBytes(SHARE_REAL.hash), SHARE_REAL.alvo) === true);
  ok('dificuldade ≈ 10000 para o alvo do MoneroOcean',
    T.dificuldadeDe(SHARE_REAL.alvo) === 10000, String(T.dificuldadeDe(SHARE_REAL.alvo)));

  // limítrofes (alvo em little-endian)
  const zeros = new Uint8Array(32);
  const com1NoFim = new Uint8Array(32); com1NoFim[31] = 1;
  const com1NoMeio = new Uint8Array(32); com1NoMeio[30] = 1;
  const com2NoFim = new Uint8Array(32); com2NoFim[31] = 2;
  ok('alvo "01000000" (LE = 1): hash zero passa', T.alvoOK(zeros, '01000000') === true);
  ok('alvo "01000000" (LE = 1): hash 1 não passa', T.alvoOK(com1NoFim, '01000000') === false);
  ok('alvo "00000001" (LE = 0x1000000): hash 0x100..0 passa', T.alvoOK(com1NoMeio, '00000001') === true);
  ok('alvo "00000001" (LE = 0x1000000): hash 0x200..0 não passa', T.alvoOK(com2NoFim, '00000001') === false);
  ok('alvo de 8 bytes é aceito', T.alvoOK(zeros, 'ffffffffffffffff') === true);
  ok('dificuldade do alvo "ffffffff" é 1', T.dificuldadeDe('ffffffff') === 1);
}

// ---------------------------------------------------------------------------
// 3) ENDEREÇOS (os mesmos que os pools aceitaram/recusaram)
// ---------------------------------------------------------------------------
function parte3() {
  secao('3) Endereço XMR (base58 + keccak-256 + pontos ed25519)');

  ok('subendereço real do tevador é aceito', T.enderecoValido(ENDERECO_TEVADOR) === true);
  ok('endereço gerado que o pool ACEITOU é aceito aqui também', T.enderecoValido(ENDERECO_ACEITO) === true);

  const recusado = T.analisarEndereco(ENDERECO_RECUSADO);
  ok('endereço que o pool RECUSOU é recusado aqui também', recusado.ok === false, recusado.motivo);
  ok('o motivo é a chave pública fora da curva ed25519', /ed25519/.test(recusado.motivo));

  const corrompido = ENDERECO_TEVADOR.slice(0, 40) + (ENDERECO_TEVADOR[40] === 'A' ? 'B' : 'A') + ENDERECO_TEVADOR.slice(41);
  const diagnostico = T.analisarEndereco(corrompido);
  ok('um caractere trocado quebra o checksum', diagnostico.ok === false, diagnostico.motivo);
  ok('endereço com tamanho errado é recusado', T.enderecoValido('4'.repeat(40)) === false);
  ok('endereço com letra fora do alfabeto base58 é recusado', T.enderecoValido('4'.repeat(94) + 'l') === false);
}

// ---------------------------------------------------------------------------
// 4) PONTA A PONTA LOCAL (ponte de verdade + pool falso + trabalhador de verdade)
// ---------------------------------------------------------------------------
function subirPonte(porta) {
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, [path.join(PASTA, 'ponte.js'), String(porta)], {
      env: { ...process.env, PONTE_SEM_ABRIR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = '';
    const prazo = setTimeout(() => {
      try { filho.kill(); } catch { /* já morreu */ }
      reject(new Error(`a ponte não subiu em 10 s: ${saida}`));
    }, 10000);
    filho.stdout.on('data', (d) => {
      saida += d.toString();
      if (saida.includes('PONTE PRONTA')) { clearTimeout(prazo); resolve(filho); }
    });
    filho.stderr.on('data', (d) => { saida += d.toString(); });
    filho.on('exit', (codigo) => {
      clearTimeout(prazo);
      reject(new Error(`a ponte saiu (código ${codigo}): ${saida}`));
    });
  });
}

// Pool stratum falso: fala o mesmo JSON-RPC 2.0 do MoneroOcean, mas o que
// importa é que ele RECALCULA o RandomX do blob com o nonce recebido — se o
// nosso hash e a nossa posição do nonce estiverem errados, ele reprova.
function criarPoolFalso(porta, semente, blobHex, offsetDoPool) {
  const vm = R.randomx_create_vm(R.randomx_init_cache(T.hexParaBytes(semente)));
  const estado = { job: null, sockets: [], submits: 0, bons: 0, maus: 0, recebidos: [], problemas: [] };

  const mandar = (sock, objeto) => sock.write(JSON.stringify(objeto) + '\n');
  const responder = (sock, id, erro) => mandar(sock, { id, jsonrpc: '2.0', result: erro ? null : { status: 'OK' }, error: erro });

  const servidor = net.createServer((sock) => {
    estado.sockets.push(sock);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const linha = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!linha.trim()) continue;
        let msg;
        try { msg = JSON.parse(linha); } catch { continue; }

        if (msg.method === 'login') {
          mandar(sock, { id: msg.id, jsonrpc: '2.0', error: null, result: { id: 'sessao-do-pool-falso', job: estado.job, status: 'OK' } });
        } else if (msg.method === 'keepalived') {
          mandar(sock, { id: msg.id, jsonrpc: '2.0', error: null, result: { status: 'KEEPALIVED' } });
        } else if (msg.method === 'submit') {
          const p = msg.params || {};
          const nonce = T.hexParaBytes(String(p.nonce || ''));
          const recebido = String(p.result || '').toLowerCase();
          if (!nonce || nonce.length !== 4) {
            estado.problemas.push(`nonce malformado: ${p.nonce}`);
            return responder(sock, msg.id, { code: -1, message: 'nonce malformado' });
          }
          if (recebido.length !== 64) {
            estado.problemas.push(`result não tem 64 hex: ${recebido.length}`);
            return responder(sock, msg.id, { code: -1, message: 'result malformado' });
          }
          // o POOL escreve o nonce no offset DELE e recalcula o hash sozinho
          const blob = T.hexParaBytes(blobHex);
          for (let k = 0; k < 4; k++) blob[offsetDoPool + k] = nonce[k];
          const recalculado = vm.calculate_hex_hash(blob);
          estado.recebidos.push({ job_id: p.job_id, nonce: p.nonce, recalculado });
          if (recalculado !== recebido) {
            estado.problemas.push(`hash não bate: recebido ${recebido} / recalculado ${recalculado}`);
            return responder(sock, msg.id, { code: -1, message: 'Hash inválido (o recálculo do pool não bateu)' });
          }
          // alvo conferido à parte, com BigInt (sem chamar o código do minerador)
          const alvo = T.hexParaBytes(estado.job.target);
          const limite = T.bytesParaIntLe(alvo) << (256n - 8n * BigInt(alvo.length));
          if (!(T.bytesParaIntLe(T.hexParaBytes(recebido)) < limite)) {
            return responder(sock, msg.id, { code: -1, message: 'Dificuldade baixa' });
          }
          estado.submits++;
          if (estado.submits === 2) {
            // o 2º submit é recusado de propósito: é assim que o teste exercita o caminho "BAD"
            estado.maus++;
            return responder(sock, msg.id, { code: -1, message: 'Share duplicado (teste do caminho BAD)' });
          }
          estado.bons++;
          return responder(sock, msg.id, null);
        }
      }
    });
    sock.on('error', () => { /* o teste segue */ });
  });

  return {
    estado,
    definirJob(job) { estado.job = job; },
    empurrarJob(job) {
      estado.job = job;
      for (const s of estado.sockets) mandar(s, { jsonrpc: '2.0', method: 'job', params: job });
    },
    ouvir() { return new Promise((resolve) => servidor.listen(porta, '127.0.0.1', resolve)); },
    fechar() { for (const s of estado.sockets) try { s.destroy(); } catch { /* já caiu */ } servidor.close(); },
  };
}

async function parte4() {
  secao('4) Ponta a ponta local: ponte.js + pool stratum falso + trabalhador');

  const PORTA_POOL = 21000 + Math.floor(Math.random() * 5000);
  const PORTA_PONTE = 26000 + Math.floor(Math.random() * 5000);
  const SEMENTE = 'aa'.repeat(32);
  const eventos = [];
  globalThis.postMessage = (m) => {                          // é assim que o trabalhador "fala" com o teste
    eventos.push(m);
    if (m.tipo === 'log' && (m.nivel === 'erro' || m.nivel === 'aviso')) {
      console.log(`     \x1b[90m[worker] ${m.texto}\x1b[0m`);
    }
  };
  const achar = (predicado, ms = 60000) => esperar(() => eventos.find(predicado), ms).catch(() => null);
  const limpar = () => { eventos.length = 0; };

  const jobBase = { blob: BLOCO_REAL, target: 'ffffffff', height: 100, seed_hash: SEMENTE, algo: 'rx/0' };
  const pool = criarPoolFalso(PORTA_POOL, SEMENTE, BLOCO_REAL, OFFSET_DO_POOL);
  pool.definirJob({ ...jobBase, job_id: 'job-1' });
  await pool.ouvir();
  const ponte = await subirPonte(PORTA_PONTE);
  ok('a ponte.js sobe e fica ouvindo', Boolean(ponte), `porta ${PORTA_PONTE}`);

  // manda o trabalhador de verdade começar (ele fala WebSocket com a ponte, que
  // repassa para o pool falso em TCP — exatamente o caminho do navegador)
  globalThis.onmessage({ data: {
    tipo: 'iniciar', endereco: ENDERECO_ACEITO, senha: 'x',
    ponte: `ws://127.0.0.1:${PORTA_PONTE}/ws`, poolHost: '127.0.0.1', poolPort: PORTA_POOL,
    identificador: 'TesteE2E', idTrabalhador: 1,
  } });

  const conectou = await achar((m) => m.tipo === 'estado' && m.estado === 'conectado', 60000);
  ok('login atravessou a ponte e o pool aceitou', Boolean(conectou));

  const primeiroJob = await achar((m) => m.tipo === 'job', 15000);
  ok('job do pool chegou ao trabalhador (dificuldade 1)',
    Boolean(primeiroJob) && primeiroJob.dificuldade === 1, primeiroJob ? `dificuldade ${primeiroJob.dificuldade}` : '');

  const bom = await achar((m) => m.tipo === 'share' && m.aceito === true, 90000);
  ok('share ACEITO pelo pool falso (o recálculo do RandomX bateu)', Boolean(bom));
  ok('o pool falso conferiu o hash por conta própria', pool.estado.bons >= 1, `${pool.estado.bons} aceito(s)`);
  ok('nenhum problema de verificação no pool falso', pool.estado.problemas.length === 0, pool.estado.problemas.join(' | '));

  const ruim = await achar((m) => m.tipo === 'share' && m.aceito === false, 30000);
  ok('resposta de recusa é tratada como BAD', Boolean(ruim), ruim ? ruim.mensagem : '');

  // job de outro algoritmo: tem que avisar no painel e seguir no job antigo
  limpar();
  pool.empurrarJob({ ...jobBase, job_id: 'job-2', algo: 'cn/r', height: 777 });
  const aviso = await achar((m) => m.tipo === 'log' && /só sabe rx\/0/.test(m.texto), 10000);
  ok('job de outro algoritmo é recusado com aviso claro', Boolean(aviso));
  ok('o alvo/altura desse job não trocaram nada', !eventos.some((m) => m.tipo === 'job'));

  limpar();
  pool.empurrarJob({ ...jobBase, job_id: 'job-3', height: 888 });
  const trocou = await achar((m) => m.tipo === 'job' && m.altura === 888, 15000);
  ok('job novo em rx/0 é aceito e aparece no painel', Boolean(trocou));
  await esperar(() => pool.estado.recebidos.some((r) => r.job_id === 'job-3'), 60000).catch(() => null);
  ok('o trabalhador passou a mandar shares do job novo', pool.estado.recebidos.some((r) => r.job_id === 'job-3'));
  ok('e nenhum share saiu com hash errado em nenhum momento', pool.estado.problemas.length === 0, pool.estado.problemas.join(' | '));

  limpar();
  globalThis.onmessage({ data: { tipo: 'parar' } });
  const parado = await achar((m) => m.tipo === 'estado' && m.estado === 'parado', 10000);
  ok('"parar" encerra e avisa o painel', Boolean(parado));

  limpar();
  globalThis.onmessage({ data: {
    tipo: 'iniciar', endereco: ENDERECO_RECUSADO, senha: 'x',
    ponte: `ws://127.0.0.1:${PORTA_PONTE}/ws`, poolHost: '127.0.0.1', poolPort: PORTA_POOL,
    identificador: 'TesteE2E', idTrabalhador: 2,
  } });
  const recusa = await achar((m) => m.tipo === 'estado' && m.estado === 'erro', 5000);
  ok('endereço inválido é barrado antes de falar com o pool', Boolean(recusa), recusa ? recusa.motivo : '');
  ok('nem tentou conectar com endereço inválido',
    !eventos.some((m) => m.tipo === 'log' && /conectado à ponte/.test(m.texto)));

  pool.fechar();
  try { ponte.kill(); } catch { /* já morreu */ }
}

// ---------------------------------------------------------------------------
// 5) AO VIVO no MoneroOcean (precisa de internet)
// ---------------------------------------------------------------------------
async function parte5() {
  secao('5) Ao vivo: gulf.moneroocean.stream:10001 (RandomX de verdade)');

  const PORTA_PONTE = 31000 + Math.floor(Math.random() * 5000);
  const eventos = [];
  globalThis.postMessage = (m) => {
    eventos.push(m);
    if (m.tipo === 'log' && (m.nivel === 'erro' || m.nivel === 'aviso')) {
      console.log(`     \x1b[90m[worker] ${m.texto}\x1b[0m`);
    }
  };
  const achar = (predicado, ms) => esperar(() => eventos.find(predicado), ms).catch(() => null);

  const ponte = await subirPonte(PORTA_PONTE);
  ok('ponte no ar para o teste ao vivo', Boolean(ponte), `porta ${PORTA_PONTE}`);

  globalThis.onmessage({ data: {
    tipo: 'iniciar', endereco: ENDERECO_ACEITO, senha: 'x',
    ponte: `ws://127.0.0.1:${PORTA_PONTE}/ws`,
    poolHost: 'gulf.moneroocean.stream', poolPort: 10001,
    identificador: 'TesteAoVivo', idTrabalhador: 9,
  } });

  const conectou = await achar((m) => m.tipo === 'estado' && m.estado === 'conectado', 40000);
  ok('login aceito pelo MoneroOcean', Boolean(conectou));

  const job = await achar((m) => m.tipo === 'job', 25000);
  ok('job real chegou', Boolean(job), job ? `dificuldade ≈ ${job.dificuldade}, altura ${job.altura}` : '');
  ok('a dificuldade do alvo bate com a do MoneroOcean (≈10000)',
    Boolean(job) && job.dificuldade > 5000 && job.dificuldade < 30000);
  ok('o pool está mandando rx/0', Boolean(job) && job.algo === 'rx/0', job ? job.algo : '');
  ok('RandomX inicializado com o epoch real do pool',
    eventos.some((m) => m.tipo === 'log' && /RandomX pronto em/.test(m.texto)));

  const progresso = await achar((m) => m.tipo === 'progresso' && m.hashrate > 0, 60000);
  ok('está minerando mesmo (hashrate > 0)', Boolean(progresso), progresso ? `${progresso.hashrate.toFixed(1)} H/s` : '');
  ok('o nonce está andando dentro do blob',
    eventos.some((m) => m.tipo === 'progresso' && m.nonce !== '00000000'));

  globalThis.onmessage({ data: { tipo: 'parar' } });
  try { ponte.kill(); } catch { /* já morreu */ }
}

// ---------------------------------------------------------------------------
// 6) NAVEGADOR DE VERDADE (--navegador): abre o Chrome/Edge headless na página
// servida pela ponte e confere o painel pelo protocolo do DevTools (CDP).
// É o único teste que exercita o caminho real do usuário: HTML + Web Worker +
// importScripts do WASM + WebSocket, e não o atalho do Node (require).
// ---------------------------------------------------------------------------
const CAMINHOS_DE_NAVEGADOR = [
  process.env.NAVEGADOR,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);

function acharNavegador() {
  for (const caminho of CAMINHOS_DE_NAVEGADOR) {
    try { if (fs.existsSync(caminho)) return caminho; } catch { /* segue tentando */ }
  }
  return null;
}

// Espera a porta de depuração abrir e devolve o WebSocket da aba
async function acharAba(porta, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const resposta = await fetch(`http://127.0.0.1:${porta}/json/list`);
      const abas = await resposta.json();
      const aba = abas.find((a) => a.type === 'page' && a.webSocketDebuggerUrl);
      if (aba) return aba.webSocketDebuggerUrl;
    } catch { /* ainda não subiu */ }
    if (Date.now() - t0 > ms) throw new Error('o navegador não abriu a porta de depuração');
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Cliente CDP mínimo: só o Runtime.evaluate basta para ler o painel
function falarComNavegador(urlWebSocket) {
  const ws = new WebSocket(urlWebSocket);
  const pendentes = new Map();
  let sequencia = 0;
  const pronto = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('não consegui falar com o navegador')));
  });
  ws.addEventListener('message', (evento) => {
    const msg = JSON.parse(evento.data);
    const esperando = pendentes.get(msg.id);
    if (esperando) { pendentes.delete(msg.id); esperando(msg); }
  });
  return {
    async avaliar(expressao) {
      await pronto;
      const id = ++sequencia;
      const resposta = await new Promise((resolve) => {
        pendentes.set(id, resolve);
        ws.send(JSON.stringify({
          id, method: 'Runtime.evaluate',
          params: { expression: expressao, returnByValue: true },
        }));
      });
      const r = resposta.result && resposta.result.result;
      return r ? r.value : undefined;
    },
    fechar() { try { ws.close(); } catch { /* já fechou */ } },
  };
}

async function parte6(portaPonte) {
  secao('6) Navegador de verdade (Chrome/Edge headless) — caminho do painel');

  const navegador = acharNavegador();
  if (!navegador) {
    console.log('  \x1b[90mpulado: não achei Chrome nem Edge (defina NAVEGADOR=<caminho do executável>)\x1b[0m');
    return;
  }
  console.log(`  \x1b[90musando: ${navegador}\x1b[0m`);

  const PORTA_CDP = 9333 + Math.floor(Math.random() * 400);
  const perfil = path.join(os.tmpdir(), `monero-teste-${PORTA_CDP}`);
  const url = `http://127.0.0.1:${portaPonte}/?auto=1&endereco=${ENDERECO_ACEITO}`
    + `&pool=gulf.moneroocean.stream:10001&ponte=ws://127.0.0.1:${portaPonte}/ws&trabalhadores=1`;

  const proc = spawn(navegador, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORTA_CDP}`, `--user-data-dir=${perfil}`, url,
  ], { stdio: 'ignore' });

  try {
    const aba = await acharAba(PORTA_CDP);
    const cdp = falarComNavegador(aba);
    ok('o navegador abriu a página servida pela ponte', true);

    // o painel escreve tudo em #log: esperamos o login e o RandomX prontos
    const registro = await esperarAsync(async () => {
      const texto = await cdp.avaliar("document.getElementById('log').innerText");
      return texto && /login aceito pelo pool/.test(texto) && /RandomX pronto em/.test(texto) ? texto : null;
    }, 120000);
    ok('o painel logou o login aceito pelo pool', /login aceito pelo pool/.test(registro));
    ok('o Worker montou o cache de 256 MB do RandomX no navegador', /RandomX pronto em/.test(registro));

    const estado = await cdp.avaliar("document.getElementById('estado').textContent");
    ok('o painel mostra "conectado"', /conectado/.test(String(estado)), String(estado));

    const hashrate = await esperarAsync(async () => {
      const texto = await cdp.avaliar("document.getElementById('hashrate').textContent");
      return texto && /[1-9]/.test(texto) ? texto : null;
    }, 60000);
    ok('o painel mostra hashrate de verdade', /[1-9]/.test(String(hashrate)), String(hashrate));

    const dificuldade = await cdp.avaliar("document.getElementById('dificuldade').textContent");
    ok('o painel mostra a dificuldade do job real', Number(String(dificuldade).replace(/\D/g, '')) > 1000, String(dificuldade));

    console.log('  \x1b[90m--- registro dentro do navegador (últimas linhas) ---\x1b[0m');
    for (const linha of String(registro).split('\n').slice(-6)) console.log(`  \x1b[90m${linha}\x1b[0m`);
    cdp.fechar();
  } finally {
    try { proc.kill(); } catch { /* já morreu */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// MODO CAÇADOR (--cacador <n>): um minerador de verdade por processo, rodando
// até o pool aprovar um share. O pai sobe 4 desses em paralelo (--share).
// ---------------------------------------------------------------------------
async function modoCacador(id) {
  const PORTA_PONTE = 41000 + id * 7 + Math.floor(Math.random() * 500);
  const ponte = await subirPonte(PORTA_PONTE);
  // anota o PID da ponte: se o pai matar este caçador, a ponte não pode ficar órfã
  const arquivoPid = path.join(os.tmpdir(), `monero-cacador-${id}.pid`);
  try { fs.writeFileSync(arquivoPid, String(ponte.pid)); } catch { /* sem problema */ }
  console.log(`[caçador ${id}] ponte na porta ${PORTA_PONTE} — minerando contra o MoneroOcean…`);

  globalThis.postMessage = (m) => {
    if (m.tipo === 'share' && m.aceito) {
      console.log(`\n[caçador ${id}] *** SHARE ACEITO PELO POOL *** (latência ${m.latencia} ms)`);
      try { ponte.kill(); } catch { /* já morreu */ }
      try { fs.unlinkSync(arquivoPid); } catch { /* já foi */ }
      process.exit(0);          // o pai entende o código 0 como "achamos"
    }
    if (m.tipo === 'log' && m.nivel === 'erro') console.error(`\n[caçador ${id}] erro: ${m.texto}`);
    if (m.tipo === 'log' && /deu alvo/.test(m.texto)) console.log(`\n[caçador ${id}] ${m.texto}`);
    if (m.tipo === 'progresso') {
      process.stdout.write(`\r[caçador ${id}] ${m.hashrate.toFixed(1)} H/s · dificuldade ${m.dificuldade}   `);
    }
  };

  globalThis.onmessage({ data: {
    tipo: 'iniciar', endereco: ENDERECO_ACEITO, senha: 'x',
    ponte: `ws://127.0.0.1:${PORTA_PONTE}/ws`,
    poolHost: 'gulf.moneroocean.stream', poolPort: 10001,
    identificador: `Cacador-${id}`, idTrabalhador: id + 1,
  } });
}

async function cacaLonga() {
  secao('Caçada: 4 mineradores até o MoneroOcean aceitar um share de verdade');
  console.log('  (com ~10 H/s por processo e dificuldade 10000, o esperado é de 1 a 10 minutos)');
  const filhos = [];
  for (let i = 0; i < 4; i++) {
    filhos.push(spawn(process.execPath, [__filename, '--cacador', String(i)], { stdio: 'inherit' }));
  }
  const venceu = await new Promise((resolve) => {
    const limite = setTimeout(() => resolve(false), 25 * 60 * 1000);
    for (const f of filhos) f.on('exit', (codigo) => { if (codigo === 0) { clearTimeout(limite); resolve(true); } });
  });
  for (const f of filhos) { try { f.kill(); } catch { /* já morreu */ } }
  // as pontes dos caçadores são netos deste processo: fecha pelos PIDs anotados
  for (let i = 0; i < 4; i++) {
    const arquivoPid = path.join(os.tmpdir(), `monero-cacador-${i}.pid`);
    try {
      const pid = Number(fs.readFileSync(arquivoPid, 'utf8'));
      if (pid) process.kill(pid);
      fs.unlinkSync(arquivoPid);
    } catch { /* já morreu ou nem existiu */ }
  }
  ok('um dos 4 mineradores achou um share e o pool aprovou', venceu);
}

// ---------------------------------------------------------------------------
// RODA TUDO
// ---------------------------------------------------------------------------
(async () => {
  if (MODO_CACADOR) { await modoCacador(ID_CACADOR); return; }

  const tamanhoRandomx = require('fs').statSync(path.join(PASTA, 'randomx-web.js')).size;
  console.log('\x1b[1mTestes do minerador de Monero (RandomX no navegador)\x1b[0m');
  console.log(`\x1b[90mrandomx-web.js: ${tamanhoRandomx} bytes · node ${process.version}\x1b[0m`);

  parte1();
  parte2();
  parte3();

  try { await parte4(); } catch (e) { ok('parte 4 (ponta a ponta local)', false, e.message); }

  if (OFFLINE) {
    console.log('\n\x1b[90m(--offline: a parte 5, contra o pool real, foi pulada)\x1b[0m');
  } else {
    try { await parte5(); } catch (e) { ok('parte 5 (ao vivo no MoneroOcean)', false, e.message); }
  }

  if (process.argv.includes('--navegador')) {
    if (OFFLINE) {
      console.log('\n\x1b[90m(--offline: a parte 6 também foi pulada, ela fala com o pool real)\x1b[0m');
    } else {
      const PORTA_PONTE_NAV = 35000 + Math.floor(Math.random() * 4000);
      let ponteDoNavegador = null;
      try {
        ponteDoNavegador = await subirPonte(PORTA_PONTE_NAV);
        await parte6(PORTA_PONTE_NAV);
      } catch (e) {
        ok('parte 6 (navegador de verdade)', false, e.message);
      } finally {
        if (ponteDoNavegador) { try { ponteDoNavegador.kill(); } catch { /* já morreu */ } }
      }
    }
  }

  if (process.argv.includes('--share')) {
    try { await cacaLonga(); } catch (e) { ok('caçada de share real', false, e.message); }
  }

  console.log(`\n\x1b[1m${passes} ok, ${falhas} falha(s)\x1b[0m`);
  process.exit(falhas === 0 ? 0 : 1);
})();

