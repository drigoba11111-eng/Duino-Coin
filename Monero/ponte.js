/* ============================================================================
 * ponte.js — Monero: ponte local entre o navegador (WebSocket) e o pool (TCP)
 *
 *   node ponte.js [porta]      (padrão 8080 — env: PONTE_PORTA / PONTE_HOST / PONTE_POOL)
 *
 * Por que isso existe?
 *   O minerador roda no navegador, e o navegador não abre conexão TCP crua — só
 *   HTTP/WebSocket. O stratum dos pools de Monero (MoneroOcean, SupportXMR, ...)
 *   é JSON-RPC 2.0 sobre TCP. Esta ponte faz as duas coisas:
 *
 *     1) serve a página localmente (index.html, trabalhador.js, randomx-web.js);
 *     2) na rota /ws ela é um "cano": cada mensagem de texto que o Web Worker
 *        manda vira uma linha no socket TCP do pool, e cada linha que o pool
 *        responde volta como mensagem de texto para o Worker.
 *
 *   Ela NÃO entende stratum: não reescreve, não valida e não inventa mensagem —
 *   só repassa bytes de ida e volta. É o mesmo papel que o webminerpool fazia,
 *   mas aqui o RandomX roda no navegador (WebAssembly), não no servidor.
 *
 *   Uso:
 *     node ponte.js                      -> http://127.0.0.1:8080
 *     node ponte.js 9000                 -> http://127.0.0.1:9000
 *     PONTE_HOST=0.0.0.0 node ponte.js   -> expõe na rede (leia o aviso abaixo!)
 *
 *   Endereço do WebSocket: ws://127.0.0.1:8080/ws?pool=host:porta
 *   (o pool vem no parâmetro "pool"; sem ele, usa PONTE_POOL ou o padrão)
 *
 * Sem dependências externas — só o Node (http, net, crypto, fs).
 * ==========================================================================*/
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASTA = __dirname;
const HOST = process.env.PONTE_HOST || '127.0.0.1';
const PORTA = Number(process.env.PONTE_PORTA || process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 8080);
const POOL_PADRAO = process.env.PONTE_POOL || 'gulf.moneroocean.stream:10001';
const SEM_ABRIR = !!process.env.PONTE_SEM_ABRIR;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Só estes três arquivos são servidos (nada de listar pasta nem ler fora daqui)
const PERMITIDOS = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/trabalhador.js': 'trabalhador.js',
  '/randomx-web.js': 'randomx-web.js',
};
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// ---------- registro bonitinho no console ----------
const CORES = { info: '\x1b[36m', ok: '\x1b[32m', aviso: '\x1b[33m', erro: '\x1b[31m', cinza: '\x1b[90m' };
function log(texto, nivel = 'info') {
  const hora = new Date().toTimeString().slice(0, 8);
  console.log(`${CORES[nivel] || ''}[${hora}] ${texto}\x1b[0m`);
}

