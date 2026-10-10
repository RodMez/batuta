import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentRole } from "./agentContract.js";
import { AgentOutputJsonSchema } from "./agentContract.js";
import type { AgentInput } from "./agentContract.js";
import type { AgentCallContext, AgentRunner } from "./agentRunner.js";
import { cargarPlantillaPrompt } from "./agentRunner.js";
import type { BatutaConfig } from "./config.js";
import type { EjecutorComandos } from "./commandRunner.js";
import type { CambioArchivo } from "./diffPolicy.js";
import { evaluarDiff } from "./diffPolicy.js";
import type { ResultadoGate } from "./gatesRunner.js";
import { crearPayloadGate, ejecutarGates } from "./gatesRunner.js";
import type { ModuloGit } from "./git.js";
import {
  firmaFallo,
  recortarInformeFallo,
  type FalloEvaluacion,
} from "./informeFallo.js";
import type { Notificador } from "./notificador.js";
import { calcularCostoEstimado } from "./agentRunner.js";
import type { Plan, Subtask } from "./plan.js";
import { parsePlan } from "./plan.js";
import { dirRun } from "./runStore.js";
import type { RunStore } from "./runStore.js";
import { seleccionarModelo } from "./seleccionModelo.js";
import type { Reloj, SistemaArchivos } from "./sistema.js";
import type { Puerta, RunState } from "./state.js";

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

function puertaNecesaria(
  puerta: Puerta,
  config: BatutaConfig,
  aprobaciones: ProgresoMotor["aprobaciones"],
): boolean {
  const habilitada =
    puerta === "H0"
      ? config.aprobaciones.H0_inicio
      : puerta === "H1"
        ? config.aprobaciones.H1_spec
        : puerta === "H2"
          ? config.aprobaciones.H2_plan
          : config.aprobaciones.H3_merge;
  return habilitada && !aprobaciones[puerta].aprobada;
}

/**
 * Función pura: dado el estado, el progreso y la configuración, dice cuál es
 * el siguiente paso. Permite probar todos los escenarios sin efectos.
 */
export function siguientePaso(
  estado: RunState,
  progreso: ProgresoMotor,
  config: BatutaConfig,
): PasoSiguiente {
  if (
    estado.estado === "DONE" ||
    estado.estado === "FAILED" ||
    estado.estado === "ABORTED"
  ) {
    return { paso: "terminada", estado: estado.estado };
  }
  if (estado.estado === "AWAITING_APPROVAL" && estado.puerta_pendiente) {
    return { paso: "esperar-aprobacion", puerta: estado.puerta_pendiente };
  }
  if (estado.estado === "WAITING_INPUT") {
    return {
      paso: "esperar-entrada",
      pregunta: progreso.esperaEntrada?.pregunta ?? "",
    };
  }
  switch (estado.estado) {
    case "INTAKE": {
      if (puertaNecesaria("H0", config, progreso.aprobaciones)) {
        return { paso: "solicitar-aprobacion", puerta: "H0" };
      }
      return { paso: "emitir-spec" };
    }
    case "SPEC": {
      if (puertaNecesaria("H1", config, progreso.aprobaciones)) {
        return { paso: "solicitar-aprobacion", puerta: "H1" };
      }
      return { paso: "emitir-plan" };
    }
    case "PLAN": {
      if (puertaNecesaria("H2", config, progreso.aprobaciones)) {
        return { paso: "solicitar-aprobacion", puerta: "H2" };
      }
      if (progreso.subtareaIndice < progreso.totalSubtareas) {
        return { paso: "ejecutar-subtarea", indice: progreso.subtareaIndice };
      }
      return { paso: "generar-cierre" };
    }
    case "CHECKPOINT":
    case "RETRY":
    case "DEBUG":
    case "IMPLEMENT":
    case "VERIFY": {
      if (progreso.subtareaIndice < progreso.totalSubtareas) {
        return { paso: "ejecutar-subtarea", indice: progreso.subtareaIndice };
      }
      return { paso: "generar-cierre" };
    }
    case "REVIEW":
    case "FINALIZE": {
      if (
        estado.estado === "FINALIZE" &&
        puertaNecesaria("H3", config, progreso.aprobaciones)
      ) {
        return { paso: "solicitar-aprobacion", puerta: "H3" };
      }
      return { paso: "generar-cierre" };
    }
    default: {
      throw new Error(`Estado no contemplado en siguientePaso: ${estado.estado}`);
    }
  }
}

function rutaMotor(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "motor.json");
}

function rutaSpec(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "spec.md");
}

function rutaPlan(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "plan.json");
}

function rutaConfig(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "config.json");
}

function rutaSolicitud(dirBatuta: string, runId: string, puerta: Puerta): string {
  return join(dirRun(dirBatuta, runId), `aprobacion-${puerta}.md`);
}

function rutaEspera(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "espera-entrada.md");
}

function rutaResumen(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "summary.md");
}

function dirInformes(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "reports");
}

async function escrituraAtomicaFs(
  fs: SistemaArchivos,
  destino: string,
  datos: string,
): Promise<void> {
  const tmp = `${destino}.tmp`;
  await fs.escribirArchivo(tmp, datos);
  await fs.renombrar(tmp, destino);
}

function progresoInicial(
  runId: string,
  plan: Plan,
  specHash: string,
  planHash: string,
  inicioIso: string,
): ProgresoMotor {
  return {
    version: 1,
    runId,
    inicioIso,
    specHash,
    planHash,
    aprobaciones: {
      H0: { aprobada: false },
      H1: { aprobada: false },
      H2: { aprobada: false },
      H3: { aprobada: false },
    },
    subtareaIndice: 0,
    totalSubtareas: plan.subtareas.length,
    subtareas: plan.subtareas.map((s) => ({
      id: s.id,
      intentos: 0,
      firmas: [],
      informes: [],
      continuaciones: 0,
      modelosUsados: [],
      rolesUsados: [],
      gatesFallidos: [],
      tokens: 0,
      usd: 0,
      completada: false,
      commit: null,
    })),
    tokensAcumulados: 0,
    usdAcumulado: 0,
    usdDesconocido: false,
    advertenciaEmitida: false,
    preguntasUsadas: 0,
    usoPorRol: {},
    gatesFallidosGlobal: [],
    worktree: null,
  };
}

