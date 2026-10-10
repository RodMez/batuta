import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { formatZodError } from "./validation.js";

/**
 * Alias de modelo con nombre completo, ventana y precios opcionales
 * (sección 3.4). Sin `entrada`/`salida` el costo en USD no se puede
 * calcular; un hito posterior hará que el preflight lo advierta.
 */
export const ModeloPrecioSchema = z.strictObject({
  modelo: z.string().min(1),
  entrada: z.number().min(0).optional(),
  salida: z.number().min(0).optional(),
  ventana: z.number().int().positive(),
});

/** Asignación de alias por rol (secciones 3.4 y 7). */
export const ModelosPorRolSchema = z.strictObject({
  scout: z.string().min(1),
  resumenes: z.string().min(1),
  architect: z.string().min(1),
  "software-engineer": z.strictObject({
    baja: z.string().min(1),
    media: z.string().min(1),
    alta: z.string().min(1),
  }),
  debugger: z.string().min(1),
  revisores: z.string().min(1),
});

/** Límites duros de la ejecución (secciones 7 y 8). */
export const LimitesSchema = z.strictObject({
  intentos_por_subtarea: z.number().int().positive(),
  tokens_por_ejecucion: z.number().int().positive(),
  minutos_por_ejecucion: z.number().positive(),
  lineas_de_diff_max: z.number().int().positive(),
  usd_por_agente: z.number().positive(),
  pasos_por_agente: z.number().int().positive(),
  timeout_comando_seg: z.number().positive(),
});

/** Gates humanos H0–H3 (secciones 4 y 7). */
export const AprobacionesSchema = z.strictObject({
  H0_inicio: z.boolean(),
  H1_spec: z.boolean(),
  H2_plan: z.boolean(),
  H3_merge: z.boolean(),
});

/**
 * Gate de verificación (secciones 3.5, 7 y 18). Forma canónica de objeto
 * con nombre, comando y timeout; la lista de cadenas de la sección 7
 * se considera una abreviatura documental y no se acepta como config.
 */
export const GateSchema = z.strictObject({
  nombre: z.string().min(1),
  comando: z.string().min(1),
  timeout_seg: z.number().positive(),
});

export const NIVEL_COMANDO_VALUES = [
  "permitir",
  "registrar",
  "pedir_confirmacion",
] as const;

export const NivelComandoSchema = z.enum(NIVEL_COMANDO_VALUES);

/** Clasificación de riesgo de comandos (sección 8). */
export const PoliticaComandosSchema = z.strictObject({
  bajo: NivelComandoSchema,
  medio: NivelComandoSchema,
  alto: NivelComandoSchema,
});

export const CANAL_VALUES = ["telegram"] as const;

export const EVENTO_AVISO_VALUES = [
  "aprobacion_requerida",
  "espera_de_respuesta",
  "fallo",
  "ejecucion_terminada",
  "costo_cerca_del_limite",
] as const;

/** Notificaciones por Telegram (secciones 7 y 15). */
export const NotificacionesSchema = z.strictObject({
  canal: z.enum(CANAL_VALUES),
  eventos: z.array(z.enum(EVENTO_AVISO_VALUES)).min(1),
});

export const EJECUTOR_VALUES = ["claude-code", "opencode"] as const;

const DEFAULT_ALIAS_MODELOS: Record<
  string,
  { modelo: string; entrada?: number; salida?: number; ventana: number }
> = {
  rapido: { modelo: "rapido", ventana: 100_000 },
  medio: { modelo: "medio", ventana: 100_000 },
  fuerte: { modelo: "fuerte", ventana: 200_000 },
  revisor: { modelo: "revisor", ventana: 100_000 },
};

const DEFAULT_MODELOS: {
  scout: string;
  resumenes: string;
  architect: string;
  "software-engineer": { baja: string; media: string; alta: string };
  debugger: string;
  revisores: string;
} = {
  scout: "rapido",
  resumenes: "rapido",
  architect: "fuerte",
  "software-engineer": { baja: "rapido", media: "medio", alta: "fuerte" },
  debugger: "fuerte",
  revisores: "revisor",
};

const DEFAULT_LIMITES: {
  intentos_por_subtarea: number;
  tokens_por_ejecucion: number;
  minutos_por_ejecucion: number;
  lineas_de_diff_max: number;
  usd_por_agente: number;
  pasos_por_agente: number;
  timeout_comando_seg: number;
} = {
  intentos_por_subtarea: 3,
  tokens_por_ejecucion: 2_000_000,
  minutos_por_ejecucion: 120,
  lineas_de_diff_max: 800,
  usd_por_agente: 2,
  pasos_por_agente: 15,
  timeout_comando_seg: 120,
};

const DEFAULT_APROBACIONES: {
  H0_inicio: boolean;
  H1_spec: boolean;
  H2_plan: boolean;
  H3_merge: boolean;
} = {
  H0_inicio: true,
  H1_spec: true,
  H2_plan: true,
  H3_merge: true,
};

const DEFAULT_POLITICA_COMANDOS: {
  bajo: "permitir" | "registrar" | "pedir_confirmacion";
  medio: "permitir" | "registrar" | "pedir_confirmacion";
  alto: "permitir" | "registrar" | "pedir_confirmacion";
} = {
  bajo: "permitir",
  medio: "registrar",
  alto: "pedir_confirmacion",
};