// =============================================================
// 1) SERVIDOR HTTP — entrega a página (mesma pasta deste arquivo)
// =============================================================
const servidor = http.createServer((req, res) => {
  let caminho;
  try {
    caminho = new URL(req.url, `http://${HOST}:${PORTA}`).pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 — requisição malformada');
  }

  const arquivo = PERMITIDOS[caminho];
  if (!arquivo) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 — a ponte só serve: / , /trabalhador.js e /randomx-web.js');
  }

  try {
    const conteudo = fs.readFileSync(path.join(PASTA, arquivo));
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
      'Content-Length': conteudo.length,
      'Cache-Control': 'no-store',           // página em desenvolvimento: nunca cacheia
    });
    res.end(conteudo);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 — não consegui ler ${arquivo}: ${e.message}`);
  }
});

// =============================================================
// 2) CANAL WEBSOCKET — RFC 6455 mínimo (sem dependências)
// Só o necessário: texto em JSON-RPC, ping/pong e close.
// É o mesmo esqueleto usado no painel do DUCO (ducoweb/bridge.js), com uma
// diferença: aqui o texto NÃO é interpretado — vai cru para o pool.
// =============================================================
class Canal {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);          // acumulador de bytes do cliente
    this.aoTexto = () => {};
    this.aoFechar = () => {};
    this.fechado = false;
    sock.on('data', (d) => this.receber(d));
    sock.on('close', () => this.aoFechar());
    sock.on('error', () => this.aoFechar());
  }

  // Monta um frame (servidor -> cliente: sem máscara)
  quadro(op, dados) {
    if (this.fechado) return;
    const payload = Buffer.isBuffer(dados) ? dados : Buffer.from(dados || '');
    const cabecalho = [0x80 | op];
    if (payload.length < 126) {
      cabecalho.push(payload.length);
    } else if (payload.length < 65536) {
      cabecalho.push(126, payload.length >> 8, payload.length & 0xff);
    } else {
      const tamanho = Buffer.alloc(8);
      tamanho.writeBigUInt64BE(BigInt(payload.length));
      cabecalho.push(127, ...tamanho);
    }
    try {
      this.sock.write(Buffer.concat([Buffer.from(cabecalho), payload]));
    } catch { /* socket já foi embora */ }
  }

  // Texto sem JSON.stringify: o conteúdo JÁ é a linha stratum pronta
  textoCru(linha) { this.quadro(0x1, linha); }

  fechar() {
    if (this.fechado) return;
    this.fechado = true;
    try { this.quadro(0x8, ''); } catch { /* já fechado */ }
    try { this.sock.end(); } catch { /* já fechado */ }
  }

  // Lê o que vem do cliente (frames do cliente sempre vêm mascarados)
  receber(dados) {
    this.buf = Buffer.concat([this.buf, dados]);
    while (this.buf.length >= 2) {
      const b1 = this.buf[1];
      const op = this.buf[0] & 0x0f;
      const mascarado = (b1 & 0x80) !== 0;
      let tam = b1 & 0x7f;
      let pos = 2;
      if (tam === 126) {
        if (this.buf.length < 4) return;
        tam = this.buf.readUInt16BE(2); pos = 4;
      } else if (tam === 127) {
        if (this.buf.length < 10) return;
        tam = Number(this.buf.readBigUInt64BE(2)); pos = 10;
      }
      const posMascara = pos;
      if (mascarado) pos += 4;
      if (this.buf.length < pos + tam) return;   // frame incompleto: aguarda o resto
      const corpo = Buffer.from(this.buf.subarray(pos, pos + tam));
      if (mascarado) {
        const mascara = this.buf.subarray(posMascara, posMascara + 4);
        for (let i = 0; i < corpo.length; i++) corpo[i] ^= mascara[i % 4];
      }
      this.buf = this.buf.subarray(pos + tam);

      if (op === 0x8) { this.aoFechar(); return; }            // close
      if (op === 0x9) { this.quadro(0xa, corpo); continue; }   // ping -> pong
      if (op === 0xa) continue;                                // pong
      if (op === 0x1) this.aoTexto(corpo.toString('utf8'));    // linha stratum do Worker
    }
  }
}
// =============================================================
// 3) A PONTE: /ws?pool=host:porta  ->  TCP host:porta
// =============================================================
function anotar(txt, direcao) {
  // Só para o log do terminal: mostra o nome do método JSON-RPC que passou.
  try {
    const j = JSON.parse(txt);
    let rotulo = j.method;
    if (!rotulo && j.error) rotulo = `erro: ${String((j.error && j.error.message) || j.error).slice(0, 60)}`;
    if (!rotulo && j.result && j.result.job) rotulo = 'login (job recebido)';
    if (!rotulo && j.result && j.result.status) rotulo = `resposta: ${j.result.status}`;
    if (!rotulo) rotulo = 'resposta';
    log(`  ${direcao} ${j.id !== undefined ? `id=${j.id} ` : ''}${rotulo}`, 'cinza');
  } catch { /* não é JSON (o pool às vezes manda lixo): só repassa */ }
}

servidor.on('upgrade', (req, sock) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORTA}`);
  } catch {
    return sock.destroy();
  }
  const chave = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !chave) {
    sock.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return sock.destroy();
  }

  // ---- valida o pool ANTES de aceitar (evita a ponte virar proxy genérico) ----
  const poolBruto = url.searchParams.get('pool') || POOL_PADRAO;
  const alvo = /^([A-Za-z0-9.\-]+):(\d{1,5})$/.exec(poolBruto);
  const portaPool = alvo ? Number(alvo[2]) : 0;
  if (!alvo || portaPool < 1 || portaPool > 65535) {
    log(`pool inválido recusado: "${poolBruto}"`, 'erro');
    sock.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    return sock.destroy();
  }
  const hostPool = alvo[1];

  // ---- handshake WebSocket ----
  const aceite = crypto.createHash('sha1').update(chave + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${aceite}\r\n\r\n`);
  sock.setNoDelay(true);

  const canal = new Canal(sock);
  const tcp = net.connect(portaPool, hostPool);
  tcp.setNoDelay(true);
  let bufferTcp = '';
  let linhasCliente = 0;

  log(`worker conectado — abrindo ${hostPool}:${portaPool}`, 'info');
  tcp.on('connect', () => log(`pool ${hostPool}:${portaPool} conectado (stratum/TCP)`, 'ok'));

  // pool -> navegador (uma linha por mensagem de texto)
  tcp.on('data', (d) => {
    bufferTcp += d.toString('utf8');
    let i;
    while ((i = bufferTcp.indexOf('\n')) >= 0) {
      const linha = bufferTcp.slice(0, i).replace(/\r$/, '');
      bufferTcp = bufferTcp.slice(i + 1);
      if (!linha.trim()) continue;
      anotar(linha, 'pool →');
      canal.textoCru(linha);
    }
  });

  tcp.on('error', (e) => {
    log(`erro no TCP do pool: ${e.message}`, 'erro');
    canal.fechar();
  });
  tcp.on('close', () => {
    log('o pool fechou a conexão', 'aviso');
    canal.fechar();
  });

  // navegador -> pool (cada mensagem virou uma linha; o stratum termina em \n)
  canal.aoTexto = (texto) => {
    linhasCliente++;
    anotar(texto, '→ pool');
    tcp.write(texto + '\n');
  };
  canal.aoFechar = () => {
    log(`worker desconectado (${linhasCliente} mensagem(ns) enviadas)`, 'cinza');
    try { tcp.destroy(); } catch { /* já fechado */ }
  };
});

// =============================================================
// 4) SOBE A PONTE
// =============================================================
servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`a porta ${PORTA} já está em uso — feche o outro programa ou use: node ponte.js 9000`, 'erro');
  } else {
    log(`falha ao subir a ponte: ${e.message}`, 'erro');
  }
  process.exit(1);
});

servidor.listen(PORTA, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORTA}`;
  console.log('');
  log('⛏  Ponte Monero no ar', 'ok');
  log(`   página ......... ${url}  (abra no navegador)`, 'info');
  log(`   WebSocket ...... ws://${HOST}:${PORTA}/ws?pool=<host>:<porta>`, 'info');
  log(`   pool padrão .... ${POOL_PADRAO}`, 'info');
  log('   parar ......... Ctrl+C', 'cinza');
  if (HOST !== '127.0.0.1') {
    log('   ATENÇÃO: PONTE_HOST fora de 127.0.0.1 = qualquer um na rede pode usar sua', 'aviso');
    log('   ponte como proxy TCP. Use só em rede confiável e nunca exponha na internet.', 'aviso');
  }
  console.log('');
  console.log('PONTE PRONTA');   // marcador usado pelos testes automatizados

  if (!SEM_ABRIR && process.platform === 'win32') {
    // mesma conveniência do painel do DUCO: no Windows já abre o navegador
    try { require('child_process').exec(`start "" "${url}"`); } catch { /* sem problema */ }
  }
});

