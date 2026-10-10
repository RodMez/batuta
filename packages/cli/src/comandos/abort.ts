import { createInterface } from "node:readline";
import {
  dirBatutaDe,
  resolverRepo,
  type EntornoCLI,
} from "../contexto.js";
import { MotorFlujo, RunStore } from "@batuta/core";
import type { AgentCallContext, AgentInput } from "@batuta/core";
import {
  CODIGO_USO,
  formatearError,
  presentarResultado,
  type ResultadoCLI,
} from "../salida.js";

export interface ArgsAbort {
  runId: string;
  repoDir?: string;
  yes: boolean;
  debug: boolean;
}

/** Confirmación inyectable para probar sin terminal interactiva. */
export type ConfirmarAbort = () => Promise<boolean>;

async function preguntarConfirmacion(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const respuesta: string = await new Promise((resolver) => {
      rl.question(`¿Abortar la ejecución y eliminar el worktree y la rama? [s/N] `, resolver);
    });
    const normal = respuesta.trim().toLowerCase();
    return normal === "s" || normal === "sí" || normal === "si" || normal === "y";
  } finally {
    rl.close();
  }
}

export async function ejecutarAbort(
  args: ArgsAbort,
  entorno: EntornoCLI,
  confirmar: ConfirmarAbort = preguntarConfirmacion,
): Promise<ResultadoCLI> {
  try {
    const repoDir = resolverRepo(args.repoDir);
    const dirBatuta = dirBatutaDe(repoDir);
    if (!args.yes) {
      const acepta = await confirmar();
      if (!acepta) {
        return {
          texto: `Abortar requiere confirmación: repite con --yes o responde «s».`,
          codigo: CODIGO_USO,
        };
      }
    }
    const store = new RunStore(dirBatuta, entorno.fs, entorno.reloj);
    try {
      await store.estado(args.runId);
    } catch {
      throw new Error(`Ejecución desconocida: "${args.runId}" (¿repo correcto con --repo?).`);
    }
    const motor = new MotorFlujo({
      runner: {
        ejecutar: (_input: AgentInput, _contexto: AgentCallContext) => {
          throw new Error("Abortar no invoca agentes.");
        },
      },
      git: entorno.git,
      ejecutor: entorno.ejecutor,
      store,
      reloj: entorno.reloj,
      notificador: entorno.notificador,
      fs: entorno.fs,
    });
    const resultado = await motor.abortar(args.runId, dirBatuta);
    return presentarResultado(resultado, dirBatuta);
  } catch (error) {
    return { texto: formatearError(error, args.debug), codigo: CODIGO_USO };
  }
}
