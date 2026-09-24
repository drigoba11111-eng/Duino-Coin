/* =============================================================
   teste-githubpages.js — valida o minerador do GitHub Pages
   -------------------------------------------------------------
   1) núcleo SHA1 (DUCO-S1A) contra o crypto do Node;
   2) busca de nonce: acha o mesmo nonce que o duco-miner.js já validado;
   3) ponta a ponta: roda trabalhador.js DE VERDADE contra o gateway
      wss://magi.duinocoin.com:8443 e exige um share GOOD.
      (o WebSocketFalso abaixo imita o navegador, inclusive o header
      Origin — é ele que libera o handshake no Cloudflare do DUCO)

   Uso:  node ducoweb/github-pages/teste-githubpages.js [usuario]
   Requer Node.js 22+ (aqui o Node só faz o papel do navegador).
   ============================================================= */
'use strict';

const crypto = require('crypto');
const tls = require('tls');
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
// WebSocket mínimo com cara de navegador (só para o teste)
// =============================================================
const ORIGEM_FALSA = 'https://painel-de-teste.github.io';    // é isto que um navegador manda

class WebSocketFalso {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    this.buffer = Buffer.alloc(0);
    const m = /^wss:\/\/([^:/]+):(\d+)/.exec(url);
    if (!m) throw new Error('só wss:// com porta é suportado neste teste');
    this.sock = tls.connect({ host: m[1], port: Number(m[2]), servername: m[1] });
    this.sock.on('secureConnect', () => this.handshake(m[1], Number(m[2])));
    this.sock.on('data', (d) => this.receber(d));
    this.sock.on('error', (e) => { if (this.onerror) this.onerror(e); this.fecharLocal(); });
    this.sock.on('close', () => this.fecharLocal());
    this.sock.setTimeout(20000, () => this.sock.destroy());
  }

  handshake(host, porta) {
    const chave = crypto.randomBytes(16).toString('base64');
    this.sock.write([
      'GET / HTTP/1.1',
      `Host: ${host}:${porta}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${chave}`,
      'Sec-WebSocket-Version: 13',
      `Origin: ${ORIGEM_FALSA}`,
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36',
      '', '',
    ].join('\r\n'));
  }

  enviarFrame(texto) {
    const dados = Buffer.from(texto, 'utf8');
    const mascara = crypto.randomBytes(4);
    let cabecalho;
    if (dados.length < 126) {
      cabecalho = Buffer.from([0x81, 0x80 | dados.length]);
    } else if (dados.length < 65536) {
      cabecalho = Buffer.alloc(4);
      cabecalho[0] = 0x81; cabecalho[1] = 0x80 | 126;
      cabecalho.writeUInt16BE(dados.length, 2);
    } else {
      cabecalho = Buffer.alloc(10);
      cabecalho[0] = 0x81; cabecalho[1] = 0x80 | 127;
      cabecalho.writeBigUInt64BE(BigInt(dados.length), 2);
    }
    const mascarado = Buffer.alloc(dados.length);
    for (let i = 0; i < dados.length; i++) mascarado[i] = dados[i] ^ mascara[i % 4];
    this.sock.write(Buffer.concat([cabecalho, mascara, mascarado]));
  }

  send(texto) {
    if (this.readyState !== 1) throw new Error('socket não está aberto');
    this.enviarFrame(String(texto));
  }

  receber(pedaco) {
    this.buffer = Buffer.concat([this.buffer, pedaco]);
    if (!this.aberto) {                        // ainda falta a resposta HTTP do handshake
      const fim = this.buffer.indexOf('\r\n\r\n');
      if (fim < 0) return;
      const resposta = this.buffer.subarray(0, fim).toString('latin1');
      this.buffer = this.buffer.subarray(fim + 4);
      if (!/ 101 /.test(resposta)) {
        if (this.onerror) this.onerror(new Error(resposta.split('\r\n')[0]));
        this.sock.destroy();
        return;
      }
      this.aberto = true;
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }
    while (this.buffer.length >= 2) {
      const b1 = this.buffer[1];
      const mascarado = (b1 & 0x80) !== 0;
      let tamanho = b1 & 0x7f;
      let pos = 2;
      if (tamanho === 126) {
        if (this.buffer.length < pos + 2) return;
        tamanho = this.buffer.readUInt16BE(pos); pos += 2;
      } else if (tamanho === 127) {
        if (this.buffer.length < pos + 8) return;
        tamanho = Number(this.buffer.readBigUInt64BE(pos)); pos += 8;
      }
      const inicio = pos + (mascarado ? 4 : 0);
      if (this.buffer.length < inicio + tamanho) return;
      const dados = this.buffer.subarray(inicio, inicio + tamanho);
      const opcode = this.buffer[0] & 0x0f;
      this.buffer = this.buffer.subarray(inicio + tamanho);

      if (opcode === 0x1 && this.readyState === 1 && this.onmessage) {
        this.onmessage({ data: dados.toString('utf8') });
      } else if (opcode === 0x8) {                 // fechamento pedido pelo servidor
        this.sock.end();
      }
      // ping/pong: o navegador responde sozinho; no teste podemos ignorar
    }
  }

  close() {
    if (this.readyState === 1) {
      try { this.sock.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); } catch { /* já foi */ }
    }
    this.readyState = 2;
    setTimeout(() => this.sock.destroy(), 200);
  }

  fecharLocal() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1006 });
  }
}
// =============================================================
// Carrega o trabalhador.js real (o mesmo arquivo que o navegador usa)
// =============================================================
const recebidas = [];
globalThis.WebSocket = WebSocketFalso;
globalThis.postMessage = (msg) => recebidas.push(msg);

