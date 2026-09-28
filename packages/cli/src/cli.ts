import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TenancyError, type Logger } from '@tenancy-node/core';
import {
  EXIT,
  UsageError,
  type Command,
  type CommandContext,
  type OptionsConfig,
  type ParsedArgs,
} from './command.js';
import {
  keyGenerateCommand,
  keyRotateCommand,
  moveCommand,
  migrateCommand,
  migrateStatusCommand,
  rollbackCommand,
  runCommand,
  seedCommand,
  serversAddCommand,
  serversListCommand,
} from './commands/database.js';
import { initCommand } from './commands/init.js';
import { createCommand, deleteCommand, installCommand, listCommand } from './commands/tenants.js';
import { schemaCommand, workerCommand } from './commands/runtime.js';
import { outboxRelayCommand, outboxRetryCommand, outboxStatusCommand } from './commands/events.js';
import { adminServeCommand, adminUserCommand } from './commands/admin.js';
import { loadTenancy, type CliTenancy } from './config-loader.js';
import { processIO, type CliIO } from './io.js';
import { Output, formatDuration } from './output.js';
import { StreamLogger } from './stream-logger.js';

export const COMMANDS: readonly Command[] = [
  initCommand,
  installCommand,
  createCommand,
  listCommand,
  deleteCommand,
  migrateCommand,
  migrateStatusCommand,
  rollbackCommand,
  seedCommand,
  runCommand,
  serversAddCommand,
  serversListCommand,
  keyGenerateCommand,
  keyRotateCommand,
  moveCommand,
  schemaCommand,
  workerCommand,
  outboxRelayCommand,
  outboxStatusCommand,
  outboxRetryCommand,
  adminUserCommand,
  adminServeCommand,
];

const GLOBAL_OPTIONS: OptionsConfig = {
  config: { type: 'string', short: 'c' },
  verbose: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  'log-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const GLOBAL_HELP: Record<string, string> = {
  config: 'Ruta de la configuración (por defecto tenancy.config.* en el directorio actual)',
  verbose: 'Mostrar todos los logs (JSON, a stderr) y los stacks de los errores',
  'log-file': 'Guardar todos los logs JSON en este archivo (también TENANCY_LOG_FILE)',
  json: 'Salida en JSON para scripts',
  'no-color': 'Sin colores',
  help: 'Ayuda',
};

export interface MainOptions {
  io?: CliIO;
  /** Reemplaza la carga de tenancy.config (tests). */
  load?: (logger: Logger) => Promise<CliTenancy>;
  /** Alias de módulos para cargar la configuración (tests). */
  alias?: Record<string, string>;
  /** Detiene los comandos de larga duración. Por defecto, SIGINT/SIGTERM del proceso. */
  signal?: AbortSignal;
}

function processSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function optionFlag(name: string, config: OptionsConfig[string]): string {
  const short = config.short ? `-${config.short}, ` : '';
  return `${short}--${name}${config.type === 'string' ? '=<valor>' : ''}`;
}

function commandHelp(out: Output, command: Command): void {
  out.line(out.paint('bold', command.summary));
  out.line();
  out.line(`Uso: ${command.usage}`);
  const entries = Object.entries(command.options ?? {});
  if (entries.length > 0) {
    out.line();
    out.line('Opciones:');
    for (const [name, config] of entries) {
      out.line(`  ${optionFlag(name, config).padEnd(28)} ${command.help?.[name] ?? ''}`);
    }
  }
  out.line();
  out.line('Globales:');
  for (const [name, config] of Object.entries(GLOBAL_OPTIONS)) {
    if (name === 'version') continue;
    out.line(`  ${optionFlag(name, config).padEnd(28)} ${GLOBAL_HELP[name] ?? ''}`);
  }
}

function generalHelp(out: Output): void {
  out.line(`${out.paint('bold', 'tenancy')} ${version()} — multi-tenancy para Node.js`);
  out.line();
  out.line('Uso: tenancy <comando> [opciones]');
  out.line();
  out.line('Comandos:');
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const command of COMMANDS) out.line(`  ${command.name.padEnd(width)}  ${command.summary}`);
  out.line();
  out.line('Ayuda de un comando: tenancy <comando> --help');
}

