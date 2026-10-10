#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Help } from "commander";
import { CORE_VERSION } from "@batuta/core";
import { entornoReal, type EntornoCLI } from "./contexto.js";
import { ejecutarRun } from "./comandos/run.js";
import { ejecutarStatus } from "./comandos/status.js";
import { ejecutarApprove } from "./comandos/approve.js";
import { ejecutarAnswer } from "./comandos/answer.js";
import { ejecutarResume } from "./comandos/resume.js";
import { ejecutarAbort } from "./comandos/abort.js";
import { ejecutarDoctor } from "./comandos/doctor.js";
import {
  manejarErrorParseo,
  type ResultadoCLI,
} from "./salida.js";

export const CLI_VERSION = CORE_VERSION;

/** Ayuda con los títulos en español (Uso, Argumentos, Opciones, Comandos). */
class AyudaEspanol extends Help {
  styleTitle(titulo: string): string {
    switch (titulo) {
      case "Usage:":
        return "Uso:";
      case "Arguments:":
        return "Argumentos:";
      case "Options:":
        return "Opciones:";
      case "Global Options:":
        return "Opciones globales:";
      case "Commands:":
        return "Comandos:";
      default:
        return titulo;
    }
  }
}

/** Comando con la ayuda en español (ver pauta de `createHelp`). */
class ComandoBatuta extends Command {
  createHelp(): Help {
    return new AyudaEspanol();
  }
}

async function actuar(resultado: Promise<ResultadoCLI>): Promise<void> {
  const res = await resultado;
  if (res.texto.length > 0) {
    if (res.codigo === 0 || res.codigo === 10 || res.codigo === 11) {
      console.log(res.texto);
    } else {
      console.error(res.texto);
    }
  }
  process.exitCode = res.codigo;
}

