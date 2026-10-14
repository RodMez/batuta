import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  esWorktreeValido,
  LIMITE_LONGITUD_PROMPT_AGY,
} from "./antigravityRunner.js";
import type { AgentRole } from "./agentContract.js";
import type { AgentInput } from "./agentContract.js";
import type { AgentCallContext } from "./agentRunner.js";
import { calcularCostoEstimado } from "./agentRunner.js";
import type { BatutaConfig } from "./config.js";
import { resolverTipoRunner } from "./config.js";
import type { CambioArchivo } from "./diffPolicy.js";
import { evaluarDiff } from "./diffPolicy.js";
import type { ResultadoGate } from "./gatesRunner.js";
import { crearPayloadGate, ejecutarGates } from "./gatesRunner.js";
import {
  firmaFallo,
  recortarInformeFallo,
  type FalloEvaluacion,
} from "./informeFallo.js";
import { dirInformes, guardarProgreso, leerProgreso, leerReglasRepo, rutaPlan, rutaSpec } from "./motorRutas.js";
import { comprobarLimites, emitirAdvertenciaCostos, fallarEjecucion, registrarUso } from "./motorLimites.js";
import { construirPrompt, construirPromptCortoAgy } from "./motorPrompts.js";
import { escribirContextoEnWorktree } from "./motorContexto.js";
import type {
  DependenciasMotor,
  ProgresoMotor,
  ProgresoSubtarea,
  ResultadoMotor,
} from "./motorTipos.js";
import { parsePlan } from "./plan.js";
import type { Subtask } from "./plan.js";
import { dirRun } from "./runStore.js";
import { seleccionarModelo } from "./seleccionModelo.js";
import { rutaEspera } from "./motorRutas.js";

