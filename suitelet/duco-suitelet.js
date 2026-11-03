/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
import * as log from 'N/log';
import * as http from 'N/http';
import * as runtime from 'N/runtime';

var API_OFICIAL = 'https://server.duinocoin.com';
var USER_AGENT = 'DuinoCoin-Suitelet/1.0 (SuiteScript 2.1)';
var MAX_MS_PADRAO = 2000;
var MAX_MS_TETO = 5000;
var UNIDADES_RESERVADAS = 200;
var HEX40 = /^[0-9a-fA-F]{40}$/;

function texto(v) {
  return v === null || v === undefined ? '' : String(v);
}

function erro(mensagem) {
  log.error({ title: 'duco-suitelet', details: mensagem });
  return { sucesso: false, erro: mensagem };
}

function comoObjeto(valor) {
  if (valor && typeof valor === 'object') return valor;
  if (typeof valor === 'string' && valor.charAt(0) === '{') {
    try { return JSON.parse(valor); } catch (e) { return null; }
  }
  return null;
}

function parametrosDe(request) {
  var params = {};
  var qs = request && request.parameters ? request.parameters : {};
  for (var k in qs) {
    if (Object.prototype.hasOwnProperty.call(qs, k)) params[k] = qs[k];
  }
  var corpo = comoObjeto(request ? request.body : null);
  if (corpo) {
    for (var c in corpo) {
      if (Object.prototype.hasOwnProperty.call(corpo, c)) params[c] = corpo[c];
    }
  }
  return params;
}

function montarUrl(caminho, params) {
  var url = API_OFICIAL + caminho;
  var partes = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === null || v === undefined || typeof v === 'object') continue;
    partes.push(encodeURIComponent(k) + '=' + encodeURIComponent(texto(v)));
  }
  if (partes.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + partes.join('&');
  return url;
}

function interpretarResposta(resposta) {
  var corpo = resposta ? resposta.body : null;
  try {
    return { http: resposta.code, dados: JSON.parse(corpo) };
  } catch (e) {
    return {
      http: resposta ? resposta.code : 0,
      dados: { sucesso: false, erro: 'resposta inesperada da API oficial (' +
        (resposta ? resposta.code : 'sem resposta') + ')' },
    };
  }
}

function getOficial(caminho, params) {
  var resposta = http.get({
    url: montarUrl(caminho, params || {}),
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  });
  return interpretarResposta(resposta);
}

function proxy(caminho, metodo, params) {
  if (!caminho) return erro('proxy precisa de "caminho" (ex.: /statistics)');
  if (caminho.charAt(0) !== '/' && caminho.charAt(0) !== '?') caminho = '/' + caminho;
  var upstream = {};
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    if (k === 'acao' || k === 'action' || k === 'caminho' || k === 'metodo') continue;
    upstream[k] = params[k];
  }
  if (texto(metodo).toUpperCase() === 'POST') {
    var respostaPost = http.post({
      url: montarUrl(caminho, {}),
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json',
                 'Accept': 'application/json' },
      body: JSON.stringify(upstream),
    });
    return interpretarResposta(respostaPost).dados;
  }
  return getOficial(caminho, upstream).dados;
}

var H0 = 0x67452301;
var H1 = 0xefcdab89 | 0;
var H2 = 0x98badcfe | 0;
var H3 = 0x10325476;
var H4 = 0xc3d2e1f0 | 0;

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) | 0;
}

