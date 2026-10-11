/** Tipos de aviso del motor (Telegram llega en la Fase 2, sección 15). */
export type TipoAviso =
  | "aprobacion_requerida"
  | "espera_de_respuesta"
  | "fallo"
  | "ejecucion_terminada"
  | "costo_cerca_del_limite";

/** Aviso emitido por el motor en pausas, fallos y final (hito 6). */
export interface Aviso {
  tipo: TipoAviso;
  runId: string;
  mensaje: string;
}

/** Notificador inyectable del motor (interfaz, sección 15). */
export interface Notificador {
  notificar(aviso: Aviso): Promise<void>;
}

/** Implementación nula: descarta los avisos (Telegram llega en la Fase 2). */
export class NotificadorNulo implements Notificador {
  async notificar(_aviso: Aviso): Promise<void> {
    return undefined;
  }
}
