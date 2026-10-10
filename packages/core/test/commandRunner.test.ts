import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BufferTruncado,
  construirEntornoLimpio,
  EjecutorComandosReal,
  existeProceso,
  matarArbolProcesos,
  separarComandoYArgumentos,
} from "../src/index.js";

describe("BufferTruncado (CA-3)", () => {
  it("conserva salidas que no superan el límite sin descartar nada", () => {
    const buf = new BufferTruncado(1024);
    buf.agregar(Buffer.from("Hola mundo"));
    const res = buf.obtenerResultado();
    expect(res.texto).toBe("Hola mundo");
    expect(res.descartados).toBe(0);
  });

  it("trunca conservando principio y final con el recuento exacto de bytes descartados", () => {
    const limite = 256;
    const buf = new BufferTruncado(limite);

    const inicio = "INICIO-DE-PRUEBA-";
    const medio = "X".repeat(1000);
    const fin = "-FIN-DE-PRUEBA";
    const total = `${inicio}${medio}${fin}`;

    buf.agregar(Buffer.from(total));
    const res = buf.obtenerResultado();

    expect(res.texto.startsWith(inicio)).toBe(true);
    expect(res.texto.endsWith(fin)).toBe(true);
    expect(res.descartados).toBeGreaterThan(0);
    expect(res.texto).toContain(`[... descartados ${res.descartados} bytes ...]`);

    // La suma de los bytes conservados más los descartados debe ser el total exacto
    const mitad = Math.floor(limite / 2);
    expect(res.descartados).toBe(Buffer.byteLength(total) - mitad * 2);
  });

  it("no hace crecer la memoria acumulando chunks en streaming ilimitado", () => {
    const limite = 512;
    const buf = new BufferTruncado(limite);

    // Enviar 1000 chunks de 1 KB cada uno (1 MB total)
    const chunk = Buffer.from("A".repeat(1024));
    for (let i = 0; i < 1000; i++) {
      buf.agregar(chunk);
    }

    const res = buf.obtenerResultado();
    expect(res.descartados).toBe(1000 * 1024 - 512);
    expect(res.texto.length).toBeLessThan(1024); // Acotado en tamaño
  });
});

describe("construirEntornoLimpio (CA-4)", () => {
  it("retiene solo variables permitidas y extras, descartando secretos del entorno", () => {
    const entornoSucio: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      SECRET_KEY: "super_secret_value",
      GITHUB_TOKEN: "ghp_123456789",
      NODE_ENV: "test",
      API_PASSWORD: "secret_password",
    };

    const extras = {
      DATABASE_URL: "file:./test.db",
      AUTH_SECRET: "test-auth-secret",
    };

    const limpio = construirEntornoLimpio(entornoSucio, extras);

    // Permitidas presentes
    expect(limpio.PATH).toBe("/usr/bin:/bin");
    expect(limpio.NODE_ENV).toBe("test");

    // Extras presentes
    expect(limpio.DATABASE_URL).toBe("file:./test.db");
    expect(limpio.AUTH_SECRET).toBe("test-auth-secret");

    // Secretos del entorno excluidos
    expect(limpio.SECRET_KEY).toBeUndefined();
    expect(limpio.GITHUB_TOKEN).toBeUndefined();
    expect(limpio.API_PASSWORD).toBeUndefined();
  });
});

describe("separarComandoYArgumentos", () => {
  it("separa comandos simples por espacios", () => {
    const { ejecutable, args } = separarComandoYArgumentos("git status --short");
    expect(ejecutable).toBe("git");
    expect(args).toEqual(["status", "--short"]);
  });

  it("respeta argumentos con comillas dobles y comillas simples anidadas", () => {
    const { ejecutable, args } = separarComandoYArgumentos(
      'node -e "console.log(\'hola\');"',
    );
    expect(ejecutable).toBe("node");
    expect(args).toEqual(["-e", "console.log('hola');"]);
  });

  it("respeta rutas con barras invertidas de Windows sin escapar letras", () => {
    const { ejecutable, args } = separarComandoYArgumentos(
      'C:\\Users\\bin\\app.exe --dir "C:\\Archivos de Programa"',
    );
    expect(ejecutable).toBe("C:\\Users\\bin\\app.exe");
    expect(args).toEqual(["--dir", "C:\\Archivos de Programa"]);
  });
});

