'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function listFiles(cwd, rel, predicate, limit = 160) {
  const root = path.resolve(cwd, rel);
  const out = [];
  if (!fs.existsSync(root)) return out;
  function walk(dir) {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (['.git', 'node_modules', 'dist', 'build', 'target', '__pycache__', '.xoloop'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath, absolute)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function packageDependencyNames(pkg) {
  const out = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

function detectStateTools(cwd, pkg) {
  const deps = packageDependencyNames(pkg);
  const out = [];
  const add = (name, reason, files = []) => out.push({ name, reason, files });
  if (fs.existsSync(path.join(cwd, 'prisma', 'schema.prisma')) || deps.has('prisma') || deps.has('@prisma/client')) add('prisma', 'schema/dependency', ['prisma/schema.prisma'].filter((file) => fs.existsSync(path.join(cwd, file))));
  if (fs.existsSync(path.join(cwd, 'drizzle.config.ts')) || fs.existsSync(path.join(cwd, 'drizzle.config.js')) || deps.has('drizzle-orm')) add('drizzle', 'config/dependency');
  if (['knexfile.js', 'knexfile.ts', 'knexfile.cjs', 'knexfile.mjs'].some((file) => fs.existsSync(path.join(cwd, file))) || deps.has('knex')) add('knex', 'config/dependency');
  if (fs.existsSync(path.join(cwd, 'db', 'schema.rb')) || fs.existsSync(path.join(cwd, 'db', 'migrate'))) add('rails-active-record', 'db/schema.rb or db/migrate');
  if (fs.existsSync(path.join(cwd, 'manage.py')) && listFiles(cwd, '.', (rel) => /(^|\/)migrations\/\d+.*\.py$/i.test(rel), 20).length > 0) add('django-migrations', 'manage.py and migrations');
  if (fs.existsSync(path.join(cwd, 'alembic.ini')) || fs.existsSync(path.join(cwd, 'alembic'))) add('alembic', 'alembic config');
  if (fs.existsSync(path.join(cwd, 'go.mod')) && /(gorm|sqlc|entgo|bun)/i.test(readText(path.join(cwd, 'go.mod')))) add('go-state', 'go.mod dependency');
  if (fs.existsSync(path.join(cwd, 'Cargo.toml')) && /(diesel|sqlx|sea-orm)/i.test(readText(path.join(cwd, 'Cargo.toml')))) add('rust-state', 'Cargo.toml dependency');
  return out;
}

function commandExists(name) {
  const paths = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return paths.some((dir) => fs.existsSync(path.join(dir, name)));
}

function detectNativeAdapters(cwd, pkg) {
  const deps = packageDependencyNames(pkg);
  const out = [];
  const add = (kind, reason, cli, env = []) => out.push({
    kind,
    reason,
    cli,
    cli_available: cli ? commandExists(cli) : false,
    env,
  });
  if (deps.has('pg') || deps.has('postgres') || /postgres/i.test(readText(path.join(cwd, 'docker-compose.yml'))) || process.env.DATABASE_URL) add('postgres', 'dependency/compose/env', 'psql', ['DATABASE_URL', 'PGHOST', 'PGDATABASE']);
  if (deps.has('mysql2') || deps.has('mysql') || /mysql|mariadb/i.test(readText(path.join(cwd, 'docker-compose.yml'))) || process.env.MYSQL_URL) add('mysql', 'dependency/compose/env', 'mysql', ['MYSQL_URL', 'MYSQL_HOST', 'MYSQL_DATABASE']);
  if (deps.has('sqlite3') || deps.has('better-sqlite3') || listFiles(cwd, '.', (rel) => /\.(sqlite|sqlite3|db)$/i.test(rel), 20).length > 0) add('sqlite', 'dependency/file', 'sqlite3', ['SQLITE_DATABASE']);
  if (deps.has('redis') || deps.has('ioredis') || /redis/i.test(readText(path.join(cwd, 'docker-compose.yml'))) || process.env.REDIS_URL) add('redis', 'dependency/compose/env', 'redis-cli', ['REDIS_URL']);
  return out;
}

function detectStateScripts(pkg) {
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const out = [];
  for (const [name, command] of Object.entries(scripts)) {
    const text = `${name} ${command}`.toLowerCase();
    const kind = /seed|fixture/.test(text) ? 'seed'
      : /reset|clean|truncate/.test(text) ? 'reset'
      : /snapshot|dump|export/.test(text) ? 'snapshot'
        : /rollback|down|revert/.test(text) ? 'rollback'
          : /migrat|prisma|drizzle|knex|db:/.test(text) ? 'migration'
            : /test/.test(text) ? 'test'
              : 'other';
    if (kind !== 'other') out.push({ id: `script-${name}`, command: `npm run ${name}`, kind });
  }
  return out;
}

function detectDevOrchestration(cwd) {
  const files = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
    '.devcontainer/devcontainer.json',
  ].filter((file) => fs.existsSync(path.join(cwd, file)));
  const text = files.map((file) => readText(path.join(cwd, file))).join('\n');
  const services = [];
  if (/postgres/i.test(text)) services.push('postgres');
  if (/mysql|mariadb/i.test(text)) services.push('mysql');
  if (/redis/i.test(text)) services.push('redis');
  if (/sqlite/i.test(text)) services.push('sqlite');
  const composeFile = files.find((file) => /compose/.test(file));
  const devcontainerFile = files.find((file) => file === '.devcontainer/devcontainer.json');
  return {
    files,
    services: [...new Set(services)].sort(),
    suggested_start_command: composeFile
      ? `docker compose -f ${composeFile} up -d`
      : (devcontainerFile ? 'devcontainer up --workspace-folder .' : ''),
    suggested_ready_command: composeFile
      ? `docker compose -f ${composeFile} ps`
      : (devcontainerFile ? 'devcontainer read-configuration --workspace-folder .' : ''),
    suggested_stop_command: composeFile ? `docker compose -f ${composeFile} down` : '',
  };
}

function detectMigrationFiles(cwd) {
  return listFiles(cwd, '.', (rel) => {
    if (/(^|\/)(migrations?|db\/migrate|prisma\/migrations|alembic\/versions)\//i.test(rel)) return /\.(sql|js|cjs|mjs|ts|py|rb)$/i.test(rel);
    return /(^|\/)\d{8,}.*\.(sql|js|cjs|mjs|ts|py|rb)$/i.test(rel);
  }, 160);
}

function detectSchemaFiles(cwd) {
  return [
    ...listFiles(cwd, '.', (rel) => /(^|\/)schema\.(prisma|sql|rb|graphql|json)$/i.test(rel), 80),
    ...listFiles(cwd, '.', (rel) => /(^|\/)(drizzle|knexfile|database)\.(config\.)?(js|cjs|mjs|ts|json)$/i.test(rel), 80),
    ...listFiles(cwd, '.', (rel) => /(^|\/)(alembic\.ini|db\/structure\.sql)$/i.test(rel), 40),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
}

function detectStateFiles(cwd) {
  return listFiles(cwd, '.', (rel, abs) => {
    if (!/\.(js|cjs|mjs|ts|py|rb|go|rs|sql)$/i.test(rel)) return false;
    if (/(^|\/)(models?|entities|repositories|dao|stores?|state|db|database)\//i.test(rel)) return true;
    const text = readText(abs);
    return /(transaction|rollback|tenant_id|tenantId|INSERT INTO|UPDATE\s+\w+|DELETE FROM|CREATE TABLE|ALTER TABLE|SELECT\s+.*FROM)/i.test(text);
  }, 180);
}

function scanStateRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkg = readJson(path.join(root, 'package.json'));
  const migrationFiles = detectMigrationFiles(root);
  const schemaFiles = detectSchemaFiles(root);
  const stateFiles = detectStateFiles(root);
  const scripts = detectStateScripts(pkg);
  const tools = detectStateTools(root, pkg);
  const adapters = detectNativeAdapters(root, pkg);
  const orchestration = detectDevOrchestration(root);
  const artifactPaths = [
    pkg ? 'package.json' : null,
    ...schemaFiles,
    ...migrationFiles,
    ...stateFiles.slice(0, 80),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const gaps = [];
  if (tools.length === 0) gaps.push('no obvious database/state framework detected');
  if (adapters.length === 0) gaps.push('no native Postgres/MySQL/SQLite/Redis adapter detected');
  if (migrationFiles.length === 0) gaps.push('no migration files detected');
  if (scripts.filter((script) => script.kind === 'snapshot').length === 0) gaps.push('no snapshot/dump script detected');
  if (scripts.filter((script) => script.kind === 'rollback').length === 0) gaps.push('no rollback script detected');
  if (scripts.filter((script) => script.kind === 'seed').length === 0) gaps.push('no fixture seed script detected');
  if (orchestration.files.length === 0) gaps.push('no docker compose/devcontainer orchestration detected');
  return {
    schema: 'xoloop.state_scan.v0.1',
    cwd: root,
    tools,
    adapters,
    orchestration,
    safe_commands: scripts,
    migration_files: migrationFiles,
    schema_files: schemaFiles,
    state_files: stateFiles,
    artifact_paths: artifactPaths,
    gaps,
  };
}

module.exports = {
  scanStateRepo,
};
