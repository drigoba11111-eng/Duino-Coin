// @ts-check
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { buscarCotacao, formatarReais } from './cotacao';
import { lerConfig, salvarConfig } from './storage';
import { notificar } from './notificacoes';

const NOME_TAREFA = 'verificar-dolar';
/** Intervalo mínimo em minutos (o Android não aceita menos que 15). */
export const INTERVALO_MINUTOS = 15;

/**
 * Consulta a cotação, salva e notifica se cruzou o limite.
 * Não depende de React: é usada tanto pela UI quanto pela tarefa em background.
 *
 * Avisa uma vez quando a cotação atinge o limite e só volta a avisar
 * depois que ela cair abaixo do limite de novo (evita notificação a cada 15 min).
 *
 * @returns {Promise<number>} cotação obtida
 */
export async function verificarCotacao() {
  const valor = await buscarCotacao();
  const config = await lerConfig();

  /** @type {Partial<import('./storage').Config>} */
  const alteracoes = { ultimaCotacao: valor, ultimaConsulta: Date.now() };

  if (config.ativo && config.limite) {
    const acima = valor >= config.limite;
    if (acima && !config.jaNotificado) {
      await notificar(
        '🚨 Alerta do Dólar',
        `O dólar chegou a ${formatarReais(valor)} (limite: ${formatarReais(config.limite)})`,
      );
      alteracoes.jaNotificado = true;
    } else if (!acima && config.jaNotificado) {
      alteracoes.jaNotificado = false;
    }
  }

  await salvarConfig(alteracoes);
  return valor;
}

// Definida no escopo do módulo (importado pelo index.js), e não dentro de um
// componente: assim roda mesmo com o app fechado.
TaskManager.defineTask(NOME_TAREFA, async () => {
  try {
    await verificarCotacao();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    console.warn('[tarefa] falhou:', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function iniciarMonitoramento() {
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
    throw new Error('Tarefas em segundo plano indisponíveis neste aparelho.');
  }
  if (!(await TaskManager.isTaskRegisteredAsync(NOME_TAREFA))) {
    await BackgroundTask.registerTaskAsync(NOME_TAREFA, {
      minimumInterval: INTERVALO_MINUTOS,
    });
  }
}

export async function pararMonitoramento() {
  if (await TaskManager.isTaskRegisteredAsync(NOME_TAREFA)) {
    await BackgroundTask.unregisterTaskAsync(NOME_TAREFA);
  }
}

/** Só funciona em build de desenvolvimento: força a execução da tarefa agora. */
export function testarTarefaAgora() {
  return BackgroundTask.triggerTaskWorkerForTestingAsync();
}