function comprimir(bloco, W, a, b, c, d, e) {
  var a0 = a; var b0 = b; var c0 = c; var d0 = d; var e0 = e;
  var i; var t;
  for (i = 0; i < 16; i++) {
    W[i] = (bloco[i * 4] << 24) | (bloco[i * 4 + 1] << 16) |
           (bloco[i * 4 + 2] << 8) | bloco[i * 4 + 3];
  }
  for (i = 16; i < 80; i++) {
    var x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
    W[i] = (x << 1) | (x >>> 31);
  }
  for (i = 0; i < 20; i++) {
    t = (rotl(a, 5) + ((b & c) | (~b & d)) + e + W[i] + 0x5a827999) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  for (i = 20; i < 40; i++) {
    t = (rotl(a, 5) + (b ^ c ^ d) + e + W[i] + 0x6ed9eba1) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  for (i = 40; i < 60; i++) {
    t = (rotl(a, 5) + ((b & c) | (b & d) | (c & d)) + e + W[i] + 0x8f1bbcdc) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  for (i = 60; i < 80; i++) {
    t = (rotl(a, 5) + (b ^ c ^ d) + e + W[i] + 0xca62c1d6) | 0;
    e = d; d = c; c = rotl(b, 30); b = a; a = t;
  }
  a = (a + a0) | 0; b = (b + b0) | 0; c = (c + c0) | 0;
  d = (d + d0) | 0; e = (e + e0) | 0;
  return [a, b, c, d, e];
}

function hex8(v) {
  var s = (v >>> 0).toString(16);
  while (s.length < 8) s = '0' + s;
  return s;
}

function sha1Hex(textoAscii) {
  var total = textoAscii.length;
  var blocos = Math.ceil((total + 9) / 64);
  var a = H0; var b = H1; var c = H2; var d = H3; var e = H4;
  var W = new Array(80);
  for (var i = 0; i < blocos; i++) {
    var bloco = new Array(64);
    var inicio = i * 64;
    var j;
    for (j = 0; j < 64; j++) {
      var idx = inicio + j;
      bloco[j] = idx < total ? textoAscii.charCodeAt(idx) & 0xff : 0;
    }
    var posTermo = total - inicio;
    if (posTermo >= 0 && posTermo < 64) bloco[posTermo] = 0x80;
    if (i === blocos - 1) {
      var bits = total * 8;
      bloco[60] = (bits >>> 24) & 0xff; bloco[61] = (bits >>> 16) & 0xff;
      bloco[62] = (bits >>> 8) & 0xff;  bloco[63] = bits & 0xff;
    }
    var h = comprimir(bloco, W, a, b, c, d, e);
    a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4];
  }
  return hex8(a) + hex8(b) + hex8(c) + hex8(d) + hex8(e);
}

function palavrasDoHex(hex) {
  if (typeof hex !== 'string' || !HEX40.test(hex)) return null;
  var p = new Array(5);
  for (var i = 0; i < 5; i++) p[i] = parseInt(hex.substr(i * 8, 8), 16) | 0;
  return p;
}

function criarBuscador(prefixoHex) {
  if (!HEX40.test(texto(prefixoHex))) {
    throw new Error('lastBlockHash inválido no job (esperado 40 caracteres hex)');
  }
  var bloco = new Array(64);
  var i;
  for (i = 0; i < 64; i++) bloco[i] = 0;
  for (i = 0; i < 40; i++) bloco[i] = prefixoHex.charCodeAt(i);
  var W = new Array(80);
  var digitos = 0;

  function escreverNonce(n) {
    var q = n;
    var feitos = 0;
    if (q === 0) { bloco[40] = 48; return 1; }
    while (q > 0) { bloco[40 + feitos] = 48 + (q % 10); q = (q / 10) | 0; feitos++; }
    for (var x = 0, y = feitos - 1; x < y; x++, y--) {
      var t = bloco[40 + x]; bloco[40 + x] = bloco[40 + y]; bloco[40 + y] = t;
    }
    return feitos;
  }

  function procurar(alvo, inicio, fim, limites) {
    var t0 = Date.now();
    var maxMs = limites && limites.maxMs ? limites.maxMs : MAX_MS_PADRAO;
    var unidadesMinimas = limites && typeof limites.unidadesMinimas === 'number'
      ? limites.unidadesMinimas : UNIDADES_RESERVADAS;
    function unidadesOk() {
      try {
        return runtime.getCurrentScript().getRemainingUsage() > unidadesMinimas;
      } catch (e) {
        return true;
      }
    }

    var esgotado = null;
    var testados = 0;
    var n;
    for (n = inicio; n < fim; n++) {
      var d = escreverNonce(n);
      bloco[40 + d] = 0x80;
      if (d !== digitos) {
        digitos = d;
        var bits = (40 + d) * 8;
        bloco[60] = (bits >>> 24) & 0xff; bloco[61] = (bits >>> 16) & 0xff;
        bloco[62] = (bits >>> 8) & 0xff;  bloco[63] = bits & 0xff;
      }
      var h = comprimir(bloco, W, H0, H1, H2, H3, H4);
      testados++;
      if (h[0] === alvo[0] && h[1] === alvo[1] && h[2] === alvo[2] &&
          h[3] === alvo[3] && h[4] === alvo[4]) {
        return { nonce: n, testados: testados, esgotado: null };
      }
      if ((n & 1023) === 0) {
        if (Date.now() - t0 >= maxMs) { esgotado = 'tempo'; break; }
        if (!unidadesOk()) { esgotado = 'unidades'; break; }
      }
    }
    if (!esgotado && n >= fim) esgotado = 'nonce';
    return { nonce: -1, testados: testados, esgotado: esgotado };
  }

  return { procurar: procurar };
}

function minerar(p) {
  var prefixo = texto(p.lastBlockHash).trim();
  var hashEsperado = texto(p.hashEsperado || p.hash).trim();
  if (!HEX40.test(prefixo)) return erro('lastBlockHash inválido (40 hex esperado)');
  if (!HEX40.test(hashEsperado)) return erro('hashEsperado inválido (40 hex esperado)');

  var dificuldade = Number(p.dificuldade);
  if (!isFinite(dificuldade) || dificuldade <= 0) return erro('dificuldade inválida');
  var limite = 100 * dificuldade + 1;
  var inicio = Number(p.inicio);
  if (!isFinite(inicio) || inicio < 0) inicio = 0;
  if (inicio >= limite) return erro('inicio maior que o limite do job (100 × dificuldade + 1)');

  var maxMs = Number(p.maxMs);
  if (!isFinite(maxMs) || maxMs <= 0) maxMs = MAX_MS_PADRAO;
  if (maxMs > MAX_MS_TETO) maxMs = MAX_MS_TETO;

  var alvo = palavrasDoHex(hashEsperado);
  if (!alvo) return erro('hashEsperado inválido (40 hex esperado)');

  var t0 = Date.now();
  var resultado;
  try {
    resultado = criarBuscador(prefixo).procurar(alvo, inicio, limite, { maxMs: maxMs });
  } catch (e) {
    return erro('falha ao buscar nonce: ' + (e.message || e));
  }
  var ms = Math.max(1, Date.now() - t0);
  var testados = resultado.testados;

  var saida = {
    sucesso: true,
    encontrado: resultado.nonce >= 0,
    nonce: resultado.nonce,
    hash: resultado.nonce >= 0 ? sha1Hex(prefixo + resultado.nonce) : null,
    dificuldade: dificuldade,
    limite: limite,
    inicio: inicio,
    testados: testados,
    proximo: resultado.nonce >= 0 ? null : inicio + testados,
    esgotado: resultado.esgotado,
    tempoMs: ms,
    hashrate: Math.round(testados / (ms / 1000)),
  };
  if (saida.esgotado === 'nonce') saida.encontrado = false;
  log.debug({ title: 'duco-suitelet:minerar', details: JSON.stringify(saida) });
  return saida;
}

function verificar(p) {
  var prefixo = texto(p.lastBlockHash).trim();
  var hashEsperado = texto(p.hashEsperado || p.hash).trim();
  var nonce = texto(p.nonce).trim();
  if (!HEX40.test(prefixo)) return erro('lastBlockHash inválido (40 hex esperado)');
  if (!HEX40.test(hashEsperado)) return erro('hashEsperado inválido (40 hex esperado)');
  if (!/^\d+$/.test(nonce)) return erro('nonce deve ser um inteiro decimal');
  var hash = sha1Hex(prefixo + nonce);
  return {
    sucesso: true,
    valido: hash.toLowerCase() === hashEsperado.toLowerCase(),
    hash: hash,
    esperado: hashEsperado,
  };
}

function converter(p) {
  var duco = Number(p.duco);
  var preco = Number(p.preco);
  var cambio = Number(p.cambio);
  var taxa = Number(p.taxa);
  if (!isFinite(duco) || duco < 0) return erro('duco inválido');
  if (!isFinite(preco) || preco < 0) return erro('preco inválido');
  if (!isFinite(cambio) || cambio < 0) return erro('cambio inválido');
  if (!isFinite(taxa) || taxa < 0 || taxa > 100) return erro('taxa inválida (0 a 100)');
  var brutoUsd = duco * preco;
  var liquidoUsd = brutoUsd * (1 - taxa / 100);
  return {
    sucesso: true, duco: duco, precoUsd: preco, brutoUsd: brutoUsd,
    liquidoUsd: liquidoUsd, liquidoBrl: liquidoUsd * cambio,
    cambioUsdBrl: cambio, taxaPercentual: taxa,
  };
}

function exigir(p, nomes) {
  for (var i = 0; i < nomes.length; i++) {
    if (texto(p[nomes[i]]).trim() === '') return 'parâmetro obrigatório ausente: ' + nomes[i];
  }
  return null;
}

function rotear(p) {
  var acao = texto(p.acao || p.action || '').toLowerCase();
  switch (acao) {
    case 'minerar':
      return minerar(p);
    case 'verificar':
      return verificar(p);
    case 'converter':
      return converter(p);
    case 'proxy':
      return proxy(texto(p.caminho), p.metodo || 'GET', p);
    case 'saldo':
    case 'balance': {
      var faltou = exigir(p, ['usuario']);
      if (faltou) return erro(faltou);
      return getOficial('/balances/' + encodeURIComponent(texto(p.usuario).trim()), {}).dados;
    }
    case 'estatisticas':
    case 'statistics':
      return getOficial('/statistics', {}).dados;
    case 'preco':
    case 'price': {
      var stats = getOficial('/statistics', {}).dados;
      var preco = stats ? stats['Duco price'] : undefined;
      if (preco === undefined) return erro('não consegui ler o preço em /statistics');
      return { sucesso: true, precoUsd: preco };
    }
    case 'ajuda':
    case 'help':
      return {
        sucesso: true,
        acoes: {
          'POST acao=minerar&lastBlockHash&hashEsperado&dificuldade[&inicio&maxMs]':
            'resolve o nonce na nuvem (use "proximo" para fatiar)',
          'GET acao=verificar&lastBlockHash&hashEsperado&nonce': 'valida um nonce',
          'GET acao=saldo&usuario': 'saldo (/balances/<u>)',
          'GET acao=estatisticas': 'estatísticas (/statistics)',
          'GET acao=preco': 'preço do DUCO em US$',
          'GET acao=converter&duco&preco&cambio&taxa': 'DUCO -> US$ -> R$',
          'GET|POST acao=proxy&caminho': 'proxy de qualquer endpoint oficial',
        },
        aviso: 'A parte TCP (WebSocket) roda no NAVEGADOR; aqui só entra o ' +
          'processamento do nonce (POST acao=minerar) e consultas HTTP.',
      };
    default:
      return erro('ação desconhecida: "' + acao + '" — veja ?acao=ajuda');
  }
}

function paginaHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Duino-Coin — Suitelet (processamento em nuvem)</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="bg-dark text-light">
<div class="container py-4">
<h1 class="h3 mb-1">⛏️ Duino-Coin <span class="text-secondary fs-5">— Suitelet híbrido</span></h1>
<p class="text-secondary">
A <b>parte TCP</b> (WebSocket <code>wss://magi.duinocoin.com:8443</code>) roda neste navegador.
O <b>processamento do nonce</b> (DUCO-S1A) volta para o Suitelet, na nuvem, via <code>POST acao=minerar</code>.
Vários trabalhadores disparam POSTs concorrentes — é a <b>paralelização</b>.
</p>
<div class="row g-3">
  <div class="col-md-6">
    <div class="card bg-black border-secondary"><div class="card-body">
      <h2 class="h6">Configuração</h2>
      <div class="mb-2"><label class="form-label">Usuário DUCO</label>
        <input id="usuario" class="form-control form-control-sm" placeholder="sua carteira"></div>
      <div class="mb-2"><label class="form-label">Miner key (ou vazio)</label>
        <input id="chave" class="form-control form-control-sm" placeholder="None"></div>
      <div class="mb-2"><label class="form-label">Dificuldade</label>
        <select id="dificuldade" class="form-select form-select-sm">
          <option>LOW</option><option selected>MEDIUM</option><option>NET</option><option>EXTREME</option>
        </select></div>
      <div class="mb-2"><label class="form-label">Trabalhadores (paralelismo no navegador)</label>
        <input id="workers" type="number" class="form-control form-control-sm" value="4" min="1" max="32"></div>
      <div class="mb-3"><label class="form-label">maxMs por POST na nuvem</label>
        <input id="maxMs" type="number" class="form-control form-control-sm" value="2000" min="200" max="5000"></div>
      <button id="iniciar" class="btn btn-primary btn-sm">▶ Iniciar</button> 
      <button id="parar" class="btn btn-outline-danger btn-sm" disabled>■ Parar</button>
    </div></div>
  </div>
  <div class="col-md-6">
    <div class="card bg-black border-secondary"><div class="card-body">
      <h2 class="h6">Estatísticas</h2>
      <ul class="list-unstyled mb-0">
        <li>Conexões ativas: <b id="conexoes">0</b></li>
        <li>Shares aceitos: <b id="aceitos" class="text-success">0</b></li>
        <li>Shares recusados: <b id="recusados" class="text-danger">0</b></li>
        <li>Hashrate (nuvem, somado): <b id="hashrate">0</b> H/s</li>
        <li>Saldo: <b id="saldo">—</b></li>
        <li>Preço DUCO: <b id="preco">—</b></li>
      </ul>
    </div></div>
  </div>
</div>
<h2 class="h6 mt-4">Registro</h2>
<pre id="log" class="bg-black border border-secondary rounded p-2 small" style="height:220px;overflow:auto"></pre>
<p class="text-secondary small mt-3">Didático. O DUCO-S1A é pesado para um Suitelet: o Kolka pune hashrate alto e há limites de concorrência/usage units no NetSuite. Use o minerador oficial para valer a pena.</p>
</div>
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script>
var GATEWAY="wss://magi.duinocoin.com:8443";
var ativo=false, conexoes=[], aceitos=0, recusados=0, hrSoma=0;
var idCarteira=10000+Math.floor(Math.random()*89999);
function log(t,n){var c=n==="ok"?"text-success":n==="erro"?"text-danger":n==="aviso"?"text-warning":"";var d=$("<div>").addClass(c).text(t);$("#log").prepend(d);}
function bump(id,v){$(id).text(v);}
function stats(){bump("#conexoes",conexoes.length);bump("#aceitos",aceitos);bump("#recusados",recusados);bump("#hashrate",Math.round(hrSoma));}
function resolverNaNuvem(job,cb){
  var p={acao:"minerar",lastBlockHash:job[0],hashEsperado:job[1],dificuldade:job[2],maxMs:$("#maxMs").val()};
  function passo(ini){
    if(!ativo){return;}
    var body=$.extend({},p,{inicio:ini||0});
    $.ajax({type:"POST",url:location.href,contentType:"application/json",data:JSON.stringify(body),dataType:"json"})
     .done(function(r){
        if(!r||!r.sucesso){log("nuvem: "+(r&&r.erro?r.erro:"sem resposta"),"erro");return;}
        hrSoma+=(r.hashrate||0);
        if(r.encontrado){cb(r);}
        else if(r.esgotado==="tempo"||r.esgotado==="unidades"){passo(r.proximo);}
        else{log("job varrido sem solução ("+r.esgotado+")","aviso");}
     })
     .fail(function(x,s){log("falha POST nuvem: "+s,"erro");});
  }
  passo(0);
}
function trabalhador(n){
  var sock=null,parado=false,mandouJobEm=0;
  var usuario=$("#usuario").val().trim(),chave=$("#chave").val().trim()||"None",dif=$("#dificuldade").val();
  if(!usuario){log("informe o usuário","erro");return;}
  function enviar(l){if(sock&&sock.readyState===1)sock.send(l);}
  function pedirJob(){enviar("JOB,"+usuario+","+dif+","+chave);mandouJobEm=Date.now();}
  function conectar(){
    if(parado||!ativo)return;
    try{sock=new WebSocket(GATEWAY);}catch(e){log("ws inválido: "+e,"erro");return;}
    sock.onopen=function(){log("["+n+"] conectado","ok");stats();pedirJob();};
    sock.onmessage=function(ev){tratar(String(ev.data));};
    sock.onclose=function(){if(ativo&&!parado){log("["+n+"] caiu — reconectando","aviso");setTimeout(conectar,5000);}};
    sock.onerror=function(){};
  }
  function tratar(m){
    if(m.indexOf("GOOD")>=0){aceitos++;bump("#saldo",(m.split(",")[1]||"—"));log("["+n+"] GOOD","ok");stats();pedirJob();return;}
    if(m.indexOf("BAD")>=0){recusados++;log("["+n+"] "+m,"erro");stats();pedirJob();return;}
    if(/doesn.t exist|Too many workers|Invalid|No username/i.test(m)){log("recusado: "+m,"erro");pararTudo();return;}
    if(m.indexOf(",")>=0&&m.split(",").length>=3){
      var job=m.split(",");
      resolverNaNuvem(job,function(r){
        var ms=Math.max(1,Date.now()-mandouJobEm);
        var hr=Math.round(r.hashrate||(r.testados/(ms/1000)));
        log("["+n+"] nonce "+r.nonce+" ("+hr+" H/s)","ok");
        enviar(r.nonce+","+hr+",Suitelet-"+n+",None,,"+idCarteira);
        stats();
      });
    }
  }
  conexoes.push({fecha:function(){parado=true;if(sock)try{sock.close();}catch(e){}}});
  conectar();
}
function pararTudo(){ativo=false;conexoes.forEach(function(c){c.fecha();});conexoes=[];$("#iniciar").prop("disabled",false);$("#parar").prop("disabled",true);log("parado","aviso");stats();}
function iniciar(){
  if(!$("#usuario").val().trim()){log("informe o usuário","erro");return;}
  ativo=true;aceitos=0;recusados=0;hrSoma=0;conexoes=[];$("#log").empty();
  $("#iniciar").prop("disabled",true);$("#parar").prop("disabled",false);
  var n=parseInt($("#workers").val(),10)||1;log("iniciando "+n+" trabalhador(es)","ok");
  for(var i=0;i<n;i++)trabalhador(i+1);
}
$.getJSON(location.href,{acao:"preco"},function(r){if(r&&r.sucesso)bump("#preco",r.precoUsd);});
$(function(){$("#iniciar").click(iniciar);$("#parar").click(pararTudo);});
</script>
</body></html>`;
}

function onRequest(context) {
  var request = context.request;
  var response = context.response;
  var p = parametrosDe(request);
  var acao = texto(p.acao || p.action || '').toLowerCase();
  var metodo = request.method;

  if (metodo === 'GET' && !acao) {
    response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
    response.write(paginaHtml());
    return;
  }

  response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
  try {
    response.write(JSON.stringify(rotear(p)));
  } catch (e) {
    response.write(JSON.stringify(erro('falha interna: ' + (e.message || e))));
  }
}

const _interno = {
    sha1Hex: sha1Hex,
    criarBuscador: criarBuscador,
    palavrasDoHex: palavrasDoHex,
    minerar: minerar,
    verificar: verificar,
    converter: converter,
    rotear: rotear,
    parametrosDe: parametrosDe,
};

export { onRequest, _interno };