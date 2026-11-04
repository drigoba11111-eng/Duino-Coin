// @ts-check

const URL_DOLAR = 'https://economia.awesomeapi.com.br/last/USD-BRL';
const TIMEOUT_MS = 10_000;

/**
 * Busca a cotação atual do dólar (compra) em reais.
 * @returns {Promise<number>}
 */
export async function buscarCotacao() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetch(URL_DOLAR, { signal: controller.signal });
    if (!resposta.ok) throw new Error(`Erro HTTP ${resposta.status}`);

    const dados = await resposta.json();
    const valor = Number(dados?.USDBRL?.bid);
    if (!Number.isFinite(valor) || valor <= 0) throw new Error('Resposta inválida da API');
    return valor;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Converte o texto digitado ("5,50", "5.5") em número. Retorna null se inválido.
 * @param {string} texto
 * @returns {number | null}
 */
export function parseValor(texto) {
  const valor = Number(String(texto).trim().replace(',', '.'));
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

/**
 * @param {number} valor
 * @param {number} [casas]
 */
export function formatarReais(valor, casas = 2) {
  return `R$ ${valor.toFixed(casas).replace('.', ',')}`;
}