const trabalhador = require('./trabalhador.js');
const { sha1Hex, criarBuscador, palavrasDoHex } = trabalhador;

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
// 2) A busca de nonce encontra o nonce que o DUCO espera?
//    (mesma regra do duco-miner.js validado: sha1(lastBlockHash + nonce))
// =============================================================
console.log('\n— 2) Busca de nonce (mesma regra do duco-miner.js) —');
let achados = 0;
for (let i = 0; i < 60; i++) {
  const prefixo = crypto.randomBytes(20).toString('hex');          // 40 chars, como no job real
  const nonceCerto = Math.floor(Math.random() * 500000);
  const hashCerto = sha1Node(prefixo + nonceCerto);
  if (criarBuscador(prefixo).procurar(palavrasDoHex(hashCerto), 0, nonceCerto + 1) === nonceCerto) achados++;
}
ok(achados === 60, `60 jobs gerados aleatoriamente resolvidos: ${achados}/60`);

const exemplo = { prefixo: '8a1d5f0b3c7e9d2a4f6b8c0e1d3f5a7b9c1e3d5f', nonce: 12345 };
exemplo.hash = sha1Node(exemplo.prefixo + exemplo.nonce);
ok(criarBuscador(exemplo.prefixo).procurar(palavrasDoHex(exemplo.hash), 0, 20000) === exemplo.nonce,
  `job de exemplo: nonce ${exemplo.nonce} encontrado (hash ${exemplo.hash.slice(0, 12)}...)`);
ok(criarBuscador(exemplo.prefixo).procurar(palavrasDoHex('0'.repeat(40)), 0, 5000) === -1,
  'hash impossível: devolve -1 (nunca inventa nonce)');



// =============================================================
// 3) Ponta a ponta: o trabalhador de verdade contra o gateway oficial
// =============================================================
console.log('\n— 3) Ponta a ponta com wss://magi.duinocoin.com:8443 —');
const usuario = (process.argv[2] || 'duco').trim();
console.log(`   usuário de teste: ${usuario} | Origin enviado: ${ORIGEM_FALSA}`);

const resumo = { versao: null, jobs: 0, good: 0, bad: 0, hashrate: 0, ultimo: null };
const inicio = Date.now();

const enviarAoWorker = () => globalThis.onmessage({
  data: {
    tipo: 'iniciar',
    usuario,
    minerKey: 'None',
    dificuldade: 'LOW',
    identificador: 'GitHubPages-Teste',
    endpoint: 'wss://magi.duinocoin.com:8443',
    idTrabalhador: 1,
  },
});

function acompanhar(msg) {
  if (msg.tipo === 'log') {
    if (/versão/.test(msg.texto)) resumo.versao = msg.texto.replace(/.*versão /, '');
    console.log(`   • ${msg.texto}`);
  }
  if (msg.tipo === 'job') {
    resumo.jobs++;
    resumo.ultimo = msg;
    resumo.hashrate = msg.hashrateDoJob || msg.hashrate || 0;
    console.log(`   • job ${resumo.jobs}: dificuldade ${msg.difficulty} | nonce ${msg.nonce}`
      + ` | latência ${msg.latencia} ms | ${Math.round(resumo.hashrate)} H/s`);
  }
  if (msg.tipo === 'share') {
    if (msg.aceito) resumo.good++; else resumo.bad++;
    console.log(`   • share ${msg.aceito ? 'GOOD ✅' : 'BAD ❌'}${msg.saldo !== null && msg.saldo !== undefined ? ` (saldo ${msg.saldo} DUCO)` : ''}`);
  }
}

const original = globalThis.postMessage;
globalThis.postMessage = (msg) => { original(msg); acompanhar(msg); };

enviarAoWorker();

const limiteMs = 90000;
const vigia = setInterval(() => {
  if (resumo.good > 0 || Date.now() - inicio > limiteMs) {
    clearInterval(vigia);
    globalThis.onmessage({ data: { tipo: 'parar' } });

    ok(Boolean(resumo.versao), `gateway respondeu a versão do servidor: ${resumo.versao}`);
    ok(resumo.jobs >= 1, `job real recebido e resolvido (${resumo.jobs} job(s))`);
    ok(resumo.good >= 1, `share aceito pelo servidor (GOOD: ${resumo.good}, BAD: ${resumo.bad})`);
    ok(resumo.hashrate > 1000, `hashrate medido no navegador/Node: ${Math.round(resumo.hashrate)} H/s`);
    if (resumo.ultimo && resumo.ultimo.latencia !== undefined) {
      ok(resumo.ultimo.latencia >= 0 && resumo.ultimo.latencia < 15000,
        `latência do gateway medida: ${resumo.ultimo.latencia} ms`);
    }

    console.log(`\n${falhas === 0 ? '✅' : '❌'} ${provas - falhas}/${provas} verificações passaram`
      + ` — ${falhas} falha(s)`);
    process.exit(falhas === 0 ? 0 : 1);
  }
}, 200);

