import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunStore,
  applyEvent,
  dirCheckpoints,
  existeProceso,
  generarRunId,
  nombreCheckpoint,
  rebuildState,
  rutaBloqueoRun,
  rutaEstado,
  rutaEventos,
  type NuevoEvento,
} from "../src/index.js";
import {
  SistemaArchivosMemoria,
  crearRelojFijo,
  guionCicloCompleto,
} from "./helpers.js";

const BATUTA = ".batuta";

function nuevoStore(opciones?: {
  comprobarProceso?: (pid: number) => boolean;
  equipo?: string;
}): {
  fs: SistemaArchivosMemoria;
  reloj: ReturnType<typeof crearRelojFijo>;
  store: RunStore;
} {
  const fs = new SistemaArchivosMemoria();
  const reloj = crearRelojFijo();
  return {
    fs,
    reloj,
    store: new RunStore(
      BATUTA,
      fs,
      reloj,
      opciones?.comprobarProceso,
      opciones?.equipo,
    ),
  };
}

async function cicloCompleto(
  store: RunStore,
  reloj: ReturnType<typeof crearRelojFijo>,
  guion: NuevoEvento[] = guionCicloCompleto(),
): Promise<string> {
  const runId = await store.iniciarEjecucion();
  for (const paso of guion) {
    reloj.avanzar();
    await store.agregar(runId, paso);
  }
  return runId;
}

function resumenEstado(estado: {
  estado: string;
  presupuesto_acumulado_usd: number;
  modelo_activo: string | null;
  puerta_pendiente: string | null;
}): object {
  return {
    estado: estado.estado,
    presupuesto_acumulado_usd: estado.presupuesto_acumulado_usd,
    modelo_activo: estado.modelo_activo,
    puerta_pendiente: estado.puerta_pendiente,
  };
}

