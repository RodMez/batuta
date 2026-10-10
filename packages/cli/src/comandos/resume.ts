import {
  prepararContinuacion,
  resolverRepo,
  type EntornoCLI,
} from "../contexto.js";
import {
  CODIGO_USO,
  formatearError,
  presentarResultado,
  type ResultadoCLI,
} from "../salida.js";

export interface ArgsResume {
  runId: string;
  repoDir?: string;
  simulado?: string;
  debug: boolean;
}

export async function ejecutarResume(
  args: ArgsResume,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  try {
    const repoDir = resolverRepo(args.repoDir);
    const { dirBatuta, motor } = await prepararContinuacion(
      entorno,
      repoDir,
      args.runId,
      args.simulado,
    );
    const resultado = await motor.reanudar(args.runId, dirBatuta);
    return presentarResultado(resultado, dirBatuta);
  } catch (error) {
    return { texto: formatearError(error, args.debug), codigo: CODIGO_USO };
  }
}
