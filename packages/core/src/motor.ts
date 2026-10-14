import { join } from "node:path";
import type { BatutaConfig } from "./config.js";
import { parsePlan } from "./plan.js";
import { dirRun } from "./runStore.js";
import {
  aprobarPuerta,
  limpiarWorktree,
  rechazarPuerta,
  revisarHashes,
  solicitarAprobacion,
} from "./motorAprobaciones.js";
import { siguientePaso } from "./motorDecision.js";
import { progresoInicial } from "./motorDecision.js";
import { ejecutarSubtarea } from "./motorSubtareas.js";
import { generarCierre } from "./motorResumen.js";
import {
  dirInformes,
  guardarProgreso,
  leerConfigRun,
  leerProgreso,
  rutaConfig,
  rutaPlan,
  rutaSpec,
} from "./motorRutas.js";
import { hashContenido } from "./motorTipos.js";
import type {
  DependenciasMotor,
  OpcionesIniciar,
  ResultadoMotor,
} from "./motorTipos.js";
import type { Puerta } from "./state.js";

/**
 * Motor de flujo con agentes simulados (hito 6).
 *
 * Orquestador delgado: la decisión pura vive en `motorDecision.ts`, las
 * aprobaciones en `motorAprobaciones.ts`, el bucle de subtareas en
 * `motorSubtareas.ts`, los límites en `motorLimites.ts` y el cierre en
 * `motorResumen.ts`. La API pública no cambia.
 */
export class MotorFlujo {
  constructor(private readonly deps: DependenciasMotor) {}

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
    await guardarProgreso(this.deps.fs, dirBatuta, runId, progreso);

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
    await guardarProgreso(this.deps.fs, dirBatuta, runId, progreso);

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
      await guardarProgreso(this.deps.fs, dirBatuta, runId, progreso);
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

  /** Continúa una ejecución hasta la siguiente pausa o el final. */
  async continuar(runId: string, dirBatuta: string): Promise<ResultadoMotor> {
    return this.continuarCon(dirBatuta, runId);
  }

  private async continuarCon(
    dirBatuta: string,
    runId: string,
  ): Promise<ResultadoMotor> {
    for (let iter = 0; iter < 1000; iter++) {
      const config = await leerConfigRun(this.deps.fs, dirBatuta, runId);
      let progreso = await leerProgreso(this.deps.fs, dirBatuta, runId);
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
      if (estado.estado === "WAITING_QUOTA") {
        return {
          resultado: "pausa-cuota",
          runId,
          resetTime: progreso.pausaCuota?.resetTime,
          bucketIds: progreso.pausaCuota?.bucketIds,
        };
      }

      // Si un documento aprobado cambió, pide aprobar de nuevo (sección 4).
      const recheck = await revisarHashes(this.deps, dirBatuta, runId, progreso);
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
        case "esperar-cuota": {
          return {
            resultado: "pausa-cuota",
            runId,
            resetTime: paso.resetTime,
            bucketIds: paso.bucketIds,
          };
        }
        case "solicitar-aprobacion": {
          await solicitarAprobacion(this.deps, dirBatuta, runId, config, paso.puerta);
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
          const salida = await ejecutarSubtarea(
            this.deps,
            dirBatuta,
            runId,
            config,
            paso.indice,
          );
          if (salida) return salida;
          break;
        }
        case "generar-cierre": {
          const salida = await generarCierre(this.deps, dirBatuta, runId, config);
          if (salida) return salida;
          break;
        }
      }
    }
    throw new Error(`Motor atascado en bucle para ${runId}`);
  }

  /** Registra una aprobación y reanuda. Guarda el hash de spec/plan. */
  async aprobar(
    runId: string,
    dirBatuta: string,
    puerta: Puerta,
  ): Promise<ResultadoMotor> {
    const pausa = await aprobarPuerta(this.deps, dirBatuta, runId, puerta);
    if (pausa) return pausa;
    return this.continuarCon(dirBatuta, runId);
  }

  /**
   * Registra una aprobación sin continuar (para `--solo-registrar` de la
   * CLI). Devuelve la pausa si el documento cambió, o null si quedó
   * registrada y pendiente de `resume`.
   */
  async registrarAprobacion(
    runId: string,
    dirBatuta: string,
    puerta: Puerta,
  ): Promise<ResultadoMotor | null> {
    return aprobarPuerta(this.deps, dirBatuta, runId, puerta);
  }

  /** Un rechazo termina la ejecución en ABORTED. */
  async rechazar(
    runId: string,
    dirBatuta: string,
    puerta: Puerta,
    motivo = "Rechazada por la persona",
  ): Promise<ResultadoMotor> {
    return rechazarPuerta(this.deps, dirBatuta, runId, puerta, motivo);
  }

  /** Aborta: termina en ABORTED, elimina worktree y rama, la principal queda intacta. */
  async abortar(runId: string, dirBatuta: string): Promise<ResultadoMotor> {
    const estado = await this.deps.store.estado(runId);
    // En ejecuciones ya terminales (DONE/FAILED/ABORTED) no hay evento que
    // emitir: solo se limpia el worktree y la rama.
    if (
      estado.estado !== "ABORTED" &&
      estado.estado !== "DONE" &&
      estado.estado !== "FAILED"
    ) {
      await this.deps.store.agregar(runId, {
        tipo: "ejecucion_abortada",
        payload: { motivo: "abortada por la persona" },
      });
    }
    await limpiarWorktree(this.deps, dirBatuta, runId);
    await this.deps.notificador.notificar({
      tipo: "fallo",
      runId,
      mensaje: `Ejecución ${runId} abortada`,
    });
    return { resultado: "abortada", runId };
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
    const progreso = await leerProgreso(this.deps.fs, dirBatuta, runId);
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
    await guardarProgreso(this.deps.fs, dirBatuta, runId, progreso);
    return this.continuarCon(dirBatuta, runId);
  }

  /**
   * Reanuda tras una interrupción: reconstruye el estado (recuperación de
   * bloqueos del hito 3), vuelve al último commit confirmado y repite la
   * subtarea en curso sin contar el intento interrumpido.
   */
  async reanudar(runId: string, dirBatuta: string): Promise<ResultadoMotor> {
    await this.deps.store.restaurar(runId);
    const progreso = await leerProgreso(this.deps.fs, dirBatuta, runId);
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
    if (estado.estado === "WAITING_QUOTA") {
      const retomarEn = progreso.pausaCuota?.retomarEn ?? "IMPLEMENT";
      progreso.pausaCuota = undefined;
      await guardarProgreso(this.deps.fs, dirBatuta, runId, progreso);
      await this.deps.store.agregar(runId, {
        tipo: "ejecucion_reanudada",
        payload: { retomar_en: retomarEn, motivo: "reanudacion de cuota" },
      });
    }
    return this.continuarCon(dirBatuta, runId);
  }
}
