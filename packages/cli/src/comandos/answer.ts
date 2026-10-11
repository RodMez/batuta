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

export interface ArgsAnswer {
  runId: string;
  texto: string[];
  repoDir?: string;
  simulado?: string;
  debug: boolean;
}

export async function ejecutarAnswer(
  args: ArgsAnswer,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  try {
    const respuesta = args.texto.join(" ").trim();
    if (respuesta.length === 0) throw new Error("Falta el texto de la respuesta.");
    const repoDir = resolverRepo(args.repoDir);
    const { dirBatuta, motor } = await prepararContinuacion(
      entorno,
      repoDir,
      args.runId,
      args.simulado,
    );
    const resultado = await motor.responderEntrada(args.runId, dirBatuta, respuesta);
    return presentarResultado(resultado, dirBatuta);
  } catch (error) {
    return { texto: formatearError(error, args.debug), codigo: CODIGO_USO };
  }
}
