// @ts-check
import AsyncStorage from '@react-native-async-storage/async-storage';

const CHAVE = 'alertaDolar:config';

/**
 * @typedef {Object} Config
 * @property {number | null} limite        Valor em R$ que dispara o alerta
 * @property {boolean} ativo               Monitoramento ligado?
 * @property {boolean} jaNotificado        Já avisou desde que a cotação cruzou o limite?
 * @property {number | null} ultimaCotacao Última cotação obtida
 * @property {number | null} ultimaConsulta Timestamp (ms) da última consulta
 */

/** @type {Config} */
const PADRAO = {
  limite: null,
  ativo: false,
  jaNotificado: false,
  ultimaCotacao: null,
  ultimaConsulta: null,
};

/** @returns {Promise<Config>} */
export async function lerConfig() {
  try {
    const bruto = await AsyncStorage.getItem(CHAVE);
    return bruto ? { ...PADRAO, ...JSON.parse(bruto) } : { ...PADRAO };
  } catch {
    return { ...PADRAO };
  }
}

/**
 * Mescla as alterações com a configuração salva e persiste.
 * @param {Partial<Config>} alteracoes
 * @returns {Promise<Config>}
 */
export async function salvarConfig(alteracoes) {
  const nova = { ...(await lerConfig()), ...alteracoes };
  await AsyncStorage.setItem(CHAVE, JSON.stringify(nova));
  return nova;
}
