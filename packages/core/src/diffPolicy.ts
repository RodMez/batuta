/** Información de cambios por archivo en un diff. */
export interface CambioArchivo {
  ruta: string;
  lineasAnadidas: number;
  lineasEliminadas: number;
  lineasAnadidasTexto?: string[];
}

/** Política de diff configurable. */
export interface PoliticaDiff {
  rutasProhibidas?: readonly string[];
  archivosPermitidos?: readonly string[];
  maxLineasDiff?: number;
  detectarSecretos?: boolean;
}

/** Tipo de infracción detectada en el diff. */
export type TipoViolacionDiff =
  | "ruta_prohibida"
  | "archivo_no_permitido"
  | "limite_lineas"
  | "secreto_detectado";

/** Violación de la política de diff. */
export interface ViolacionDiff {
  tipo: TipoViolacionDiff;
  archivo?: string;
  linea?: number;
  mensaje: string;
}

/**
 * Normaliza una ruta convirtiendo separadores de Windows `\` a `/`
 * y eliminando prefijos `./` o `/`.
 */
export function normalizarRutaDiff(ruta: string): string {
  let normal = ruta.replace(/\\/g, "/");
  while (normal.startsWith("./")) {
    normal = normal.slice(2);
  }
  if (normal.startsWith("/")) {
    normal = normal.slice(1);
  }
  return normal;
}

/**
 * Comprueba si una ruta normalizada coincide con un patrón de ruta prohibida.
 * Semántica documentada:
 * 1. Si termina en `/` (ej. `drizzle/`, `data/`): representa un directorio.
 *    Coincide si la ruta empieza por ese directorio o es el directorio mismo.
 * 2. Si contiene `*` (ej. `.env*`): comodín glob simple. `*` coincide con cualquier
 *    secuencia de caracteres dentro del segmento o archivo.
 * 3. En caso contrario (ej. `Dockerfile`, `scripts/backup.mjs`): coincidencia exacta
 *    o coincidencia de archivo con el mismo nombre si el patrón no incluye `/`.
 */
export function coincideRutaProhibida(ruta: string, patron: string): boolean {
  const rutaNorm = normalizarRutaDiff(ruta);
  const patronNorm = normalizarRutaDiff(patron);

  // 1. Directorio (termina en /)
  if (patron.endsWith("/")) {
    const dirSinBarra = patronNorm.endsWith("/")
      ? patronNorm.slice(0, -1)
      : patronNorm;
    if (rutaNorm === dirSinBarra || rutaNorm.startsWith(`${dirSinBarra}/`)) {
      return true;
    }
  }

  // 2. Comodín con *
  if (patronNorm.includes("*")) {
    const regexStr = `^${patronNorm
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")}$`;
    const regex = new RegExp(regexStr);
    if (regex.test(rutaNorm)) {
      return true;
    }
    // Si el patrón no contiene '/', probar también contra el nombre de archivo
    if (!patronNorm.includes("/")) {
      const nombreArchivo = rutaNorm.split("/").pop() ?? rutaNorm;
      if (regex.test(nombreArchivo)) {
        return true;
      }
    }
    return false;
  }

  // 3. Coincidencia exacta o por nombre de archivo
  if (rutaNorm === patronNorm) {
    return true;
  }

  // Si el patrón no tiene '/', también prohíbe el archivo en cualquier subdirectorio
  if (!patronNorm.includes("/")) {
    const nombreArchivo = rutaNorm.split("/").pop() ?? rutaNorm;
    if (nombreArchivo === patronNorm) {
      return true;
    }
  }

  return false;
}

/**
 * Heurísticas para la detección de secretos.
 * Diseñadas para alta precisión y bajo nivel de falsos positivos.
 */