export function createProgram(
  version: string = CLI_VERSION,
  entorno: EntornoCLI = entornoReal(),
): Command {
  const program = new ComandoBatuta();

  program
    .name("batuta")
    .description("Orquestador de agentes de IA")
    .version(version, "-v, --version", "Muestra la versión actual de Batuta")
    .helpOption("-h, --help", "Muestra la ayuda del comando")
    .addHelpCommand(false)
    .option("--repo <dir>", "Directorio del repositorio (por defecto, el actual)")
    .option("--debug", "Muestra rastros de pila en los errores");

  program
    .command("run")
    .description("Crea una ejecución y la ejecuta hasta la siguiente pausa o el final")
    .argument("[brief]", "Brief (reservado; aún no disponible, usa --spec y --plan)")
    .option("--spec <fichero>", "Especificación escrita a mano (spec.md)")
    .option("--plan <fichero>", "Plan escrito a mano (plan.json)")
    .option("--config <fichero>", "Configuración (por defecto, batuta.yaml en el repo)")
    .option("--base <ref>", "Referencia de Git de la que parte el worktree (por defecto, HEAD)")
    .option("--simulado <guion>", "Guion JSON de agentes simulados (sin gastar nada)")
    .action(async (brief: string | undefined, opciones: Record<string, unknown>, comando: Command) => {
      const globales = comando.optsWithGlobals<{ repo?: string; debug?: boolean }>();
      await actuar(
        ejecutarRun(
          {
            spec: opciones["spec"] as string | undefined,
            plan: opciones["plan"] as string | undefined,
            brief,
            configPath: opciones["config"] as string | undefined,
            repoDir: globales.repo,
            base: opciones["base"] as string | undefined,
            simulado: opciones["simulado"] as string | undefined,
            debug: globales.debug === true,
          },
          entorno,
        ),
      );
    });

  program
    .command("status")
    .description("Muestra el estado de una ejecución o lista las ejecuciones")
    .argument("[run_id]", "Identificador de la ejecución (sin él, lista todas)")
    .option("--json", "Salida estable en JSON validada con esquema")
    .action(async (runId: string | undefined, opciones: Record<string, unknown>, comando: Command) => {
      const globales = comando.optsWithGlobals<{ repo?: string; debug?: boolean }>();
      await actuar(
        ejecutarStatus(
          {
            runId,
            repoDir: globales.repo,
            json: opciones["json"] === true,
            debug: globales.debug === true,
          },
          entorno,
        ),
      );
    });

  program
    .command("approve")
    .description("Aprueba o rechaza una puerta humana y continúa la ejecución")
    .argument("<run_id>", "Identificador de la ejecución")
    .argument("<puerta>", "Puerta: H0, H1, H2 o H3")
    .option("--rechazar", "Rechaza la puerta y aborta la ejecución")
    .option("--comentario <texto>", "Motivo del rechazo")
    .option("--solo-registrar", "Registra sin continuar la ejecución")
    .option("--simulado <guion>", "Guion JSON de agentes simulados para continuar")
    .action(
      async (
        runId: string,
        puerta: string,
        opciones: Record<string, unknown>,
        comando: Command,
      ) => {
        const globales = comando.optsWithGlobals<{ repo?: string; debug?: boolean }>();
        await actuar(
          ejecutarApprove(
            {
              runId,
              puerta,
              repoDir: globales.repo,
              simulado: opciones["simulado"] as string | undefined,
              rechazar: opciones["rechazar"] === true,
              comentario: opciones["comentario"] as string | undefined,
              soloRegistrar: opciones["solo-registrar"] === true,
              debug: globales.debug === true,
            },
            entorno,
          ),
        );
      },
    );

  program
    .command("answer")
    .description("Responde a una duda crítica y continúa la ejecución")
    .argument("<run_id>", "Identificador de la ejecución")
    .argument("<texto...>", "Texto de la respuesta")
    .option("--simulado <guion>", "Guion JSON de agentes simulados para continuar")
    .action(
      async (
        runId: string,
        texto: string[],
        opciones: Record<string, unknown>,
        comando: Command,
      ) => {
        const globales = comando.optsWithGlobals<{ repo?: string; debug?: boolean }>();
        await actuar(
          ejecutarAnswer(
            {
              runId,
              texto,
              repoDir: globales.repo,
              simulado: opciones["simulado"] as string | undefined,
              debug: globales.debug === true,
            },
            entorno,
          ),
        );
      },
    );

  program
    .command("resume")
    .description("Reanuda una ejecución tras una interrupción")
    .argument("<run_id>", "Identificador de la ejecución")
    .option("--simulado <guion>", "Guion JSON de agentes simulados para continuar")
    .action(async (runId: string, opciones: Record<string, unknown>, comando: Command) => {
      const globales = comando.optsWithGlobals<{ repo?: string; debug?: boolean }>();
      await actuar(
        ejecutarResume(
          {
            runId,
            repoDir: globales.repo,
            simulado: opciones["simulado"] as string | undefined,
            debug: globales.debug === true,
          },
          entorno,
        ),
      );
    });

  program
    .command("abort")
    .description("Aborta una ejecución y limpia el worktree y la rama")
    .argument("<run_id>", "Identificador de la ejecución")
    .option("--yes", "Omite la confirmación (obligatorio sin terminal interactiva)")
    .action(async (runId: string, opciones: Record<string, unknown>, comando: Command) => {
      const globales = comando.optsWithGlobals<{ repo?: string; debug?: boolean }>();
      await actuar(
        ejecutarAbort(
          {
            runId,
            repoDir: globales.repo,
            yes: opciones["yes"] === true,
            debug: globales.debug === true,
          },
          entorno,
        ),
      );
    });

  program
    .command("doctor")
    .description("Comprueba el entorno sin gastar nada")
    .option("--config <fichero>", "Configuración (por defecto, batuta.yaml en el repo)")
    .option("--base <ref>", "Referencia base a comprobar (por defecto, HEAD)")
    .option("--simulado <guion>", "Omite la comprobación de la herramienta de agentes")
    .action(async (opciones: Record<string, unknown>, comando: Command) => {
      const globales = comando.optsWithGlobals<{ repo?: string; debug?: boolean }>();
      await actuar(
        ejecutarDoctor(
          {
            repoDir: globales.repo,
            configPath: opciones["config"] as string | undefined,
            base: opciones["base"] as string | undefined,
            simulado: opciones["simulado"] as string | undefined,
            debug: globales.debug === true,
          },
          entorno,
        ),
      );
    });

  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  entorno: EntornoCLI = entornoReal(),
): Promise<void> {
  const program = createProgram(CLI_VERSION, entorno);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    if (argv.slice(2).length === 0) {
      program.outputHelp();
      process.exitCode = 2;
    }
  } catch (error) {
    process.exitCode = manejarErrorParseo(error);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedFilePath && path.resolve(currentFilePath) === executedFilePath) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