function describirSubtarea(s: Subtask): string {
  const base = `${s.id}: ${s.titulo} [${s.complejidad}]`;
  return s.descripcion ? `${base}\n${s.descripcion}` : base;
}

async function construirPrompt(
  rol: AgentRole,
  subtarea: Subtask,
  spec: string,
  reglasRepo: string,
  informeFallo: string,
  respuesta?: string,
  resumenContinuacion?: { resumen: string; notas: string },
): Promise<string> {
  const variables: Record<string, string> = {
    subtarea: describirSubtarea(subtarea),
    spec,
    reglas_repo: reglasRepo,
    archivos_permitidos: subtarea.archivos.join("\n"),
    informe_fallo:
      informeFallo.length > 0 ? informeFallo : "Sin fallos previos.",
    esquema_salida: JSON.stringify(AgentOutputJsonSchema),
  };
  let prompt = await cargarPlantillaPrompt(rol, variables);
  if (respuesta !== undefined && respuesta.length > 0) {
    prompt += `\n\n## Respuesta a tu pregunta bloqueante\n${respuesta}`;
  }
  if (resumenContinuacion) {
    prompt += `\n\n## Continuación de la sesión anterior\nResumen: ${resumenContinuacion.resumen}\nNotas: ${resumenContinuacion.notas}`;
  } else if (informeFallo.length > 0 && rol === "software-engineer") {
    prompt += `\n\n## Informe de fallo anterior\n${informeFallo}`;
  }
  return prompt;
}

/** Motor de flujo con agentes simulados (hito 6). */
export class MotorFlujo {
  constructor(private readonly deps: DependenciasMotor) {}

  private async leerProgreso(
    dirBatuta: string,
    runId: string,
  ): Promise<ProgresoMotor> {
    const texto = await this.deps.fs.leerArchivo(rutaMotor(dirBatuta, runId));
    return JSON.parse(texto) as ProgresoMotor;
  }

  private async guardarProgreso(
    dirBatuta: string,
    runId: string,
    progreso: ProgresoMotor,
  ): Promise<void> {
    await escrituraAtomicaFs(
      this.deps.fs,
      rutaMotor(dirBatuta, runId),
      JSON.stringify(progreso, null, 2),
    );
  }

  private async leerConfig(
    dirBatuta: string,
    runId: string,
  ): Promise<BatutaConfig> {
    const texto = await this.deps.fs.leerArchivo(rutaConfig(dirBatuta, runId));
    return JSON.parse(texto) as BatutaConfig;
  }