describe("almacén de ejecución (CA-1, CA-3, CA-5, CA-6)", () => {
  it("genera run_id RUN-AAAA-MM-DD-NNN secuenciales por día", async () => {
    expect(generarRunId("2026-10-09T12:00:00.000Z", [])).toBe(
      "RUN-2026-10-09-001",
    );
    expect(
      generarRunId("2026-10-09T23:00:00.000Z", [
        "RUN-2026-10-09-001",
        "RUN-2026-10-09-002",
        "RUN-2026-10-10-001",
      ]),
    ).toBe("RUN-2026-10-09-003");
    expect(() => generarRunId("no-fecha", [])).toThrow(/fecha inválida/);
    const { store } = nuevoStore();
    const primero = await store.iniciarEjecucion();
    const segundo = await store.iniciarEjecucion();
    expect(primero).toBe("RUN-2026-10-09-001");
    expect(segundo).toBe("RUN-2026-10-09-002");
  });

  it("añadir y releer devuelve la misma secuencia validada (CA-1)", async () => {
    const { store } = nuevoStore();
    const runId = await store.iniciarEjecucion();
    await store.agregar(runId, {
      tipo: "aprobacion_solicitada",
      payload: { puerta: "H0" },
    });
    await store.agregar(runId, {
      tipo: "aprobacion_otorgada",
      payload: { puerta: "H0" },
    });
    const lectura = await store.leer(runId);
    expect(lectura.truncado).toBe(false);
    expect(lectura.eventos.map((e) => [e.id, e.tipo])).toEqual([
      ["E-000001", "ejecucion_iniciada"],
      ["E-000002", "aprobacion_solicitada"],
      ["E-000003", "aprobacion_otorgada"],
    ]);
    for (const evento of lectura.eventos) {
      expect(evento.run_id).toBe(runId);
    }
  });

  it("valida antes de escribir y no agrega la línea inválida", async () => {
    const { fs, store } = nuevoStore();
    const runId = await store.iniciarEjecucion();
    await expect(
      store.agregar(runId, { tipo: "plan_creado" }),
    ).rejects.toThrow(/Transición imposible/);
    const crudo = fs.verArchivo(rutaEventos(BATUTA, runId));
    expect(crudo?.split("\n").filter((l) => l !== "")).toHaveLength(1);
  });

  it("tras una cola cortada exige restaurar antes de agregar", async () => {
    const { fs, store } = nuevoStore();
    const runId = await store.iniciarEjecucion();
    await fs.agregarArchivo(rutaEventos(BATUTA, runId), '{"id": "E-000002"');
    await expect(
      store.agregar(runId, { tipo: "spec_creada" }),
    ).rejects.toThrow(/restaurar/);
  });

  it("un solo escritor: el bloqueo ocupado falla si el proceso sigue vivo (CA-9)", async () => {
    const { fs, store } = nuevoStore({
      comprobarProceso: (p: number) => p === 9999,
      equipo: "mi-host",
    });
    const runId = await store.iniciarEjecucion();
    const bloqueo = rutaBloqueoRun(BATUTA, runId);
    await fs.escribirArchivo(
      bloqueo,
      JSON.stringify({ pid: 9999, equipo: "mi-host", hora: "2026-10-09T10:00:00Z" }),
    );
    await expect(
      store.agregar(runId, { tipo: "spec_creada" }),
    ).rejects.toThrow(/sigue activo/);
  });

  it("un solo escritor: el bloqueo falla si pertenece a otro equipo", async () => {
    const { fs, store } = nuevoStore({
      equipo: "mi-host",
    });
    const runId = await store.iniciarEjecucion();
    const bloqueo = rutaBloqueoRun(BATUTA, runId);
    await fs.escribirArchivo(
      bloqueo,
      JSON.stringify({ pid: 8888, equipo: "otro-host", hora: "2026-10-09T10:00:00Z" }),
    );
    await expect(
      store.agregar(runId, { tipo: "spec_creada" }),
    ).rejects.toThrow(/otro-host/);
  });

  it("recuperación de bloqueo obsoleto: si el proceso ya no existe se recupera y deja constancia en el registro (CA-9)", async () => {
    const { fs, store } = nuevoStore({
      comprobarProceso: () => false,
      equipo: "mi-host",
    });
    const runId = await store.iniciarEjecucion();
    const bloqueo = rutaBloqueoRun(BATUTA, runId);
    await fs.escribirArchivo(
      bloqueo,
      JSON.stringify({ pid: 7777, equipo: "mi-host", hora: "2026-10-09T09:00:00Z" }),
    );

    // Debe recuperarse sin error y agregar el evento
    const evento = await store.agregar(runId, { tipo: "spec_creada" });
    expect(evento.tipo).toBe("spec_creada");
    // El bloqueo debe haberse liberado al terminar
    expect(fs.verArchivo(bloqueo)).toBeUndefined();

    // Comprobar que en el registro quedó constancia (evento ejecucion_reanudada)
    const lectura = await store.leer(runId);
    expect(lectura.eventos.map((e) => e.tipo)).toEqual([
      "ejecucion_iniciada",
      "ejecucion_reanudada",
      "spec_creada",
    ]);
    const reanudacion = lectura.eventos[1];
    expect(reanudacion?.payload).toMatchObject({
      motivo: "bloqueo_obsoleto_recuperado",
      bloqueo_obsoleto_recuperado: { pid: 7777, equipo: "mi-host" },
    });

    // También dejó constancia en el log auxiliar
    const logBloqueos = fs.verArchivo(`${BATUTA}/runs/${runId}/logs/bloqueos.log`);
    expect(logBloqueos).toContain("Bloqueo obsoleto recuperado: PID 7777");
  });

  it("recuperación de bloqueo obsoleto durante restaurar (CA-9)", async () => {
    const { fs, store } = nuevoStore({
      comprobarProceso: () => false,
      equipo: "mi-host",
    });
    const runId = await store.iniciarEjecucion();
    const bloqueo = rutaBloqueoRun(BATUTA, runId);
    await fs.escribirArchivo(
      bloqueo,
      JSON.stringify({ pid: 6666, equipo: "mi-host", hora: "2026-10-09T08:00:00Z" }),
    );

    const resultado = await store.restaurar(runId);
    expect(resultado.estado.estado).toBe("INTAKE");
    expect(fs.verArchivo(bloqueo)).toBeUndefined();

    const lectura = await store.leer(runId);
    const reanudacion = lectura.eventos[lectura.eventos.length - 1];
    expect(reanudacion?.tipo).toBe("ejecucion_reanudada");
    expect(reanudacion?.payload).toMatchObject({
      bloqueo_obsoleto_recuperado: { pid: 6666, equipo: "mi-host" },
    });
  });

  it("existeProceso portable: reconoce el proceso actual y falla en PIDs inexistentes", () => {
    expect(existeProceso(process.pid)).toBe(true);
    expect(existeProceso(99999999)).toBe(false);
    expect(existeProceso(-1)).toBe(false);
    expect(existeProceso(0)).toBe(false);
  });

  it("el estado coincide con la reconstrucción y con checkpoint + cola (CA-3)", async () => {
    const { reloj, store } = nuevoStore();
    const guion = guionCicloCompleto();
    const runId = await store.iniciarEjecucion();
    const parcial = guion.slice(0, 14);
    for (const paso of parcial) {
      reloj.avanzar();
      await store.agregar(runId, paso);
    }
    const punto = await store.checkpoint(runId, null);
    expect(punto.ultimo_evento).toBe(15);
    expect(punto.commit).toBeNull();
    for (const paso of guion.slice(14)) {
      reloj.avanzar();
      await store.agregar(runId, paso);
    }
    const lectura = await store.leer(runId);
    const reconstruido = rebuildState(lectura.eventos);
    const guardado = await store.estado(runId);
    expect(guardado).toEqual(reconstruido);
    expect(resumenEstado(guardado)).toEqual({
      estado: "DONE",
      presupuesto_acumulado_usd: 1,
      modelo_activo: "m-fuerte",
      puerta_pendiente: null,
    });
    let desdeCheckpoint = punto.estado;
    for (const evento of lectura.eventos.slice(punto.ultimo_evento)) {
      desdeCheckpoint = applyEvent(desdeCheckpoint, evento);
    }
    expect(desdeCheckpoint).toEqual(reconstruido);
  });

  it("state.json se escribe de forma atómica y se reconstruye si se borra (CA-6)", async () => {
    const { fs, reloj, store } = nuevoStore();
    const runId = await cicloCompleto(store, reloj);
    const estadoTmp = `${rutaEstado(BATUTA, runId)}.tmp`.replace(/\\/g, "/");
    const renombres = fs.operaciones.filter((op) =>
      op.startsWith(`rename ${estadoTmp} -> `),
    );
    expect(renombres.length).toBeGreaterThan(0);
    expect(fs.verArchivo(`${rutaEstado(BATUTA, runId)}.tmp`)).toBeUndefined();
    const antes = await store.estado(runId);
    await fs.borrar(rutaEstado(BATUTA, runId));
    expect(await store.estado(runId)).toEqual(antes);
  });

  it("si state.json discrepa, gana el registro (CA-6)", async () => {
    const { fs, reloj, store } = nuevoStore();
    const runId = await cicloCompleto(store, reloj);
    const esperado = await store.estado(runId);
    expect(esperado.estado).toBe("DONE");
    await fs.escribirArchivo(
      rutaEstado(BATUTA, runId),
      JSON.stringify({ ...esperado, estado: "PLAN" }),
    );
    expect(await store.estado(runId)).toEqual(esperado);
    await fs.escribirArchivo(rutaEstado(BATUTA, runId), "{roto");
    expect(await store.estado(runId)).toEqual(esperado);
  });

  it("cortar tras cada evento, restaurar y continuar da el mismo final (CA-5)", async () => {
    const siembra = nuevoStore();
    const runId = await cicloCompleto(siembra.store, siembra.reloj);
    const crudo = siembra.fs.verArchivo(rutaEventos(BATUTA, runId));
    if (crudo === undefined) throw new Error("sin registro sembrado");
    const lineas = crudo.split("\n").filter((l) => l !== "");
    const guion = guionCicloCompleto();
    const finalReferencia = resumenEstado(await siembra.store.estado(runId));

    for (let corte = 1; corte <= lineas.length; corte += 1) {
      for (const conColaRota of [false, true]) {
        const fs = new SistemaArchivosMemoria();
        const reloj = crearRelojFijo("2026-10-10T08:00:00.000Z");
        const store = new RunStore(BATUTA, fs, reloj);
        const base = lineas.slice(0, corte).join("\n").concat("\n");
        await fs.escribirArchivo(
          rutaEventos(BATUTA, runId),
          conColaRota ? `${base}{"id": "E-ro` : base,
        );
        const resultado = await store.restaurar(runId);
        expect(resultado.colaDescartada).toBe(conColaRota);
        for (const paso of guion.slice(corte - 1)) {
          reloj.avanzar();
          await store.agregar(runId, paso);
        }
        expect(resumenEstado(await store.estado(runId))).toEqual(
          finalReferencia,
        );
      }
    }
  }, 60000);

  it("restaurar parte del último checkpoint válido e ignora el corrupto", async () => {
    const siembra = nuevoStore();
    const guion = guionCicloCompleto();
    const runId = await siembra.store.iniciarEjecucion();
    for (const paso of guion.slice(0, 17)) {
      siembra.reloj.avanzar();
      await siembra.store.agregar(runId, paso);
    }
    await siembra.store.checkpoint(runId, null);
    for (const paso of guion.slice(17, 20)) {
      siembra.reloj.avanzar();
      await siembra.store.agregar(runId, paso);
    }
    const crudo = siembra.fs.verArchivo(rutaEventos(BATUTA, runId));
    if (crudo === undefined) throw new Error("sin registro sembrado");
    const puntoCrudo = siembra.fs.verArchivo(
      join(dirCheckpoints(BATUTA, runId), nombreCheckpoint(18)),
    );
    if (puntoCrudo === undefined) throw new Error("sin checkpoint sembrado");

    const fs = new SistemaArchivosMemoria();
    const store = new RunStore(BATUTA, fs, crearRelojFijo());
    await fs.escribirArchivo(rutaEventos(BATUTA, runId), crudo);
    await fs.crearDir(dirCheckpoints(BATUTA, runId));
    await fs.escribirArchivo(
      join(dirCheckpoints(BATUTA, runId), nombreCheckpoint(18)),
      puntoCrudo,
    );
    await fs.escribirArchivo(
      join(dirCheckpoints(BATUTA, runId), "checkpoint-000099.json"),
      "{corrupto",
    );
    const resultado = await store.restaurar(runId);
    expect(resultado.desdeCheckpoint).toBe(true);
    expect(resultado.eventosReproducidos).toBe(3);
    const lectura = await store.leer(runId);
    expect(rebuildState(lectura.eventos)).toEqual(resultado.estado);
  });
});
