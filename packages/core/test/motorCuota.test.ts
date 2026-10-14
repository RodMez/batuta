import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EjecutorComandosReal,
  ModuloGitReal,
  MotorFlujo,
  RunStore,
  parseBatutaConfig,
  sistemaArchivosNode,
  type AgentCallContext,
  type AgentInput,
  type AgentRunResult,
  type AgentRunner,
  type Aviso,
  type BatutaConfig,
  type Notificador,
} from "../src/index.js";
import { crearRelojFijo } from "./helpers.js";

class NotificadorGrabador implements Notificador {
  readonly avisos: Aviso[] = [];
  async notificar(aviso: Aviso): Promise<void> {
    this.avisos.push(aviso);
  }
}

class RunnerGuionado implements AgentRunner {
  readonly llamadas: Array<{ input: AgentInput; contexto: AgentCallContext }> = [];
  constructor(
    private readonly guion: (
      n: number,
      input: AgentInput,
      contexto: AgentCallContext,
    ) => Promise<AgentRunResult> | AgentRunResult,
  ) {}
  async ejecutar(input: AgentInput, contexto: AgentCallContext): Promise<AgentRunResult> {
    const n = this.llamadas.length;
    this.llamadas.push({ input, contexto });
    return this.guion(n, input, contexto);
  }
}

function resultadoCuotaAgotada(resetTime = "2026-10-15T05:20:12Z"): AgentRunResult {
  return {
    exito: false,
    output: null,
    motivoFallo: "cuota_agotada",
    uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
    costoEstimado: { montoUsd: null, desconocido: true },
    modeloEfectivo: "gemini-3.8-flash-low",
    duracionMs: 100,
    rutaLog: "log.txt",
    reintentos: 0,
    resetTime,
    bucketsBajoUmbral: ["gemini-5h"],
  };
}

function resultadoExito(summary = "tarea lista", files: string[] = ["src/index.ts"]): AgentRunResult {
  return {
    exito: true,
    output: {
      status: "SUCCESS",
      summary,
      files_modified: files,
      reported_checks: [{ command: "node -v", exit_code: 0 }],
      continuation_notes: "",
      blocking_question: "",
    },
    motivoFallo: null,
    uso: { tokensEntrada: 12000, tokensSalida: 150, turnos: 1 },
    costoEstimado: { montoUsd: 0.001, desconocido: false },
    modeloEfectivo: "gemini-3.8-flash-low",
    duracionMs: 200,
    rutaLog: "log.txt",
    reintentos: 0,
  };
}

function configBase(repo: string): BatutaConfig {
  return parseBatutaConfig({
    proyecto: repo,
    gates: [{ nombre: "test", comando: "node -v", timeout_seg: 10 }],
    alias_modelos: {
      rapido: { modelo: "m-rapido", entrada: 1, salida: 2, ventana: 100_000 },
      medio: { modelo: "m-medio", entrada: 1, salida: 2, ventana: 100_000 },
      fuerte: { modelo: "m-fuerte", entrada: 1, salida: 2, ventana: 200_000 },
      revisor: { modelo: "m-revisor", entrada: 1, salida: 2, ventana: 100_000 },
    },
    modelos: {
      scout: "rapido",
      resumenes: "rapido",
      architect: "fuerte",
      "software-engineer": { baja: "rapido", media: "medio", alta: "fuerte" },
      debugger: "fuerte",
      revisores: "revisor",
    },
    aprobaciones: {
      H0_inicio: false,
      H1_spec: false,
      H2_plan: false,
      H3_merge: false,
    },
  });
}

const SPEC_TXT = "# Spec\n## Objetivo\nTest de cuota.\n";
const PLAN_OBJ = {
  subtareas: [
    {
      id: "sub-1",
      titulo: "Subtarea 1",
      descripcion: "Hacer algo",
      complejidad: "baja",
      archivos: ["src/index.ts"],
      criterios: ["criterio-1"],
    },
  ],
};

describe("MotorFlujo - Pausa por Cuota y Reanudación (WAITING_QUOTA)", () => {
  const temporales: string[] = [];

  afterEach(async () => {
    for (const d of temporales) {
      try {
        const ejecutor = new EjecutorComandosReal();
        await ejecutor.ejecutar("git worktree prune", { cwd: d });
      } catch {}
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  async function crearRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "batuta-motor-cuota-"));
    temporales.push(dir);
    const ejecutor = new EjecutorComandosReal();
    await ejecutor.ejecutar("git init -b main", { cwd: dir });
    await ejecutor.ejecutar("git config core.autocrlf false", { cwd: dir });
    await ejecutor.ejecutar('git config user.name "Test"', { cwd: dir });
    await ejecutor.ejecutar('git config user.email "test@example.com"', { cwd: dir });
    await writeFile(join(dir, "package.json"), '{"name":"test"}\n', "utf8");
    await ejecutor.ejecutar("git add package.json", { cwd: dir });
    await ejecutor.ejecutar('git commit -m "commit inicial"', { cwd: dir });
    return dir;
  }

  it("pausa con WAITING_QUOTA cuando el runner devuelve cuota_agotada sin contar intento", async () => {
    const repo = await crearRepo();
    const dirBatuta = join(repo, ".batuta");
    const ejecutor = new EjecutorComandosReal();
    const git = new ModuloGitReal(ejecutor);
    const reloj = crearRelojFijo("2026-10-13T20:00:00Z");
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);

    let intento = 0;
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      intento++;
      if (intento === 1) {
        return resultadoCuotaAgotada("2026-10-14T05:00:00Z");
      }
      await mkdir(join(contexto.directorioTrabajo, "src"), { recursive: true });
      await writeFile(
        join(contexto.directorioTrabajo, "src", "index.ts"),
        "export const ok = 1;\n",
        "utf8",
      );
      return resultadoExito();
    });

    const notificador = new NotificadorGrabador();
    const motor = new MotorFlujo({
      runner,
      git,
      ejecutor,
      store,
      reloj,
      notificador,
      fs: sistemaArchivosNode,
    });

    // 1. Iniciar ejecución: la primera llamada al runner devuelve cuota_agotada
    const resPausa = await motor.iniciar({
      config: configBase(repo),
      specContenido: SPEC_TXT,
      planContenido: PLAN_OBJ,
      reglasRepo: "reglas",
      directorioRepo: repo,
      dirBatuta,
    });

    expect(resPausa.resultado).toBe("pausa-cuota");
    if (resPausa.resultado === "pausa-cuota") {
      expect(resPausa.resetTime).toBe("2026-10-14T05:00:00Z");
      expect(resPausa.bucketIds).toEqual(["gemini-5h"]);
    }

    const estadoPausado = await store.estado(resPausa.runId);
    expect(estadoPausado.estado).toBe("WAITING_QUOTA");

    // 2. Reanudar con batuta resume: debe continuar y completar sin contar el intento pausado
    const resContinuar = await motor.reanudar(resPausa.runId, dirBatuta);
    expect(resContinuar.resultado).toBe("terminada");

    const estadoFinal = await store.estado(resPausa.runId);
    expect(estadoFinal.estado).toBe("DONE");

    // Verificar que los eventos contienen ejecucion_pausada_por_cuota y ejecucion_reanudada
    const lectura = await store.leer(resPausa.runId);
    const tipos = lectura.eventos.map((e) => e.tipo);
    expect(tipos).toContain("ejecucion_pausada_por_cuota");
    expect(tipos).toContain("advertencia");
    expect(tipos).toContain("ejecucion_reanudada");
    expect(notificador.avisos.some((a) => a.tipo === "pausa_cuota")).toBe(true);
  }, 30_000);
});