  /** Arranca una ejecución: valida el plan, crea el run y el worktree y prepara. */
  async iniciar(opciones: OpcionesIniciar): Promise<ResultadoMotor> {
    const plan = parsePlan(opciones.planContenido);
    const runId = await this.deps.store.iniciarEjecucion();
    const dirBatuta = opciones.dirBatuta;
    await this.deps.fs.escribirArchivo(
      rutaConfig(dirBatuta, runId),
      JSON.stringify(opciones.config, null, 2),
    );
    await this.deps.fs.escribirArchivo(
      rutaSpec(dirBatuta, runId),
      opciones.specContenido,
    );
    await this.deps.fs.escribirArchivo(
      rutaPlan(dirBatuta, runId),
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    await this.deps.fs.escribirArchivo(
      join(dirRun(dirBatuta, runId), "reglas.md"),
      opciones.reglasRepo,
    );
    const specHash = hashContenido(opciones.specContenido);
    const planTexto = await this.deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
    const planHash = hashContenido(planTexto);
    const progreso = progresoInicial(
      runId,
      plan,
      specHash,
      planHash,
      this.deps.reloj.ahoraIso(),
    );
    await this.guardarProgreso(dirBatuta, runId, progreso);

    const refBase = opciones.refBase ?? "HEAD";
    const info = await this.deps.git.crearWorktree(
      opciones.directorioRepo,
      runId,
      {
        refBase,
        directorioWorktrees: opciones.config.directorio_worktrees,
      },
    );
    progreso.worktree = {
      ruta: info.ruta,
      rama: info.rama,
      commitBase: info.commitBase,
      ultimoCommit: info.commitBase,
    };
    await this.guardarProgreso(dirBatuta, runId, progreso);

    const falloPrep = await this.ejecutarPreparacion(
      dirBatuta,
      runId,
      opciones.config,
      info.ruta,
    );
    if (falloPrep) {
      await this.deps.store.agregar(runId, {
        tipo: "ejecucion_fallida",
        payload: {
          motivo: "preparacion",
          comando: falloPrep.comando,
          codigo_salida: falloPrep.codigoSalida,
          detalle: falloPrep.detalle,
        },
      });
      progreso.motivoFallo = `Preparación fallida: ${falloPrep.detalle}`;
      await this.guardarProgreso(dirBatuta, runId, progreso);
      await this.deps.notificador.notificar({
        tipo: "fallo",
        runId,
        mensaje: progreso.motivoFallo,
      });
      return { resultado: "fallida", runId, motivo: progreso.motivoFallo };
    }

    return this.continuarCon(dirBatuta, runId);
  }

  private async ejecutarPreparacion(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
    rutaWorktree: string,
  ): Promise<{ comando: string; codigoSalida: number | null; detalle: string } | null> {
    if (config.preparacion.length === 0) return null;
    const lineas: string[] = [];
    for (const comando of config.preparacion) {
      const res = await this.deps.ejecutor.ejecutar(comando, {
        cwd: rutaWorktree,
        timeoutMs: config.limites.timeout_preparacion_seg * 1000,
        entornoExtra: config.entorno_gates,
        shell: true,
      });
      lineas.push(`$ ${comando}\nexit=${res.codigoSalida}\n${res.salidaEstandar}\n${res.salidaError}`);
      if (res.codigoSalida !== 0 || res.timeoutVencido) {
        const salida = `${res.salidaEstandar}\n${res.salidaError}`.trim();
        const ultimas = salida.split(/\r?\n/).slice(-20).join("\n");
        await this.deps.fs.crearDir(dirInformes(dirBatuta, runId));
        await this.deps.fs.escribirArchivo(
          join(dirInformes(dirBatuta, runId), "preparacion.log"),
          lineas.join("\n"),
        );
        const detalle =
          `El comando de preparación "${comando}" falló` +
          (res.timeoutVencido ? " por timeout" : ` con código ${res.codigoSalida}`) +
          (ultimas.length > 0 ? `:\n${ultimas}` : " sin salida.");
        return { comando, codigoSalida: res.codigoSalida, detalle };
      }
    }
    await this.deps.fs.crearDir(dirInformes(dirBatuta, runId));
    await this.deps.fs.escribirArchivo(
      join(dirInformes(dirBatuta, runId), "preparacion.log"),
      lineas.join("\n"),
    );
    return null;
  }

  /** Determina el dirBatuta a partir del runId buscando el motor.json. */
  async continuar(runId: string, dirBatuta: string): Promise<ResultadoMotor> {
    return this.continuarCon(dirBatuta, runId);
  }

  private async continuarCon(
    dirBatuta: string,
    runId: string,
  ): Promise<ResultadoMotor> {
    for (let iter = 0; iter < 1000; iter++) {
      const config = await this.leerConfig(dirBatuta, runId);
      let progreso = await this.leerProgreso(dirBatuta, runId);
      const estado = await this.deps.store.estado(runId);

      if (
        estado.estado === "DONE" ||
        estado.estado === "FAILED" ||
        estado.estado === "ABORTED"
      ) {
        if (estado.estado === "DONE") return { resultado: "terminada", runId };
        if (estado.estado === "ABORTED") return { resultado: "abortada", runId };
        return {
          resultado: "fallida",
          runId,
          motivo: progreso.motivoFallo ?? "Ejecución fallida",
        };
      }
      if (estado.estado === "AWAITING_APPROVAL" && estado.puerta_pendiente) {
        return {
          resultado: "pausa-aprobacion",
          runId,
          puerta: estado.puerta_pendiente,
        };
      }
      if (estado.estado === "WAITING_INPUT") {
        return {
          resultado: "pausa-entrada",
          runId,
          pregunta: progreso.esperaEntrada?.pregunta ?? "",
        };
      }

      // Si un documento aprobado cambió, pide aprobar de nuevo (sección 4).
      const recheck = await this.revisarHashes(dirBatuta, runId, config, progreso);
      if (recheck !== null) {
        progreso = recheck;
      }

      const paso = siguientePaso(estado, progreso, config);
      switch (paso.paso) {
        case "terminada": {
          if (paso.estado === "DONE") return { resultado: "terminada", runId };
          if (paso.estado === "ABORTED") return { resultado: "abortada", runId };
          return {
            resultado: "fallida",
            runId,
            motivo: progreso.motivoFallo ?? "Ejecución fallida",
          };
        }
        case "esperar-aprobacion": {
          return { resultado: "pausa-aprobacion", runId, puerta: paso.puerta };
        }
        case "esperar-entrada": {
          return { resultado: "pausa-entrada", runId, pregunta: paso.pregunta };
        }
        case "solicitar-aprobacion": {
          await this.solicitarAprobacion(dirBatuta, runId, config, paso.puerta);
          return {
            resultado: "pausa-aprobacion",
            runId,
            puerta: paso.puerta,
          };
        }
        case "emitir-spec": {
          await this.deps.store.agregar(runId, { tipo: "spec_creada" });
          break;
        }
        case "emitir-plan": {
          await this.deps.store.agregar(runId, { tipo: "plan_creado" });
          break;
        }
        case "ejecutar-subtarea": {
          const salida = await this.ejecutarSubtarea(
            dirBatuta,
            runId,
            config,
            paso.indice,
          );
          if (salida) return salida;
          break;
        }
        case "generar-cierre": {
          const salida = await this.generarCierre(dirBatuta, runId, config);
          if (salida) return salida;
          break;
        }
      }
    }
    throw new Error(`Motor atascado en bucle para ${runId}`);
  }

  private async revisarHashes(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
    progreso: ProgresoMotor,
  ): Promise<ProgresoMotor | null> {
    void config;
    let cambiado = false;
    if (progreso.aprobaciones["H1"].aprobada) {
      const actual = await this.deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
      if (hashContenido(actual) !== progreso.aprobaciones["H1"].hash) {
        progreso.aprobaciones["H1"] = { aprobada: false };
        cambiado = true;
      }
    }
    if (progreso.aprobaciones["H2"].aprobada) {
      const actual = await this.deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
      if (hashContenido(actual) !== progreso.aprobaciones["H2"].hash) {
        progreso.aprobaciones["H2"] = { aprobada: false };
        cambiado = true;
      }
    }
    if (cambiado) {
      await this.guardarProgreso(dirBatuta, runId, progreso);
      return progreso;
    }
    return null;
  }

  private async solicitarAprobacion(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
    puerta: Puerta,
  ): Promise<void> {
    await this.deps.store.agregar(runId, {
      tipo: "aprobacion_solicitada",
      payload: { puerta },
    });
    // Guardar el hash pendiente para detectar cambios antes de aprobar.
    const progreso = await this.leerProgreso(dirBatuta, runId);
    if (puerta === "H1") {
      const spec = await this.deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
      progreso.aprobaciones["H1"] = { aprobada: false, pendiente: hashContenido(spec) };
    } else if (puerta === "H2") {
      const planTexto = await this.deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
      progreso.aprobaciones["H2"] = { aprobada: false, pendiente: hashContenido(planTexto) };
    }
    await this.guardarProgreso(dirBatuta, runId, progreso);
    const contenido = await this.textoSolicitud(dirBatuta, runId, config, puerta);
    await this.deps.fs.escribirArchivo(rutaSolicitud(dirBatuta, runId, puerta), contenido);
    await this.deps.notificador.notificar({
      tipo: "aprobacion_requerida",
      runId,
      mensaje: `Se requiere aprobación ${puerta} en ${runId}`,
    });
  }

  private async textoSolicitud(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
    puerta: Puerta,
  ): Promise<string> {
    const progreso = await this.leerProgreso(dirBatuta, runId);
    const spec = await this.deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
    const planTexto = await this.deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
    const plan = parsePlan(JSON.parse(planTexto) as unknown);
    switch (puerta) {
      case "H0": {
        return [
          `# Solicitud de aprobación H0 (presupuesto y límites)`,
          ``,
          `Ejecución: ${runId}`,
          ``,
          `## Límites`,
          `- tokens_por_ejecucion: ${config.limites.tokens_por_ejecucion}`,
          `- minutos_por_ejecucion: ${config.limites.minutos_por_ejecucion}`,
          `- usd_por_agente: ${config.limites.usd_por_agente}`,
          `- pasos_por_agente: ${config.limites.pasos_por_agente}`,
          `- intentos_por_subtarea: ${config.limites.intentos_por_subtarea}`,
          `- preguntas_bloqueantes: ${config.limites.preguntas_bloqueantes}`,
          `- continuaciones_por_subtarea: ${config.limites.continuaciones_por_subtarea}`,
          ``,
          `Responde con \`aprobar\` o \`rechazar\`.`,
          ``,
        ].join("\n");
      }
      case "H1": {
        return [
          `# Solicitud de aprobación H1 (especificación)`,
          ``,
          `Ejecución: ${runId}`,
          `Hash spec.md: ${hashContenido(spec)}`,
          ``,
          `Aprueba la especificación en \`spec.md\` o rechaza para abortar.`,
          ``,
        ].join("\n");
      }
      case "H2": {
        const lineas = plan.subtareas.map((s) => `- ${s.id}: ${s.titulo} [${s.complejidad}]`);
        return [
          `# Solicitud de aprobación H2 (plan)`,
          ``,
          `Ejecución: ${runId}`,
          `Hash plan.json: ${hashContenido(planTexto)}`,
          ``,
          `## Subtareas`,
          ...lineas,
          ``,
          `Aprueba el plan o rechaza para abortar.`,
          ``,
        ].join("\n");
      }
      case "H3": {
        const lineas = progreso.subtareas.map(
          (s) => `- ${s.id}: ${s.completada ? "completada" : "pendiente"} (${s.intentos} fallos)`,
        );
        return [
          `# Solicitud de aprobación H3 (fusión final)`,
          ``,
          `Ejecución: ${runId}`,
          ``,
          `## Subtareas`,
          ...lineas,
          ``,
          `Revisa \`summary.md\` en la carpeta de la ejecución. No se hace push.`,
          ``,
        ].join("\n");
      }
    }
  }

  /** Registra una aprobación y reanuda. Guarda el hash de spec/plan. */
  async aprobar(
    runId: string,
    dirBatuta: string,
    puerta: Puerta,
  ): Promise<ResultadoMotor> {
    const estado = await this.deps.store.estado(runId);
    if (
      estado.estado !== "AWAITING_APPROVAL" ||
      estado.puerta_pendiente !== puerta
    ) {
      throw new Error(`No hay puerta ${puerta} pendiente en ${runId}`);
    }
    const progreso = await this.leerProgreso(dirBatuta, runId);
    const payload: Record<string, unknown> = { puerta };
    if (puerta === "H1") {
      const spec = await this.deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
      const hash = hashContenido(spec);
      const pendiente = progreso.aprobaciones["H1"].pendiente;
      if (pendiente !== undefined && pendiente !== hash) {
        // El documento cambió tras solicitar: hay que aprobar de nuevo.
        progreso.aprobaciones["H1"] = { aprobada: false, pendiente: hash };
        await this.guardarProgreso(dirBatuta, runId, progreso);
        const contenido = await this.textoSolicitud(dirBatuta, runId, await this.leerConfig(dirBatuta, runId), puerta);
        await this.deps.fs.escribirArchivo(rutaSolicitud(dirBatuta, runId, puerta), contenido);
        return { resultado: "pausa-aprobacion", runId, puerta };
      }
      payload["hash_spec"] = hash;
      progreso.aprobaciones["H1"] = { aprobada: true, hash };
    } else if (puerta === "H2") {
      const planTexto = await this.deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
      const hash = hashContenido(planTexto);
      const pendiente = progreso.aprobaciones["H2"].pendiente;
      if (pendiente !== undefined && pendiente !== hash) {
        progreso.aprobaciones["H2"] = { aprobada: false, pendiente: hash };
        await this.guardarProgreso(dirBatuta, runId, progreso);
        const contenido = await this.textoSolicitud(dirBatuta, runId, await this.leerConfig(dirBatuta, runId), puerta);
        await this.deps.fs.escribirArchivo(rutaSolicitud(dirBatuta, runId, puerta), contenido);
        return { resultado: "pausa-aprobacion", runId, puerta };
      }
      payload["hash_plan"] = hash;
      progreso.aprobaciones["H2"] = { aprobada: true, hash };
    } else {
      progreso.aprobaciones[puerta] = { aprobada: true };
    }
    await this.guardarProgreso(dirBatuta, runId, progreso);
    await this.deps.store.agregar(runId, {
      tipo: "aprobacion_otorgada",
      payload,
    });
    return this.continuarCon(dirBatuta, runId);
  }

  /** Un rechazo termina la ejecución en ABORTED. */
  async rechazar(
    runId: string,
    dirBatuta: string,
    puerta: Puerta,
    motivo = "Rechazada por la persona",
  ): Promise<ResultadoMotor> {
    const estado = await this.deps.store.estado(runId);
    if (
      estado.estado !== "AWAITING_APPROVAL" ||
      estado.puerta_pendiente !== puerta
    ) {
      throw new Error(`No hay puerta ${puerta} pendiente en ${runId}`);
    }
    await this.deps.store.agregar(runId, {
      tipo: "ejecucion_abortada",
      payload: { puerta, motivo },
    });
    await this.limpiarWorktree(dirBatuta, runId);
    await this.deps.notificador.notificar({
      tipo: "fallo",
      runId,
      mensaje: `Ejecución ${runId} abortada en ${puerta}: ${motivo}`,
    });
    return { resultado: "abortada", runId };
  }

  /** Aborta: termina en ABORTED, elimina worktree y rama, la principal queda intacta. */
  async abortar(runId: string, dirBatuta: string): Promise<ResultadoMotor> {
    const estado = await this.deps.store.estado(runId);
    if (estado.estado !== "ABORTED") {
      await this.deps.store.agregar(runId, {
        tipo: "ejecucion_abortada",
        payload: { motivo: "abortada por la persona" },
      });
    }
    await this.limpiarWorktree(dirBatuta, runId);
    await this.deps.notificador.notificar({
      tipo: "fallo",
      runId,
      mensaje: `Ejecución ${runId} abortada`,
    });
    return { resultado: "abortada", runId };
  }

  private async limpiarWorktree(
    dirBatuta: string,
    runId: string,
  ): Promise<void> {
    try {
      const progreso = await this.leerProgreso(dirBatuta, runId);
      if (progreso.worktree) {
        await this.deps.git.eliminarWorktree(progreso.worktree.ruta);
      }
    } catch {
      // Si el progreso no existe, no hay worktree que limpiar.
    }
  }

  /** Registra la respuesta a NEEDS_INPUT y reanuda incluyéndola en el prompt. */
  async responderEntrada(
    runId: string,
    dirBatuta: string,
    respuesta: string,
  ): Promise<ResultadoMotor> {
    const estado = await this.deps.store.estado(runId);
    if (estado.estado !== "WAITING_INPUT") {
      throw new Error(`No hay espera de entrada abierta en ${runId}`);
    }
    const progreso = await this.leerProgreso(dirBatuta, runId);
    const espera = progreso.esperaEntrada;
    await this.deps.store.agregar(runId, {
      tipo: "entrada_recibida",
      payload: { retomar_en: "IMPLEMENT", respuesta },
    });
    if (espera) {
      const sub = progreso.subtareas.find((s) => s.id === espera.subtareaId);
      if (sub) sub.ultimaRespuesta = respuesta;
    }
    progreso.esperaEntrada = undefined;
    await this.guardarProgreso(dirBatuta, runId, progreso);
    return this.continuarCon(dirBatuta, runId);
  }

  /**
   * Reanuda tras una interrupción: reconstruye el estado (recuperación de
   * bloqueos del hito 3), vuelve al último commit confirmado y repite la
   * subtarea en curso sin contar el intento interrumpido.
   */
  async reanudar(runId: string, dirBatuta: string): Promise<ResultadoMotor> {
    await this.deps.store.restaurar(runId);
    const progreso = await this.leerProgreso(dirBatuta, runId);
    if (progreso.worktree) {
      await this.deps.git.volverACommit(
        progreso.worktree.ruta,
        progreso.worktree.ultimoCommit,
      );
    }
    // Si la interrupción fue a mitad de evaluar (VERIFY sin reintento),
    // se vuelve a RETRY sin contar el intento interrumpido.
    const estado = await this.deps.store.estado(runId);
    if (estado.estado === "VERIFY") {
      await this.deps.store.agregar(runId, {
        tipo: "reintento_programado",
        payload: { interrumpido: true, motivo: "reanudacion sin contar intento" },
      });
    }
    return this.continuarCon(dirBatuta, runId);
  }

  private registrarUso(
    progreso: ProgresoMotor,
    sub: ProgresoSubtarea,
    rol: AgentRole,
    tokens: number,
    usd: number | null,
  ): void {
    sub.tokens += tokens;
    progreso.tokensAcumulados += tokens;
    const entrada = progreso.usoPorRol[rol] ?? { llamadas: 0, tokens: 0, usd: 0 };
    entrada.llamadas += 1;
    entrada.tokens += tokens;
    if (usd !== null) {
      sub.usd += usd;
      progreso.usdAcumulado += usd;
      entrada.usd += usd;
    } else {
      progreso.usdDesconocido = true;
    }
    progreso.usoPorRol[rol] = entrada;
  }

  private async emitirAdvertenciaCostos(
    dirBatuta: string,
    runId: string,
    progreso: ProgresoMotor,
  ): Promise<void> {
    if (progreso.advertenciaEmitida) return;
    progreso.advertenciaEmitida = true;
    await this.deps.store.agregar(runId, {
      tipo: "advertencia",
      payload: {
        aviso: "costos_desconocidos",
        mensaje:
          "Sin precios para algún alias: solo se controla por tokens, no por dólares.",
      },
    });
    await this.guardarProgreso(dirBatuta, runId, progreso);
  }

  private comprobarLimites(
    config: BatutaConfig,
    progreso: ProgresoMotor,
    inicioIso: string,
    ahoraIso: string,
  ): string | null {
    if (progreso.tokensAcumulados > config.limites.tokens_por_ejecucion) {
      return `Límite de tokens superado (${progreso.tokensAcumulados} > ${config.limites.tokens_por_ejecucion})`;
    }
    const minutos =
      (Date.parse(ahoraIso) - Date.parse(inicioIso)) / 60000;
    if (minutos > config.limites.minutos_por_ejecucion) {
      return `Límite de minutos superado (${minutos.toFixed(1)} > ${config.limites.minutos_por_ejecucion})`;
    }
    return null;
  }

  private async fallarEjecucion(
    dirBatuta: string,
    runId: string,
    progreso: ProgresoMotor,
    motivo: string,
    limite?: string,
  ): Promise<ResultadoMotor> {
    if (limite) {
      await this.deps.store.agregar(runId, {
        tipo: "limite_alcanzado",
        payload: { limite, motivo },
      });
    } else {
      await this.deps.store.agregar(runId, {
        tipo: "ejecucion_fallida",
        payload: { motivo },
      });
    }
    progreso.motivoFallo = motivo;
    await this.guardarProgreso(dirBatuta, runId, progreso);
    if (progreso.worktree) {
      await this.deps.git.volverACommit(
        progreso.worktree.ruta,
        progreso.worktree.ultimoCommit,
      );
    }
    await this.deps.notificador.notificar({
      tipo: "fallo",
      runId,
      mensaje: motivo,
    });
    return { resultado: "fallida", runId, motivo };
  }

  private decidirRolReintento(
    sub: ProgresoSubtarea,
    maxIntentos: number,
  ): AgentRole | null {
    if (sub.intentos >= maxIntentos) return null;
    const n = sub.firmas.length;
    if (n >= 2 && sub.firmas[n - 1] === sub.firmas[n - 2]) {
      return "debugger";
    }
    if (sub.intentos >= 2) return "debugger";
    return "software-engineer";
  }

  private async ejecutarSubtarea(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
    indice: number,
  ): Promise<ResultadoMotor | null> {
    const planTexto = await this.deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
    const plan = parsePlan(JSON.parse(planTexto) as unknown);
    const spec = await this.deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
    const reglasRepo = await this.leerReglas(dirBatuta, runId);
    const progreso = await this.leerProgreso(dirBatuta, runId);
    const subtarea = plan.subtareas[indice];
    if (!subtarea) return null;
    const sub = progreso.subtareas[indice];
    if (!sub || sub.completada) {
      progreso.subtareaIndice = indice + 1;
      await this.guardarProgreso(dirBatuta, runId, progreso);
      return null;
    }
    if (!progreso.worktree) {
      throw new Error(`Sin worktree para ${runId}`);
    }

    const maxIntentos = config.limites.intentos_por_subtarea;
    let continuacionResumen: { resumen: string; notas: string } | null = null;

    for (;;) {
      const estado = await this.deps.store.estado(runId);
      const limite = this.comprobarLimites(
        config,
        progreso,
        progreso.inicioIso,
        this.deps.reloj.ahoraIso(),
      );
      if (limite) {
        return this.fallarEjecucion(dirBatuta, runId, progreso, limite, "limite_ejecucion");
      }

      const esContinuacion = continuacionResumen !== null;
      let rol: AgentRole;
      if (esContinuacion) {
        rol = sub.rolesUsados[sub.rolesUsados.length - 1] ?? "software-engineer";
      } else if (sub.intentos === 0 && sub.rolesUsados.length > 0) {
        // Tras NEEDS_INPUT respondida: mismo rol, sin contar intento.
        rol = sub.rolesUsados[sub.rolesUsados.length - 1] ?? "software-engineer";
      } else if (sub.intentos === 0) {
        rol = "software-engineer";
      } else {
        const siguiente = this.decidirRolReintento(sub, maxIntentos);
        if (siguiente === null) {
          const motivo = `Subtarea ${subtarea.id} fallida tras ${sub.intentos} intentos`;
          return this.fallarEjecucion(dirBatuta, runId, progreso, motivo);
        }
        rol = siguiente;
      }

      const intentoNumero = sub.intentos + 1;
      const decision = seleccionarModelo({
        rol,
        complejidad: subtarea.complejidad,
        intento: rol === "software-engineer" ? intentoNumero : 1,
        config,
      });
      const ultimoInforme =
        sub.informes.length > 0 ? sub.informes[sub.informes.length - 1]! : "";
      const prompt = await construirPrompt(
        rol,
        subtarea,
        spec,
        reglasRepo,
        ultimoInforme,
        sub.ultimaRespuesta,
        continuacionResumen ?? undefined,
      );
      const input: AgentInput = {
        task_id: subtarea.id,
        agent_role: rol,
        spec_path: "spec.md",
        allowed_files: subtarea.archivos,
        budget_limit_usd: config.limites.usd_por_agente,
        max_steps: config.limites.pasos_por_agente,
      };
      const worktreeRuta = progreso.worktree?.ruta;
      if (!worktreeRuta) {
        throw new Error(`Sin worktree para ${runId}`);
      }
      const contexto: AgentCallContext = {
        directorioTrabajo: worktreeRuta,
        rol,
        modelo: decision.modelo,
        aliasModelo: decision.alias,
        limites: {
          budgetLimitUsd: config.limites.usd_por_agente,
          maxSteps: config.limites.pasos_por_agente,
          timeoutMs: config.limites.timeout_comando_seg * 1000,
        },
        permisos: { soloLectura: false, comandosPermitidos: [] },
        entorno: {},
        prompt,
        runId,
        directorioLogs: join(dirRun(dirBatuta, runId), "logs"),
      };

      if (estado.estado !== "IMPLEMENT") {
        await this.deps.store.agregar(runId, {
          tipo: "subtarea_iniciada",
          paso: subtarea.id,
          agente: rol,
          payload: { intento: intentoNumero, modelo: decision.modelo, alias: decision.alias },
        });
      }

      // La llamada puede lanzar (interrupción simulada): no cuenta como intento.
      const resultado = await this.deps.runner.ejecutar(input, contexto);
      const tokens = resultado.uso.tokensEntrada + resultado.uso.tokensSalida;
      const precios = config.alias_modelos[decision.alias];
      const costo = calcularCostoEstimado(
        { entrada: resultado.uso.tokensEntrada, salida: resultado.uso.tokensSalida },
        precios ? { entrada: precios.entrada, salida: precios.salida } : undefined,
      );
      this.registrarUso(
        progreso,
        sub,
        rol,
        tokens,
        costo.desconocido ? null : costo.montoUsd,
      );
      sub.modelosUsados.push(decision.modelo);
      sub.rolesUsados.push(rol);
      await this.guardarProgreso(dirBatuta, runId, progreso);
      if (costo.desconocido) {
        await this.emitirAdvertenciaCostos(dirBatuta, runId, progreso);
      }
      // Límite en dólares por llamada cuando hay precios (CA-11).
      if (
        !costo.desconocido &&
        costo.montoUsd !== null &&
        costo.montoUsd > config.limites.usd_por_agente
      ) {
        const motivo =
          `Límite de dólares superado en ${subtarea.id} ` +
          `(${costo.montoUsd} > ${config.limites.usd_por_agente})`;
        return this.fallarEjecucion(dirBatuta, runId, progreso, motivo, "usd_por_agente");
      }
      const limiteTrasUso = this.comprobarLimites(
        config,
        progreso,
        progreso.inicioIso,
        this.deps.reloj.ahoraIso(),
      );
      if (limiteTrasUso) {
        return this.fallarEjecucion(dirBatuta, runId, progreso, limiteTrasUso, "limite_ejecucion");
      }

      if (!resultado.exito || !resultado.output) {
        const fallo: FalloEvaluacion = {
          tipo: "agente",
          motivo: resultado.motivoFallo ?? "error_proceso",
          detalle: `Modelo ${decision.modelo}, intento ${intentoNumero}`,
        };
        const salida = await this.registrarFalloIntento(
          dirBatuta,
          runId,
          config,
          progreso,
          sub,
          fallo,
          true,
          { modelo: decision.modelo, costoUsd: costo.desconocido ? 0 : (costo.montoUsd ?? 0), yaEnVerify: false },
        );
        if (salida) return salida;
        continuacionResumen = null;
        continue;
      }

      const output = resultado.output;
      if (output.status === "NEEDS_INPUT") {
        if (progreso.preguntasUsadas >= config.limites.preguntas_bloqueantes) {
          const motivo = `Máximo de preguntas bloqueantes superado (${config.limites.preguntas_bloqueantes})`;
          return this.fallarEjecucion(dirBatuta, runId, progreso, motivo);
        }
        const pregunta =
          output.blocking_question.trim().length > 0
            ? output.blocking_question
            : "El agente necesita una respuesta para continuar.";
        progreso.preguntasUsadas += 1;
        progreso.esperaEntrada = { pregunta, subtareaId: subtarea.id };
        await this.guardarProgreso(dirBatuta, runId, progreso);
        await this.deps.store.agregar(runId, {
          tipo: "entrada_requerida",
          paso: subtarea.id,
          agente: rol,
          payload: { pregunta },
        });
        await this.deps.fs.escribirArchivo(
          rutaEspera(dirBatuta, runId),
          `# Espera de respuesta\n\nEjecución: ${runId}\nSubtarea: ${subtarea.id}\n\n## Pregunta\n${pregunta}\n`,
        );
        await this.deps.notificador.notificar({
          tipo: "espera_de_respuesta",
          runId,
          mensaje: pregunta,
        });
        return { resultado: "pausa-entrada", runId, pregunta };
      }

      if (output.status === "NEEDS_CONTINUATION") {
        if (sub.continuaciones >= config.limites.continuaciones_por_subtarea) {
          const fallo: FalloEvaluacion = {
            tipo: "agente",
            motivo: "continuaciones_agotadas",
            detalle: `Máximo de continuaciones (${config.limites.continuaciones_por_subtarea}) superado`,
          };
          const salida = await this.registrarFalloIntento(
            dirBatuta,
            runId,
            config,
            progreso,
            sub,
            fallo,
            true,
            { modelo: decision.modelo, costoUsd: 0, yaEnVerify: false },
          );
          if (salida) return salida;
          continuacionResumen = null;
          continue;
        }
        sub.continuaciones += 1;
        await this.guardarProgreso(dirBatuta, runId, progreso);
        await this.deps.store.agregar(runId, {
          tipo: "contexto_resumido",
          paso: subtarea.id,
          agente: rol,
          payload: {
            resumen: output.summary,
            continuation_notes: output.continuation_notes,
            continuacion: sub.continuaciones,
          },
        });
        continuacionResumen = {
          resumen: output.summary,
          notas: output.continuation_notes,
        };
        continue;
      }

      if (output.status === "FAILED") {
        const fallo: FalloEvaluacion = {
          tipo: "agente",
          motivo: "agente_failed",
          detalle: output.summary,
        };
        const salida = await this.registrarFalloIntento(
          dirBatuta,
          runId,
          config,
          progreso,
          sub,
          fallo,
          true,
          { modelo: decision.modelo, costoUsd: 0, yaEnVerify: false },
        );
        if (salida) return salida;
        continuacionResumen = null;
        continue;
      }

      // SUCCESS: evaluar (primero diff por barata, luego gates).
      continuacionResumen = null;
      sub.ultimaRespuesta = undefined;
      const evaluacion = await this.evaluarExito(
        dirBatuta,
        runId,
        config,
        progreso,
        sub,
        subtarea,
        decision.modelo,
        costo.desconocido ? 0 : (costo.montoUsd ?? 0),
      );
      if (evaluacion === "completada") {
        return null;
      }
      if (evaluacion !== null) return evaluacion;
    }
  }

  private async leerReglas(
    dirBatuta: string,
    runId: string,
  ): Promise<string> {
    try {
      return await this.deps.fs.leerArchivo(
        join(dirRun(dirBatuta, runId), "reglas.md"),
      );
    } catch {
      return "Sin reglas adicionales.";
    }
  }

  private async registrarFalloIntento(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
    progreso: ProgresoMotor,
    sub: ProgresoSubtarea,
    fallo: FalloEvaluacion,
    resetWorktree: boolean,
    evento: { modelo: string; costoUsd: number; yaEnVerify: boolean },
  ): Promise<ResultadoMotor | null> {
    const informe = recortarInformeFallo(fallo);
    const firma = firmaFallo(fallo);
    if (!evento.yaEnVerify) {
      await this.deps.store.agregar(runId, {
        tipo: "agente_completado",
        paso: sub.id,
        payload: { costo_usd: evento.costoUsd, modelo: evento.modelo },
      });
    }
    sub.intentos += 1;
    sub.firmas.push(firma);
    sub.informes.push(informe);
    await this.guardarProgreso(dirBatuta, runId, progreso);
    if (resetWorktree && progreso.worktree) {
      await this.deps.git.volverACommit(
        progreso.worktree.ruta,
        progreso.worktree.ultimoCommit,
      );
    }
    const siguiente = this.decidirRolReintento(sub, config.limites.intentos_por_subtarea);
    if (siguiente === null) {
      const motivo = `Subtarea ${sub.id} fallida tras ${sub.intentos} intentos: ${informe.slice(0, 300)}`;
      return this.fallarEjecucion(dirBatuta, runId, progreso, motivo);
    }
    if (siguiente === "debugger") {
      await this.deps.store.agregar(runId, {
        tipo: "depuracion_iniciada",
        paso: sub.id,
        agente: "debugger",
        payload: { intento: sub.intentos + 1, firma },
      });
    } else {
      await this.deps.store.agregar(runId, {
        tipo: "reintento_programado",
        paso: sub.id,
        payload: { intento: sub.intentos + 1, firma },
      });
    }
    return null;
  }

  private async evaluarExito(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
    progreso: ProgresoMotor,
    sub: ProgresoSubtarea,
    subtarea: Subtask,
    modelo: string,
    costoUsd: number,
  ): Promise<ResultadoMotor | "completada" | null> {
    if (!progreso.worktree) throw new Error(`Sin worktree para ${runId}`);
    await this.deps.store.agregar(runId, {
      tipo: "agente_completado",
      paso: subtarea.id,
      payload: { costo_usd: costoUsd, modelo },
    });
    const cambios: CambioArchivo[] = await this.deps.git.listarCambios(
      progreso.worktree.ruta,
      { commitBase: progreso.worktree.ultimoCommit },
    );
    const violaciones = evaluarDiff(cambios, {
      rutasProhibidas: config.rutas_prohibidas,
      archivosPermitidos: subtarea.archivos,
      maxLineasDiff: config.limites.lineas_de_diff_max,
      detectarSecretos: true,
    });
    if (violaciones.length > 0) {
      await this.deps.store.agregar(runId, {
        tipo: "gate_ejecutado",
        paso: subtarea.id,
        payload: {
          nombre: "politica-diff",
          comando: "politica-diff",
          resultado: "falla",
          codigo_salida: null,
          duracion_ms: 0,
          timeout_vencido: false,
          violaciones: violaciones.map((v) => v.mensaje),
        },
      });
      const fallo: FalloEvaluacion = { tipo: "diff", violaciones };
      return this.registrarFalloIntento(
        dirBatuta,
        runId,
        config,
        progreso,
        sub,
        fallo,
        true,
        { modelo, costoUsd, yaEnVerify: true },
      );
    }
    await this.deps.store.agregar(runId, {
      tipo: "gate_ejecutado",
      paso: subtarea.id,
      payload: {
        nombre: "politica-diff",
        comando: "politica-diff",
        resultado: "pasa",
        codigo_salida: 0,
        duracion_ms: 0,
        timeout_vencido: false,
      },
    });

    const informe = await ejecutarGates(config.gates, progreso.worktree.ruta, {
      ejecutor: this.deps.ejecutor,
      entornoExtra: config.entorno_gates,
    });
    await this.deps.fs.crearDir(dirInformes(dirBatuta, runId));
    await this.deps.fs.escribirArchivo(
      join(dirInformes(dirBatuta, runId), `gates-${subtarea.id}-intento-${sub.intentos + 1}.json`),
      JSON.stringify(informe, null, 2),
    );
    for (const gate of informe.gates) {
      await this.deps.store.agregar(runId, {
        tipo: "gate_ejecutado",
        paso: subtarea.id,
        payload: crearPayloadGate(gate) as unknown as Record<string, unknown>,
      });
    }
    const fallido = informe.gates.find((g: ResultadoGate) => g.resultado === "falla");
    if (fallido) {
      sub.gatesFallidos.push(fallido.nombre);
      const idx = progreso.gatesFallidosGlobal.indexOf(fallido.nombre);
      if (idx === -1) progreso.gatesFallidosGlobal.push(fallido.nombre);
      await this.guardarProgreso(dirBatuta, runId, progreso);
      const fallo: FalloEvaluacion = { tipo: "gate", gate: fallido };
      // En fallo de gates se conserva el worktree para corrección incremental.
      return this.registrarFalloIntento(
        dirBatuta,
        runId,
        config,
        progreso,
        sub,
        fallo,
        false,
        { modelo, costoUsd, yaEnVerify: true },
      );
    }

    const mensaje = `feat(${subtarea.id}): ${subtarea.titulo}`;
    const resCommit = await this.deps.git.confirmarSubtarea(
      progreso.worktree.ruta,
      mensaje,
    );
    const hash = resCommit.hash ?? progreso.worktree.ultimoCommit;
    await this.deps.store.agregar(runId, {
      tipo: "checkpoint_creado",
      paso: subtarea.id,
      payload: { commit: hash },
    });
    await this.deps.store.checkpoint(runId, hash);
    sub.completada = true;
    sub.commit = hash;
    progreso.worktree.ultimoCommit = hash;
    progreso.subtareaIndice += 1;
    await this.guardarProgreso(dirBatuta, runId, progreso);
    return "completada";
  }

  private async generarCierre(
    dirBatuta: string,
    runId: string,
    config: BatutaConfig,
  ): Promise<ResultadoMotor | null> {
    const estado = await this.deps.store.estado(runId);
    const progreso = await this.leerProgreso(dirBatuta, runId);

    // La decisión de pausar en H3 vive en `siguientePaso`; aquí solo se
    // avanza REVIEW→FINALIZE→DONE. El resumen se escribe antes de H3 y se
    // reescribe de forma idempotente al completar.
    if (estado.estado === "CHECKPOINT") {
      await this.deps.store.agregar(runId, {
        tipo: "revision_completada",
        payload: { omitida: true, motivo: "hito 6 sin revisores" },
      });
      await this.deps.store.agregar(runId, {
        tipo: "pr_creada",
        payload: { omitida: true, motivo: "hito 6 sin push" },
      });
      const resumen = this.textoResumen(progreso, config);
      await this.deps.fs.escribirArchivo(rutaResumen(dirBatuta, runId), resumen);
      return null;
    }

    if (estado.estado === "REVIEW") {
      await this.deps.store.agregar(runId, {
        tipo: "pr_creada",
        payload: { omitida: true, motivo: "hito 6 sin push" },
      });
      return null;
    }

    if (estado.estado === "FINALIZE") {
      const resumen = this.textoResumen(progreso, config);
      await this.deps.fs.escribirArchivo(rutaResumen(dirBatuta, runId), resumen);
      await this.deps.store.agregar(runId, { tipo: "ejecucion_completada" });
      await this.deps.notificador.notificar({
        tipo: "ejecucion_terminada",
        runId,
        mensaje: `Ejecución ${runId} terminada en DONE`,
      });
      return { resultado: "terminada", runId };
    }

    if (estado.estado === "PLAN") {
      // Sin subtareas pendientes pero sin checkpoint: cerrar directo.
      const resumen = this.textoResumen(progreso, config);
      await this.deps.fs.escribirArchivo(rutaResumen(dirBatuta, runId), resumen);
      return null;
    }
    return null;
  }

  private textoResumen(progreso: ProgresoMotor, config: BatutaConfig): string {
    void config;
    const minutos =
      (Date.parse(this.deps.reloj.ahoraIso()) - Date.parse(progreso.inicioIso)) / 60000;
    const lineas: string[] = [
      `# Resumen de la ejecución ${progreso.runId}`,
      ``,
      `## Subtareas`,
      ...progreso.subtareas.map(
        (s) =>
          `- ${s.id}: ${s.completada ? "completada" : "pendiente"} · intentos fallidos ${s.intentos} · commit ${s.commit ?? "-"}`,
      ),
      ``,
      `## Intentos por subtarea`,
      ...progreso.subtareas.map((s) => `- ${s.id}: ${s.intentos} fallos, modelos: ${s.modelosUsados.join(", ") || "-"}`),
      ``,
      `## Gates que fallaron`,
      progreso.gatesFallidosGlobal.length > 0
        ? progreso.gatesFallidosGlobal.map((g) => `- ${g}`).join("\n")
        : "- ninguno",
      ``,
      `## Uso y costo por rol`,
      ...Object.entries(progreso.usoPorRol).map(
        ([rol, u]) => `- ${rol}: ${u.llamadas} llamadas, ${u.tokens} tokens, $${u.usd.toFixed(6)}`,
      ),
      ``,
      `Total tokens: ${progreso.tokensAcumulados}`,
      `Total USD: $${progreso.usdAcumulado.toFixed(6)}${progreso.usdDesconocido ? " (parcialmente desconocido: faltan precios)" : ""}`,
      `Duración: ${minutos.toFixed(1)} minutos`,
      ``,
    ];
    return lineas.join("\n");
  }
}
