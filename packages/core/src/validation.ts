import { ZodError } from "zod";

type IssuePathSegment = string | number | symbol;

/**
 * Convierte una ruta de Zod a una cadena legible (`a.b[0].c`).
 * La raíz vacía se representa como `(raíz)` para que el mensaje
 * siempre indique dónde falló la validación.
 */
export function stringifyIssuePath(path: readonly IssuePathSegment[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (typeof segment === "symbol") {
      out += `[${segment.toString()}]`;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      out += (out.length > 0 ? "." : "") + segment;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out.length > 0 ? out : "(raíz)";
}

/**
 * Formatea un ZodError como una lista de `ruta: mensaje` separada por `;`.
 * Para `unrecognized_keys` la ruta está vacía y el mensaje ya incluye
 * la clave (`Unrecognized key: "x"`), así que se anteponen las claves
 * para que la ruta del campo quede explícita.
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") {
        const keys: readonly string[] =
          "keys" in issue && Array.isArray(issue.keys)
            ? (issue.keys as readonly string[])
            : [];
        const base = stringifyIssuePath(issue.path);
        const keyPart = keys.length > 0 ? keys.join(", ") : "";
        const prefix =
          base === "(raíz)" ? keyPart || base : keyPart ? `${base}: ${keyPart}` : base;
        return `${prefix}: ${issue.message}`;
      }
      return `${stringifyIssuePath(issue.path)}: ${issue.message}`;
    })
    .join("; ");
}