describe("EjecutorComandosReal", () => {
  const ejecutor = new EjecutorComandosReal();

  it("devuelve código de salida, salida estándar, error y duración en éxito y fallo (CA-1)", async () => {
    // Éxito
    const exito = await ejecutor.ejecutar(
      'node -e "console.log(\'hola stdout\'); process.exit(0);"',
    );
    expect(exito.codigoSalida).toBe(0);
    expect(exito.salidaEstandar.trim()).toBe("hola stdout");
    expect(exito.salidaError).toBe("");
    expect(exito.timeoutVencido).toBe(false);
    expect(exito.duracionMs).toBeGreaterThanOrEqual(0);

    // Fallo
    const fallo = await ejecutor.ejecutar(
      'node -e "console.error(\'error stderr\'); process.exit(42);"',
    );
    expect(fallo.codigoSalida).toBe(42);
    expect(fallo.salidaError.trim()).toBe("error stderr");
    expect(fallo.timeoutVencido).toBe(false);
    expect(fallo.duracionMs).toBeGreaterThanOrEqual(0);
  });

  it("comando que supera timeout se termina, vence y mata a todo el árbol incluido el nieto (CA-2)", async () => {
    // El hijo crea un nieto y ambos entran en bucle. El hijo imprime el PID del nieto.
    const comando = [
      'node -e "',
      "const cp = require('node:child_process');",
      "const g = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 200)'], { stdio: 'ignore' });",
      "console.log('NIETO:' + g.pid);",
      "setInterval(() => {}, 200);",
      '"',
    ].join(" ");

    const res = await ejecutor.ejecutar(comando, {
      timeoutMs: 400,
    });

    expect(res.timeoutVencido).toBe(true);

    // Extraer el PID del nieto de la salida estándar
    const match = res.salidaEstandar.match(/NIETO:(\d+)/);
    expect(match).not.toBeNull();
    const nietoPid = parseInt(match![1], 10);
    expect(nietoPid).toBeGreaterThan(0);

    // Esperar a que el SO procese la terminación del árbol (sondeo hasta 3 s)
    let nietoVivo = true;
    for (let i = 0; i < 60; i++) {
      nietoVivo = existeProceso(nietoPid);
      if (!nietoVivo) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // El nieto debe estar muerto
    if (nietoVivo) {
      matarArbolProcesos(nietoPid); // Limpieza de seguridad
    }
    expect(nietoVivo).toBe(false);
  });

  it("trunca salidas grandes conservando principio y final y reporta bytes descartados (CA-3)", async () => {
    const res = await ejecutor.ejecutar(
      'node -e "console.log(\'START_\' + \'B\'.repeat(10000) + \'_END\')"',
      {
        limiteSalidaBytes: 500,
      },
    );

    expect(res.codigoSalida).toBe(0);
    expect(res.salidaEstandar.startsWith("START_")).toBe(true);
    expect(res.salidaEstandar.endsWith("_END\n") || res.salidaEstandar.endsWith("_END\r\n")).toBe(true);
    expect(res.bytesDescartadosStdout).toBeGreaterThan(0);
    expect(res.salidaEstandar).toContain(
      `[... descartados ${res.bytesDescartadosStdout} bytes ...]`,
    );
  });

  it("variables fuera de lista permitida no llegan, y permitidas y extras sí (CA-4)", async () => {
    process.env.VARIABLE_SECRETA_BATUTA = "no_deberia_llegar";

    const res = await ejecutor.ejecutar(
      'node -e "console.log(JSON.stringify({ secreta: process.env.VARIABLE_SECRETA_BATUTA, extra: process.env.EXTRA_GATE }))"',
      {
        entornoExtra: {
          EXTRA_GATE: "valor_extra_permitido",
        },
      },
    );

    delete process.env.VARIABLE_SECRETA_BATUTA;

    expect(res.codigoSalida).toBe(0);
    const valores = JSON.parse(res.salidaEstandar.trim()) as {
      secreta?: string;
      extra?: string;
    };
    expect(valores.secreta).toBeUndefined();
    expect(valores.extra).toBe("valor_extra_permitido");
  });

  it("comando inexistente o directorio inexistente devuelven resultado claro sin lanzar excepción (CA-5)", async () => {
    // Directorio inexistente
    const resDir = await ejecutor.ejecutar('node -e "console.log(1)"', {
      cwd: join(process.cwd(), "directorio_que_no_existe_xyz_123"),
    });
    expect(resDir.codigoSalida).toBeNull();
    expect(resDir.salidaError).toMatch(/no existe/i);
    expect(resDir.timeoutVencido).toBe(false);

    // Comando inexistente
    const resCmd = await ejecutor.ejecutar(
      "comando_absolutamente_inexistente_batuta_456",
    );
    expect(resCmd.codigoSalida).not.toBe(0);
    expect(resCmd.salidaError.length).toBeGreaterThan(0);
    expect(resCmd.timeoutVencido).toBe(false);
  });

  it("shell vale false por defecto y ejecuta comandos directos sin invocar shell", async () => {
    const res = await ejecutor.ejecutar('node -e "console.log(\'directo sin shell\')"');
    expect(res.codigoSalida).toBe(0);
    expect(res.salidaEstandar.trim()).toBe("directo sin shell");
  });

  it("puede ejecutar npm --version en Linux y en Windows pasando shell: true (CA-6)", async () => {
    const res = await ejecutor.ejecutar("npm --version", { shell: true });
    expect(res.codigoSalida).toBe(0);
    expect(res.salidaEstandar.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("ejecutarArgs ejecuta por vector de argumentos preservando comillas y caracteres especiales exactamente (Hito 5 Ajuste)", async () => {
    const argumentoEspecial = 'arg con "comillas dobles", \'simples\', \\ y saltos\nde\nlinea';
    const res = await ejecutor.ejecutarArgs(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", argumentoEspecial],
    );
    expect(res.codigoSalida).toBe(0);
    expect(res.salidaEstandar).toBe(argumentoEspecial);
  });
});