const PATRONES_SECRETOS: readonly { nombre: string; regex: RegExp }[] = [
  {
    nombre: "Clave privada",
    regex: /-----BEGIN (?:[A-Z0-9_-]+\s+)?PRIVATE KEY-----/i,
  },
  {
    nombre: "Token de GitHub",
    regex: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  {
    nombre: "Token de Slack",
    regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/,
  },
  {
    nombre: "Clave de API de OpenAI / Anthropic",
    regex: /(?:sk-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{20,})/,
  },
  {
    nombre: "Credencial AWS Access Key",
    regex: /AKIA[0-9A-Z]{16}/,
  },
];

const PATRON_ASIGNACION_SECRETO =
  /(?:api[_-]?key|secret|password|passwd|auth[_-]?token|private[_-]?key)\s*[:=]\s*["']([^"']+)["']/i;

const PALABRAS_CLAVE_FALSOS_POSITIVOS = [
  "test",
  "dummy",
  "example",
  "placeholder",
  "fake",
  "sample",
  "mock",
  "change_me",
  "changeme",
  "xxxx",
  "secret-minimo-32",
  "test-password",
];

/**
 * Analiza una línea de texto en busca de posibles secretos o credenciales.
 * Devuelve la descripción del secreto detectado o null si no se detecta ninguno.
 */
export function detectarSecretoEnLinea(linea: string): string | null {
  // 1. Patrones conocidos de tokens y claves
  for (const patron of PATRONES_SECRETOS) {
    if (patron.regex.test(linea)) {
      return patron.nombre;
    }
  }

  // 2. Asignaciones explícitas de claves / secretos a valores literales
  const match = linea.match(PATRON_ASIGNACION_SECRETO);
  if (match) {
    const valor = match[1] ?? "";
    const valorMinusculas = valor.toLowerCase();

    // Descartar valores cortos (< 12 caracteres) que suelen ser id/flags/valores por defecto
    if (valor.length >= 12) {
      // Descartar si contiene palabras típicas de pruebas o placeholders
      const esFalsoPositivo = PALABRAS_CLAVE_FALSOS_POSITIVOS.some((palabra) =>
        valorMinusculas.includes(palabra),
      );
      if (!esFalsoPositivo) {
        return `Asignación de secreto literal (${match[0].slice(0, 30)}...)`;
      }
    }
  }

  return null;
}

/**
 * Función pura: evalúa un conjunto de cambios contra una política de diff.
 * Devuelve la lista de violaciones encontradas (vacía si el diff es válido).
 */
export function evaluarDiff(
  cambios: readonly CambioArchivo[],
  politica: PoliticaDiff,
): ViolacionDiff[] {
  const violaciones: ViolacionDiff[] = [];
  const rutasProhibidas = politica.rutasProhibidas ?? [];
  const archivosPermitidos = politica.archivosPermitidos
    ? new Set(politica.archivosPermitidos.map(normalizarRutaDiff))
    : null;
  const detectarSecretos = politica.detectarSecretos ?? true;

  let totalLineasDiff = 0;

  for (const cambio of cambios) {
    const rutaNorm = normalizarRutaDiff(cambio.ruta);
    totalLineasDiff += cambio.lineasAnadidas + cambio.lineasEliminadas;

    // 1. Comprobar rutas prohibidas
    for (const patron of rutasProhibidas) {
      if (coincideRutaProhibida(rutaNorm, patron)) {
        violaciones.push({
          tipo: "ruta_prohibida",
          archivo: cambio.ruta,
          mensaje: `El archivo "${cambio.ruta}" coincide con la ruta prohibida "${patron}"`,
        });
        break;
      }
    }

    // 2. Comprobar archivos permitidos (si la lista está definida)
    if (archivosPermitidos !== null && archivosPermitidos.size > 0) {
      if (!archivosPermitidos.has(rutaNorm)) {
        violaciones.push({
          tipo: "archivo_no_permitido",
          archivo: cambio.ruta,
          mensaje: `El archivo "${cambio.ruta}" no está en la lista de archivos permitidos`,
        });
      }
    }

    // 3. Comprobar detección de secretos en líneas añadidas
    if (detectarSecretos && cambio.lineasAnadidasTexto) {
      cambio.lineasAnadidasTexto.forEach((lineaTexto, idx) => {
        const secreto = detectarSecretoEnLinea(lineaTexto);
        if (secreto) {
          violaciones.push({
            tipo: "secreto_detectado",
            archivo: cambio.ruta,
            linea: idx + 1,
            mensaje: `Posible secreto detectado en "${cambio.ruta}": ${secreto}`,
          });
        }
      });
    }
  }

  // 4. Comprobar límite máximo de líneas de diff
  if (
    politica.maxLineasDiff !== undefined &&
    politica.maxLineasDiff > 0 &&
    totalLineasDiff > politica.maxLineasDiff
  ) {
    violaciones.push({
      tipo: "limite_lineas",
      mensaje: `El diff total (${totalLineasDiff} líneas) supera el límite máximo permitido (${politica.maxLineasDiff} líneas)`,
    });
  }

  return violaciones;
}