export function decidirRolReintento(
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

export async function ejecutarSubtarea(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  config: BatutaConfig,
  indice: number,
): Promise<ResultadoMotor | null> {
  const planTexto = await deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
  const plan = parsePlan(JSON.parse(planTexto) as unknown);
  const spec = await deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
  const reglasRepo = await leerReglasRepo(deps.fs, dirBatuta, runId);
  const progreso = await leerProgreso(deps.fs, dirBatuta, runId);
  const subtarea = plan.subtareas[indice];
  if (!subtarea) return null;
  const sub = progreso.subtareas[indice];
  if (!sub || sub.completada) {
    progreso.subtareaIndice = indice + 1;
    await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
    return null;
  }
  if (!progreso.worktree) {
    throw new Error(`Sin worktree para ${runId}`);
  }

  const maxIntentos = config.limites.intentos_por_subtarea;
  let continuacionResumen: { resumen: string; notas: string } | null = null;

  for (;;) {
    const estado = await deps.store.estado(runId);
    const limite = comprobarLimites(
      config,
      progreso,
      progreso.inicioIso,
      deps.reloj.ahoraIso(),
    );
    if (limite) {
      return fallarEjecucion(deps, dirBatuta, runId, progreso, limite.motivo, limite.limite);
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
      const siguiente = decidirRolReintento(sub, maxIntentos);
      if (siguiente === null) {
        const motivo = `Subtarea ${subtarea.id} fallida tras ${sub.intentos} intentos`;
        return fallarEjecucion(deps, dirBatuta, runId, progreso, motivo);
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
    const worktreeRuta = progreso.worktree?.ruta;
    if (!worktreeRuta) {
      throw new Error(`Sin worktree para ${runId}`);
    }

    const ultimoInforme =
      sub.informes.length > 0 ? sub.informes[sub.informes.length - 1]! : "";

    const tipoRunner = resolverTipoRunner(config);
    // Raíz esperada normalizada igual que git.ts: relativa se resuelve contra el repo.
    const raizCruda = config.directorio_worktrees ?? join(dirBatuta, "worktrees");
    const raizWorktrees = isAbsolute(raizCruda)
      ? raizCruda
      : resolve(dirname(dirBatuta), raizCruda);

    // Contexto en archivos solo para antigravity (ADR 021 Dec. 6): evita I/O
    // inútil en claude-code y archivos feedback/AGENTS obsoletos entre intentos.
    let contextoArchivos: {
      specRutaRel: string;
      planRutaRel: string;
      feedbackRutaRel?: string;
      reglasRepoRutaRel?: string;
      dirContexto: string;
    } | null = null;
    if (tipoRunner === "antigravity") {
      // Validar antes de escribir (H-A2): no crear archivos fuera del worktree.
      if (!esWorktreeValido(worktreeRuta, raizWorktrees)) {
        throw new Error(
          `Seguridad: worktree no válido "${worktreeRuta}" para la raíz "${raizWorktrees}"`,
        );
      }
      contextoArchivos = await escribirContextoEnWorktree(
        deps.fs,
        worktreeRuta,
        {
          spec,
          plan,
          subtarea,
          reglasRepo,
          ultimoInforme,
          ultimaRespuesta: sub.ultimaRespuesta,
          continuacionResumen: continuacionResumen
            ? `${continuacionResumen.resumen}\n${continuacionResumen.notas}`
            : undefined,
        },
      );
      // Limpiar archivos obsoletos del intento anterior si esta vez no tocan.
      if (!contextoArchivos.feedbackRutaRel) {
        try {
          await deps.fs.borrar(join(contextoArchivos.dirContexto, "feedback.md"));
        } catch {
          // Tolerar ENOENT: puede no existir.
        }
      }
      if (!contextoArchivos.reglasRepoRutaRel) {
        try {
          await deps.fs.borrar(join(contextoArchivos.dirContexto, "AGENTS.md"));
        } catch {
          // Tolerar ENOENT.
        }
      }
    }

    let prompt: string;
    if (tipoRunner === "antigravity" && contextoArchivos) {
      prompt = construirPromptCortoAgy(rol, subtarea, {
        specRel: contextoArchivos.specRutaRel,
        planRel: contextoArchivos.planRutaRel,
        feedbackRel: contextoArchivos.feedbackRutaRel,
        reglasRepoRel: contextoArchivos.reglasRepoRutaRel,
      });
    } else {
      prompt = await construirPrompt(
        rol,
        subtarea,
        spec,
        reglasRepo,
        ultimoInforme,
        sub.ultimaRespuesta,
        continuacionResumen ?? undefined,
      );
    }

    // Falla rápido sin reintentos si el prompt supera el límite de agy (M2):
    // reintentar con el mismo prompt determinista desperdicia cuota y git.
    if (
      tipoRunner === "antigravity" &&
      prompt.length > LIMITE_LONGITUD_PROMPT_AGY
    ) {
      return fallarEjecucion(
        deps,
        dirBatuta,
        runId,
        progreso,
        `Prompt para agy demasiado largo (${prompt.length} > ${LIMITE_LONGITUD_PROMPT_AGY}). Reduce archivos o títulos.`,
      );
    }

    const input: AgentInput = {
      task_id: subtarea.id,
      agent_role: rol,
      spec_path: "spec.md",
      allowed_files: subtarea.archivos,
      budget_limit_usd: config.limites.usd_por_agente,
      max_steps: config.limites.pasos_por_agente,
    };

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
      raizWorktrees,
    };

    if (estado.estado !== "IMPLEMENT") {
      await deps.store.agregar(runId, {
        tipo: "subtarea_iniciada",
        paso: subtarea.id,
        agente: rol,
        payload: { intento: intentoNumero, modelo: decision.modelo, alias: decision.alias },
      });
    }

    // La llamada puede lanzar (interrupción simulada): no cuenta como intento.
    const resultado = await deps.runner.ejecutar(input, contexto);
    const tokens = resultado.uso.tokensEntrada + resultado.uso.tokensSalida;
    const precios = config.alias_modelos[decision.alias];
    const costo = calcularCostoEstimado(
      { entrada: resultado.uso.tokensEntrada, salida: resultado.uso.tokensSalida },
      precios ? { entrada: precios.entrada, salida: precios.salida } : undefined,
    );
    registrarUso(
      progreso,
      sub,
      rol,
      tokens,
      costo.desconocido ? null : costo.montoUsd,
    );
    sub.modelosUsados.push(decision.modelo);
    sub.rolesUsados.push(rol);
    await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
    if (costo.desconocido) {
      await emitirAdvertenciaCostos(deps, dirBatuta, runId, progreso);
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
      return fallarEjecucion(deps, dirBatuta, runId, progreso, motivo, "usd_por_agente");
    }
    const limiteTrasUso = comprobarLimites(
      config,
      progreso,
      progreso.inicioIso,
      deps.reloj.ahoraIso(),
    );
    if (limiteTrasUso) {
      return fallarEjecucion(deps, dirBatuta, runId, progreso, limiteTrasUso.motivo, limiteTrasUso.limite);
    }

    if (!resultado.exito || !resultado.output) {
      if (resultado.motivoFallo === "cuota_agotada") {
        const resetTime = resultado.resetTime ?? null;
        const bucketIds = resultado.bucketsBajoUmbral ?? [];
        progreso.pausaCuota = { resetTime, bucketIds, modelo: decision.modelo };
        await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
        await deps.store.agregar(runId, {
          tipo: "ejecucion_pausada_por_cuota",
          payload: {
            reset_time: resetTime,
            buckets_bajo_umbral: bucketIds,
            modelo: decision.modelo,
            retomar_en: "IMPLEMENT",
          },
        });
        await deps.store.agregar(runId, {
          tipo: "advertencia",
          paso: subtarea.id,
          payload: {
            aviso: "pausa_cuota",
            modelo: decision.modelo,
            reset_time: resetTime,
            buckets_bajo_umbral: bucketIds,
          },
        });
        await deps.notificador.notificar({
          tipo: "pausa_cuota",
          runId,
          mensaje: `Cuota agotada para ${decision.modelo} (${bucketIds.join(", ")}). Reanuda con: batuta resume ${runId}${resetTime ? ` (reset: ${resetTime})` : ""}`,
        });
        return {
          resultado: "pausa-cuota",
          runId,
          resetTime,
          bucketIds,
        };
      }
      const fallo: FalloEvaluacion = {
        tipo: "agente",
        motivo: resultado.motivoFallo ?? "error_proceso",
        detalle: `Modelo ${decision.modelo}, intento ${intentoNumero}`,
      };
      const salida = await registrarFalloIntento(
        deps,
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
        return fallarEjecucion(deps, dirBatuta, runId, progreso, motivo);
      }
      const pregunta =
        output.blocking_question.trim().length > 0
          ? output.blocking_question
          : "El agente necesita una respuesta para continuar.";
      progreso.preguntasUsadas += 1;
      progreso.esperaEntrada = { pregunta, subtareaId: subtarea.id };
      await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
      await deps.store.agregar(runId, {
        tipo: "entrada_requerida",
        paso: subtarea.id,
        agente: rol,
        payload: { pregunta },
      });
      await deps.fs.escribirArchivo(
        rutaEspera(dirBatuta, runId),
        `# Espera de respuesta\n\nEjecución: ${runId}\nSubtarea: ${subtarea.id}\n\n## Pregunta\n${pregunta}\n`,
      );
      await deps.notificador.notificar({
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
        const salida = await registrarFalloIntento(
          deps,
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
      await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
      await deps.store.agregar(runId, {
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
      const salida = await registrarFalloIntento(
        deps,
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
    const evaluacion = await evaluarExito(
      deps,
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

export async function registrarFalloIntento(
  deps: DependenciasMotor,
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
    await deps.store.agregar(runId, {
      tipo: "agente_completado",
      paso: sub.id,
      payload: { costo_usd: evento.costoUsd, modelo: evento.modelo },
    });
  }
  sub.intentos += 1;
  sub.firmas.push(firma);
  sub.informes.push(informe);
  await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
  if (resetWorktree && progreso.worktree) {
    await deps.git.volverACommit(
      progreso.worktree.ruta,
      progreso.worktree.ultimoCommit,
    );
  }
  const siguiente = decidirRolReintento(sub, config.limites.intentos_por_subtarea);
  if (siguiente === null) {
    const motivo = `Subtarea ${sub.id} fallida tras ${sub.intentos} intentos: ${informe.slice(0, 300)}`;
    return fallarEjecucion(deps, dirBatuta, runId, progreso, motivo);
  }
  if (siguiente === "debugger") {
    await deps.store.agregar(runId, {
      tipo: "depuracion_iniciada",
      paso: sub.id,
      agente: "debugger",
      payload: { intento: sub.intentos + 1, firma },
    });
  } else {
    await deps.store.agregar(runId, {
      tipo: "reintento_programado",
      paso: sub.id,
      payload: { intento: sub.intentos + 1, firma },
    });
  }
  return null;
}

export async function evaluarExito(
  deps: DependenciasMotor,
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
  await deps.store.agregar(runId, {
    tipo: "agente_completado",
    paso: subtarea.id,
    payload: { costo_usd: costoUsd, modelo },
  });
  const cambios: CambioArchivo[] = await deps.git.listarCambios(
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
    await deps.store.agregar(runId, {
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
    return registrarFalloIntento(
      deps,
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
  await deps.store.agregar(runId, {
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
    ejecutor: deps.ejecutor,
    entornoExtra: config.entorno_gates,
  });
  await deps.fs.crearDir(dirInformes(dirBatuta, runId));
  await deps.fs.escribirArchivo(
    join(dirInformes(dirBatuta, runId), `gates-${subtarea.id}-intento-${sub.intentos + 1}.json`),
    JSON.stringify(informe, null, 2),
  );
  for (const gate of informe.gates) {
    await deps.store.agregar(runId, {
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
    await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
    const fallo: FalloEvaluacion = { tipo: "gate", gate: fallido };
    // En fallo de gates se conserva el worktree para corrección incremental.
    return registrarFalloIntento(
      deps,
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
  const resCommit = await deps.git.confirmarSubtarea(
    progreso.worktree.ruta,
    mensaje,
  );
  const hash = resCommit.hash ?? progreso.worktree.ultimoCommit;
  await deps.store.agregar(runId, {
    tipo: "checkpoint_creado",
    paso: subtarea.id,
    payload: { commit: hash },
  });
  await deps.store.checkpoint(runId, hash);
  sub.completada = true;
  sub.commit = hash;
  progreso.worktree.ultimoCommit = hash;
  progreso.subtareaIndice += 1;
  await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
  return "completada";
}
