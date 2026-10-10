import {
  rutaConfig,
  resolverRepo,
  type EntornoCLI,
} from "../contexto.js";
import {
  ejecutarChequeos,
  formatearChequeos,
  type Chequeo,
} from "../preflight.js";
import {
  CODIGO_TERMINADA,
  CODIGO_USO,
  formatearError,
  type ResultadoCLI,
} from "../salida.js";

export interface ArgsDoctor {
  repoDir?: string;
  configPath?: string;
  base?: string;
  simulado?: string;
  debug: boolean;
}

export async function ejecutarDoctor(
  args: ArgsDoctor,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  try {
    const repoDir = resolverRepo(args.repoDir);
    const { chequeos } = await ejecutarChequeos(entorno, {
      repoDir,
      configPath: rutaConfig(repoDir, args.configPath),
      refBase: args.base,
      simulado: args.simulado !== undefined,
    });
    const hayErrores = chequeos.some((c: Chequeo) => c.estado === "error");
    return {
      texto: formatearChequeos(chequeos),
      codigo: hayErrores ? CODIGO_USO : CODIGO_TERMINADA,
    };
  } catch (error) {
    return { texto: formatearError(error, args.debug), codigo: CODIGO_USO };
  }
}
