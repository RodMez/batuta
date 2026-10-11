import type { AgentRole } from "./agentContract.js";
import type { AgentRunner } from "./agentRunner.js";
import type { BatutaConfig } from "./config.js";
import type { EjecutorComandos } from "./commandRunner.js";
import type { ModuloGit } from "./git.js";
import type { Notificador } from "./notificador.js";
import type { RunStore } from "./runStore.js";
import type { Reloj, SistemaArchivos } from "./sistema.js";
import type { Puerta } from "./state.js";
import { createHash } from "node:crypto";

/** Hash sha256 hex de un texto (aprobaciones H1/H2, sección 4). */
export function hashContenido(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

/** Dependencias inyectables del motor (runner, Git, comandos, registro, reloj, avisos). */
export interface DependenciasMotor {
  runner: AgentRunner;
  git: ModuloGit;
  ejecutor: EjecutorComandos;
  store: RunStore;
  reloj: Reloj;
  notificador: Notificador;
  fs: SistemaArchivos;
}

/** Resultado de una llamada al motor: por qué terminó y con qué datos. */
export type ResultadoMotor =
  | { resultado: "pausa-aprobacion"; runId: string; puerta: Puerta }
  | { resultado: "pausa-entrada"; runId: string; pregunta: string }
  | { resultado: "terminada"; runId: string }
  | { resultado: "fallida"; runId: string; motivo: string }
  | { resultado: "abortada"; runId: string };

/** Opciones para arrancar una ejecución con spec y plan escritos a mano. */
export interface OpcionesIniciar {
  config: BatutaConfig;
  specContenido: string;
  planContenido: unknown;
  reglasRepo: string;
  directorioRepo: string;
  dirBatuta: string;
  refBase?: string;
}

/** Progreso persistido del motor (`motor.json` en la carpeta de la ejecución). */
export interface ProgresoSubtarea {
  id: string;
  intentos: number;
  firmas: string[];
  informes: string[];
  continuaciones: number;
  modelosUsados: string[];
  rolesUsados: AgentRole[];
  gatesFallidos: string[];
  tokens: number;
  usd: number;
  completada: boolean;
  commit: string | null;
  ultimaRespuesta?: string;
}

export interface ProgresoMotor {
  version: 1;
  runId: string;
  inicioIso: string;
  specHash: string;
  planHash: string;
  aprobaciones: Record<Puerta, { aprobada: boolean; hash?: string; pendiente?: string }>;
  subtareaIndice: number;
  totalSubtareas: number;
  subtareas: ProgresoSubtarea[];
  tokensAcumulados: number;
  usdAcumulado: number;
  usdDesconocido: boolean;
  advertenciaEmitida: boolean;
  preguntasUsadas: number;
  usoPorRol: Record<string, { llamadas: number; tokens: number; usd: number }>;
  gatesFallidosGlobal: string[];
  motivoFallo?: string;
  esperaEntrada?: { pregunta: string; subtareaId: string };
  worktree: {
    ruta: string;
    rama: string;
    commitBase: string;
    ultimoCommit: string;
  } | null;
}

/** Paso siguiente puro (pauta del planificador): decisión sin efectos. */
export type PasoSiguiente =
  | { paso: "solicitar-aprobacion"; puerta: Puerta }
  | { paso: "emitir-spec" }
  | { paso: "emitir-plan" }
  | { paso: "ejecutar-subtarea"; indice: number }
  | { paso: "generar-cierre" }
  | { paso: "esperar-aprobacion"; puerta: Puerta }
  | { paso: "esperar-entrada"; pregunta: string }
  | { paso: "terminada"; estado: "DONE" | "FAILED" | "ABORTED" };
