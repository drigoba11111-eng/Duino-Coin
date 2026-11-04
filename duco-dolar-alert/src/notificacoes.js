// @ts-check
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const CANAL = 'alerta-dolar';

// Mostra a notificação mesmo com o app aberto.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Cria o canal Android (idempotente; pode ser chamado várias vezes). */
async function garantirCanal() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CANAL, {
    name: 'Alerta do Dólar',
    description: 'Avisa quando o dólar atinge o limite configurado',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 300, 200, 300],
  });
}

/**
 * Pede permissão de notificação (obrigatório no Android 13+ e no iOS).
 * @returns {Promise<boolean>} true se permitido
 */
export async function pedirPermissao() {
  await garantirCanal();
  const atual = await Notifications.getPermissionsAsync();
  if (atual.granted) return true;
  if (!atual.canAskAgain) return false;
  const pedido = await Notifications.requestPermissionsAsync();
  return pedido.granted;
}

/**
 * Dispara uma notificação local imediatamente.
 * @param {string} titulo
 * @param {string} mensagem
 */
export async function notificar(titulo, mensagem) {
  await garantirCanal();
  await Notifications.scheduleNotificationAsync({
    content: { title: titulo, body: mensagem, sound: 'default' },
    trigger: Platform.OS === 'android' ? { channelId: CANAL } : null,
  });
}
