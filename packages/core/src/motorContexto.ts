import { join } from "node:path";
import type { SistemaArchivos } from "./sistema.js";
import type { Subtask } from "./plan.js";

export interface ContextoArchivosWorktree {
  spec: string;
  plan: unknown;
  subtarea: Subtask;
  reglasRepo?: string;
  ultimoInforme?: string;
  ultimaRespuesta?: string;
}

export interface ResultadoContextoArchivos {
  dirContexto: string;
  specRutaRel: string;
  planRutaRel: string;
  feedbackRutaRel?: string;
  reglasRepoRutaRel?: string;
}

/**
 * Deposita los archivos de contexto en `.batuta/contexto/` dentro del worktree
 * y añade la entrada a `.git/info/exclude` del worktree (ADR 021, Decisión 6).
 */
export async function escribirContextoEnWorktree(
  fs: SistemaArchivos,
  worktreeRuta: string,
  datos: ContextoArchivosWorktree,
): Promise<ResultadoContextoArchivos> {
  const dirContexto = join(worktreeRuta, ".batuta", "contexto");
  await fs.crearDir(dirContexto);

  const specRuta = join(dirContexto, "spec.md");
  await fs.escribirArchivo(specRuta, datos.spec);

  const planRuta = join(dirContexto, "plan.json");
  const planContenido =
    typeof datos.plan === "string"
      ? datos.plan
      : JSON.stringify(datos.plan, null, 2);
  await fs.escribirArchivo(planRuta, `${planContenido}\n`);

  let feedbackRutaRel: string | undefined;
  const bloquesFeedback: string[] = [];
  if (datos.ultimoInforme && datos.ultimoInforme.trim().length > 0) {
    bloquesFeedback.push(`## Informe de fallos previos\n${datos.ultimoInforme}`);
  }
  if (datos.ultimaRespuesta && datos.ultimaRespuesta.trim().length > 0) {
    bloquesFeedback.push(
      `## Respuesta a pregunta bloqueante\n${datos.ultimaRespuesta}`,
    );
  }
  if (bloquesFeedback.length > 0) {
    const feedbackRuta = join(dirContexto, "feedback.md");
    await fs.escribirArchivo(feedbackRuta, `${bloquesFeedback.join("\n\n")}\n`);
    feedbackRutaRel = ".batuta/contexto/feedback.md";
  }

  let reglasRepoRutaRel: string | undefined;
  if (datos.reglasRepo && datos.reglasRepo.trim().length > 0) {
    const reglasRuta = join(dirContexto, "AGENTS.md");
    await fs.escribirArchivo(reglasRuta, `${datos.reglasRepo}\n`);
    reglasRepoRutaRel = ".batuta/contexto/AGENTS.md";
  }

  // Asegurar exclusión en .git/info/exclude del worktree si es posible
  await asegurarExcludeWorktree(fs, worktreeRuta);

  return {
    dirContexto,
    specRutaRel: ".batuta/contexto/spec.md",
    planRutaRel: ".batuta/contexto/plan.json",
    feedbackRutaRel,
    reglasRepoRutaRel,
  };
}

/**
 * Añade `.batuta/` y `.batuta/contexto/` a la exclusión local de git del worktree
 * para evitar que git status o un git commit no intencional los incluya.
 */
async function asegurarExcludeWorktree(
  fs: SistemaArchivos,
  worktreeRuta: string,
): Promise<void> {
  const entradas = [".batuta/", ".batuta/contexto/"];
  try {
    // Si .git es un archivo (worktree vinculado), lee gitdir
    const rutaGitArchivo = join(worktreeRuta, ".git");
    let rutaExclude: string;
    try {
      const contenidoGit = await fs.leerArchivo(rutaGitArchivo);
      const match = contenidoGit.match(/gitdir:\s*(.+)/);
      if (match && match[1]) {
        rutaExclude = join(match[1].trim(), "info", "exclude");
      } else {
        rutaExclude = join(worktreeRuta, ".git", "info", "exclude");
      }
    } catch {
      rutaExclude = join(worktreeRuta, ".git", "info", "exclude");
    }

    let contenidoActual = "";
    try {
      contenidoActual = await fs.leerArchivo(rutaExclude);
    } catch {
      contenidoActual = "";
    }

    const aAgregar = entradas.filter((e) => !contenidoActual.includes(e));
    if (aAgregar.length > 0) {
      await fs.crearDir(join(rutaExclude, ".."));
      await fs.agregarArchivo(rutaExclude, `\n${aAgregar.join("\n")}\n`);
    }
  } catch {
    // Si falla o el fs es simulado sin estructura .git, continuar
  }
}
