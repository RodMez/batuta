import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listarEjecuciones,
  parseGuion,
  parseGuionJson,
  RunnerGuionado,
  sistemaArchivosNode,
  type AgentCallContext,
  type AgentInput,
} from "../src/index.js";
import { SistemaArchivosMemoria } from "./helpers.js";

function inputBase(): AgentInput {
  return {
    task_id: "SUB-01",
    agent_role: "software-engineer",
    spec_path: "spec.md",
    allowed_files: ["a.txt"],
    budget_limit_usd: 2,
    max_steps: 5,
  };
}

function contextoBase(dir: string): AgentCallContext {
  return {
    directorioTrabajo: dir,
    rol: "software-engineer",
    modelo: "guion",
    permisos: { soloLectura: false, comandosPermitidos: [] },
    entorno: {},
    prompt: "hazlo",
    runId: "RUN-1",
  };
}

describe("guion simulado", () => {
  it("valida el formato y rechaza guiones inválidos con la ruta", () => {
    const guion = parseGuion({
      llamadas: [{ archivos: { "a.txt": "hola\n" } }],
    });
    expect(guion.llamadas).toHaveLength(1);
    expect(guion.llamadas[0]?.archivos["a.txt"]).toBe("hola\n");
    expect(() => parseGuion({ llamadas: [] })).toThrow(/llamadas/);
    expect(() => parseGuion({})).toThrow(/llamadas/);
    expect(() => parseGuionJson("{no es json")).toThrow(/JSON/);
    expect(() =>
      parseGuion({ llamadas: [{ fallo: "inexistente" }] }),
    ).toThrow(/fallo/);
  });

  it("escribe archivos en el worktree y devuelve SUCCESS con ellos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batuta-guion-"));
    try {
      const runner = new RunnerGuionado(
        parseGuion({ llamadas: [{ archivos: { "a.txt": "contenido\n" } }] }),
      );
      const res = await runner.ejecutar(inputBase(), contextoBase(dir));
      expect(res.exito).toBe(true);
      expect(res.output?.status).toBe("SUCCESS");
      expect(res.output?.files_modified).toEqual(["a.txt"]);
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("contenido\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rechaza rutas fuera del worktree y falla claro al agotarse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batuta-guion-"));
    try {
      const runner = new RunnerGuionado(
        parseGuion({ llamadas: [{ archivos: { "../fuera.txt": "x" } }] }),
      );
      await expect(
        runner.ejecutar(inputBase(), contextoBase(dir)),
      ).rejects.toThrow(/fuera del worktree/);

      const corto = new RunnerGuionado(parseGuion({ llamadas: [{}] }));
      const r1 = await corto.ejecutar(inputBase(), contextoBase(dir));
      expect(r1.exito).toBe(true);
      await expect(corto.ejecutar(inputBase(), contextoBase(dir))).rejects.toThrow(
        /Guion agotado/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("simula NEEDS_INPUT, NEEDS_CONTINUATION y fallos de runner con espera", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batuta-guion-"));
    try {
      const runner = new RunnerGuionado(
        parseGuion({
          llamadas: [
            {
              esperaMs: 5,
              output: {
                status: "NEEDS_INPUT",
                summary: "duda",
                files_modified: [],
                reported_checks: [],
                continuation_notes: "",
                blocking_question: "¿Sigo?",
              },
            },
            { fallo: "timeout" },
          ],
        }),
        0,
      );
      const r1 = await runner.ejecutar(inputBase(), contextoBase(dir));
      expect(r1.output?.status).toBe("NEEDS_INPUT");
      const r2 = await runner.ejecutar(inputBase(), contextoBase(dir));
      expect(r2.exito).toBe(false);
      expect(r2.motivoFallo).toBe("timeout");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continúa en el índice indicado para seguir en otro proceso", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batuta-guion-"));
    try {
      const guion = parseGuion({ llamadas: [{}, {}] });
      const primero = new RunnerGuionado(guion, 0);
      await primero.ejecutar(inputBase(), contextoBase(dir));
      const segundo = new RunnerGuionado(guion, 1);
      const res = await segundo.ejecutar(inputBase(), contextoBase(dir));
      expect(res.exito).toBe(true);
      expect(res.output?.summary).toMatch(/llamada 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("listarEjecuciones", () => {
  it("devuelve vacío sin directorio y ordena los ids", async () => {
    const fs = new SistemaArchivosMemoria();
    expect(await listarEjecuciones(fs, "/batuta")).toEqual([]);
    await fs.crearDir("/batuta/runs/RUN-2026-10-10-002");
    await fs.crearDir("/batuta/runs/RUN-2026-10-10-001");
    expect(await listarEjecuciones(fs, "/batuta")).toEqual([
      "RUN-2026-10-10-001",
      "RUN-2026-10-10-002",
    ]);
  });

  it("funciona sobre disco real", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batuta-lista-"));
    try {
      expect(await listarEjecuciones(sistemaArchivosNode, dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