/**
 * Ejecuta el CLI y devuelve el código de salida:
 * 0 = bien, 1 = la operación falló (o falló en algún tenant), 2 = uso o configuración inválidos.
 */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const io = options.io ?? processIO();
  const [name, ...rest] = argv;
  const wantsJson = argv.includes('--json');
  let out = new Output(io, { json: wantsJson, color: !argv.includes('--no-color') });

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    const target = name === 'help' ? COMMANDS.find((c) => c.name === rest[0]) : undefined;
    if (target) commandHelp(out, target);
    else generalHelp(out);
    return EXIT.ok;
  }
  if (name === '--version') {
    io.stdout.write(`${version()}\n`);
    return EXIT.ok;
  }

  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    out.error(`Comando desconocido "${name}". Usa "tenancy --help".`);
    return EXIT.usage;
  }

  let args: ParsedArgs;
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true,
    });
    args = { values: parsed.values as ParsedArgs['values'], positionals: parsed.positionals };
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    out.line(`Uso: ${command.usage}`);
    return EXIT.usage;
  }
  if (args.values.help) {
    commandHelp(out, command);
    return EXIT.ok;
  }

  const verbose = args.values.verbose === true;
  out = new Output(io, {
    json: args.values.json === true,
    color: args.values['no-color'] !== true,
  });
  const logFile =
    typeof args.values['log-file'] === 'string' ? args.values['log-file'] : io.env.TENANCY_LOG_FILE;
  let fileStream: ReturnType<typeof createWriteStream> | undefined;
  if (logFile) {
    const target = path.resolve(io.cwd, logFile);
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      fileStream = createWriteStream(target, { flags: 'a' });
      fileStream.on('error', (error) =>
        out.warn(`No se pudo escribir el log en ${logFile}: ${error.message}`),
      );
    } catch (error) {
      out.warn(
        `No se pudo abrir el log ${logFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const logger = new StreamLogger(
    [
      { stream: io.stderr, level: verbose ? 'debug' : 'error' },
      ...(fileStream ? [{ stream: fileStream, level: 'debug' as const }] : []),
    ],
    { component: 'tenancy-cli' },
  );

  let loaded: CliTenancy | undefined;
  let lazySignal: AbortSignal | undefined;
  const context: CommandContext = {
    args,
    out,
    io,
    verbose,
    // Se crea solo si el comando la usa (worker), así no se acumulan listeners en el proceso.
    get signal() {
      return (lazySignal ??= options.signal ?? processSignal());
    },
    tenancy: async () => {
      if (loaded) return loaded;
      loaded = options.load
        ? await options.load(logger)
        : (
            await loadTenancy({
              cwd: io.cwd,
              configPath: typeof args.values.config === 'string' ? args.values.config : undefined,
              logger,
              ...(options.alias ? { alias: options.alias } : {}),
            })
          ).tenancy;
      return loaded;
    },
  };

  const started = performance.now();
  let code: number = EXIT.failed;
  try {
    code = await command.run(context);
    return code;
  } catch (error) {
    code =
      error instanceof UsageError
        ? EXIT.usage
        : error instanceof TenancyError && error.code === 'TENANCY_INVALID_CONFIG'
          ? EXIT.usage
          : EXIT.failed;
    // Los errores del paquete ya quedaron registrados (con su tenant) por la operación que falló.
    if (loaded && code === EXIT.failed && !(error instanceof TenancyError)) {
      loaded.observability.report(`cli.${command.name}`, error);
    }
    if (error instanceof UsageError) {
      out.error(error.message);
      out.line(`Uso: ${command.usage}`);
    } else out.error(out.describeError(error, verbose));
    return code;
  } finally {
    if (loaded) {
      loaded.observability.logger.info(
        {
          operation: `cli.${command.name}`,
          outcome: code === EXIT.ok ? 'success' : 'error',
          exitCode: code,
          durationMs: Math.round(performance.now() - started),
        },
        `tenancy ${command.name} finished in ${formatDuration(performance.now() - started)}`,
      );
      await loaded.close();
    }
    if (fileStream) await new Promise<void>((resolve) => fileStream.end(resolve));
  }
}