const DEFAULT_NOTIFICACIONES: {
  canal: "telegram";
  eventos: (
    | "aprobacion_requerida"
    | "espera_de_respuesta"
    | "fallo"
    | "ejecucion_terminada"
    | "costo_cerca_del_limite"
  )[];
} = {
  canal: "telegram",
  eventos: [
    "aprobacion_requerida",
    "espera_de_respuesta",
    "fallo",
    "ejecucion_terminada",
    "costo_cerca_del_limite",
  ],
};

/**
 * Configuración (`batuta.yaml`, secciones 7, 14, 15 y 18).
 * Solo `proyecto` y `gates` son obligatorios; el resto tiene los valores
 * por defecto de la sección 7 para que el YAML mínimo del piloto
 * (sección 18) cargue sin errores. Todo objeto es estricto: un campo
 * desconocido falla. Los roles deben apuntar a alias definidos y los
 * nombres de gate deben ser únicos.
 */
export const BatutaConfigSchema = z
  .strictObject({
    version_esquema: z.number().int().min(1).default(1),
    proyecto: z.string().min(1),
    preparacion: z.array(z.string().min(1)).default([]),
    entorno_gates: z.record(z.string(), z.string()).default({}),
    ejecutor: z.enum(EJECUTOR_VALUES).default("claude-code"),
    alias_modelos: z
      .record(z.string(), ModeloPrecioSchema)
      .default(DEFAULT_ALIAS_MODELOS),
    modelos: ModelosPorRolSchema.default(DEFAULT_MODELOS),
    escalar_modelo_en_reintento: z.boolean().default(true),
    limites: LimitesSchema.default(DEFAULT_LIMITES),
    aprobaciones: AprobacionesSchema.default(DEFAULT_APROBACIONES),
    gates: z.array(GateSchema).min(1),
    politica_comandos: PoliticaComandosSchema.default(
      DEFAULT_POLITICA_COMANDOS,
    ),
    rutas_prohibidas: z.array(z.string().min(1)).default([]),
    specs_en_repo: z.boolean().default(true),
    directorio_worktrees: z.string().min(1).optional(),
    notificaciones: NotificacionesSchema.default(DEFAULT_NOTIFICACIONES),
  })
  .superRefine((config, ctx) => {
    const vistos = new Map<string, number>();
    config.gates.forEach((gate, index) => {
      const primero = vistos.get(gate.nombre);
      if (primero !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["gates", index, "nombre"],
          message: `Nombre de gate repetido: "${gate.nombre}" (ya usado en gates[${primero}])`,
        });
      } else {
        vistos.set(gate.nombre, index);
      }
    });

    const alias = new Set(Object.keys(config.alias_modelos));
    const comprobar = (ruta: (string | number)[], nombre: string): void => {
      if (!alias.has(nombre)) {
        ctx.addIssue({
          code: "custom",
          path: ruta,
          message: `Alias de modelo no definido: "${nombre}"`,
        });
      }
    };
    comprobar(["modelos", "scout"], config.modelos.scout);
    comprobar(["modelos", "resumenes"], config.modelos.resumenes);
    comprobar(["modelos", "architect"], config.modelos.architect);
    comprobar(
      ["modelos", "software-engineer", "baja"],
      config.modelos["software-engineer"].baja,
    );
    comprobar(
      ["modelos", "software-engineer", "media"],
      config.modelos["software-engineer"].media,
    );
    comprobar(
      ["modelos", "software-engineer", "alta"],
      config.modelos["software-engineer"].alta,
    );
    comprobar(["modelos", "debugger"], config.modelos.debugger);
    comprobar(["modelos", "revisores"], config.modelos.revisores);
  });

export type ModeloPrecio = z.infer<typeof ModeloPrecioSchema>;
export type ModelosPorRol = z.infer<typeof ModelosPorRolSchema>;
export type Limites = z.infer<typeof LimitesSchema>;
export type Aprobaciones = z.infer<typeof AprobacionesSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type PoliticaComandos = z.infer<typeof PoliticaComandosSchema>;
export type Notificaciones = z.infer<typeof NotificacionesSchema>;
export type BatutaConfig = z.infer<typeof BatutaConfigSchema>;

/** Valida un valor ya parseado (objeto YAML) como configuración. */
export function parseBatutaConfig(data: unknown): BatutaConfig {
  const result = BatutaConfigSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Configuración inválida: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Parsea el texto de un `batuta.yaml` y lo valida.
 * Un YAML sintácticamente inválido o que no produce un objeto falla
 * con un mensaje que lo indica.
 */
export function parseBatutaConfigYaml(yamlText: string): BatutaConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText) as unknown;
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuración inválida: YAML malformado: ${detalle}`);
  }
  return parseBatutaConfig(raw);
}

/**
 * Única E/S permitida en este hito: lee un archivo `batuta.yaml` y lo
 * valida. No escribe nada ni toca la red.
 */
export async function loadBatutaConfig(filePath: string): Promise<BatutaConfig> {
  const text = await readFile(filePath, "utf8");
  return parseBatutaConfigYaml(text);
}
