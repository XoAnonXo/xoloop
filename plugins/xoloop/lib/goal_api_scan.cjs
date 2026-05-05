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

function parseYamlOrJson(text, filePath) {
  if (/\.json$/i.test(filePath)) {
    try { return JSON.parse(text); } catch (_err) { return null; }
  }
  try {
    // eslint-disable-next-line global-require
    return require('yaml').parse(text);
  } catch (_err) {
    return null;
  }
}

function listFiles(cwd, rel, predicate, limit = 120) {
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
      if (['.git', 'node_modules', 'dist', 'build', 'target', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath, absolute)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function dependencyNames(pkg) {
  const out = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

function detectFrameworks(cwd, pkg) {
  const deps = dependencyNames(pkg);
  const out = [];
  const add = (name, reason) => out.push({ name, reason });
  if (deps.has('express')) add('express', 'dependency');
  if (deps.has('fastify')) add('fastify', 'dependency');
  if (deps.has('@nestjs/core')) add('nestjs', 'dependency');
  if (deps.has('koa')) add('koa', 'dependency');
  if (deps.has('hono')) add('hono', 'dependency');
  if (deps.has('graphql') || deps.has('apollo-server') || deps.has('@apollo/server')) add('graphql', 'dependency');
  if (fs.existsSync(path.resolve(cwd, 'go.mod')) && /gin-gonic|chi|fiber/.test(readText(path.resolve(cwd, 'go.mod')))) add('go-http', 'go.mod');
  if (fs.existsSync(path.resolve(cwd, 'pyproject.toml')) && /(fastapi|flask|django|starlite|litestar)/i.test(readText(path.resolve(cwd, 'pyproject.toml')))) add('python-http', 'pyproject.toml');
  return out;
}

function detectDatabaseAdapters(cwd, pkg) {
  const deps = dependencyNames(pkg);
  const out = [];
  const add = (name, reason, snapshotHint) => out.push({ name, reason, snapshot_hint: snapshotHint });
  if (deps.has('prisma') || deps.has('@prisma/client') || fs.existsSync(path.resolve(cwd, 'prisma', 'schema.prisma'))) {
    add('prisma', 'dependency-or-schema', 'Prefer a non-destructive JSON snapshot command using Prisma Client inside setup/teardown hooks.');
  }
  if (deps.has('pg') || deps.has('postgres')) add('postgres', 'dependency', 'Use pg_dump --data-only --schema-only=false against an isolated test database, or a SELECT-to-JSON snapshot command.');
  if (deps.has('mysql') || deps.has('mysql2')) add('mysql', 'dependency', 'Use mysqldump against an isolated test database, or a SELECT-to-JSON snapshot command.');
  if (deps.has('sqlite3') || deps.has('better-sqlite3') || listFiles(cwd, '.', (rel) => /\.(sqlite|sqlite3|db)$/i.test(rel), 8).length > 0) {
    add('sqlite', 'dependency-or-file', 'Use db_snapshot.adapter: sqlite-file with a test database file path, or dump tables to JSON.');
  }
  if (deps.has('mongoose') || deps.has('mongodb')) add('mongodb', 'dependency', 'Use mongodump against an isolated test database, or a collection-to-JSON snapshot command.');
  if (deps.has('typeorm')) add('typeorm', 'dependency', 'Use an ORM-aware JSON snapshot command from the test datasource.');
  if (deps.has('sequelize')) add('sequelize', 'dependency', 'Use a model/table JSON snapshot command from the test datasource.');
  if (deps.has('knex')) add('knex', 'dependency', 'Use a Knex-based JSON snapshot command from the test datasource.');
  if (deps.has('drizzle-orm')) add('drizzle', 'dependency', 'Use a Drizzle query script that emits stable JSON for tables touched by the case.');
  return out;
}

function detectAuthHints(cwd, routeFiles) {
  const roles = new Set();
  const tenantHeaders = new Set();
  for (const rel of routeFiles.slice(0, 80)) {
    const text = readText(path.resolve(cwd, rel));
    for (const match of text.matchAll(/\b(admin|owner|editor|viewer|user|guest|member|superadmin)\b/gi)) roles.add(match[1].toLowerCase());
    for (const match of text.matchAll(/['"`](x-tenant|x-tenant-id|tenant-id|organization-id|org-id|account-id)['"`]/gi)) tenantHeaders.add(match[1].toLowerCase());
  }
  return {
    roles: [...roles].sort(),
    tenant_headers: [...tenantHeaders].sort(),
  };
}

function detectSafeCommands(pkg) {
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const out = [];
  for (const [name, command] of Object.entries(scripts)) {
    const kind = /(^|:)(dev|start|serve)$/.test(name) ? 'serve'
      : /test|spec/.test(name) ? 'test'
        : /type|check|lint/.test(name) ? 'static'
          : 'other';
    if (kind !== 'other') out.push({ id: `script-${name}`, command: `npm run ${name}`, kind });
  }
  return out;
}

function detectRouteFiles(cwd) {
  const routePatterns = [
    /(^|\/)(routes?|controllers?|api)\//i,
    /(^|\/)(server|app|index)\.(cjs|mjs|js|ts|py|go|rb)$/i,
  ];
  return listFiles(cwd, '.', (rel, abs) => {
    if (!/\.(cjs|mjs|js|ts|py|go|rb)$/.test(rel)) return false;
    if (routePatterns.some((pattern) => pattern.test(rel))) return true;
    const text = readText(abs);
    return /\.(get|post|put|patch|delete)\s*\(|route\s*\(|router\./.test(text) || /@(app|router)\.(get|post|put|patch|delete)/.test(text);
  }, 120);
}

function detectSchemas(cwd) {
  return [
    ...listFiles(cwd, '.', (rel) => /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i.test(rel), 40),
    ...listFiles(cwd, '.', (rel) => /\.graphql$/i.test(rel), 80),
    ...listFiles(cwd, '.', (rel) => /schema\.(prisma|json)$/i.test(rel), 40),
  ].filter((value, index, arr) => arr.indexOf(value) === index).sort();
}

function resolveRef(doc, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (typeof value.$ref !== 'string') return value;
  const parts = value.$ref.replace(/^#\//, '').split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor = doc;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return value;
    cursor = cursor[part];
  }
  return cursor || value;
}

function openApiRequestSchema(doc, operation) {
  const body = operation.requestBody && resolveRef(doc, operation.requestBody);
  const content = body && body.content && typeof body.content === 'object' ? body.content : {};
  const json = content['application/json'] || content['application/*+json'];
  return json && json.schema ? resolveRef(doc, json.schema) : null;
}

function openApiResponseSchemas(doc, operation) {
  const out = {};
  const responses = operation.responses && typeof operation.responses === 'object' ? operation.responses : {};
  for (const [status, response] of Object.entries(responses)) {
    const resolved = resolveRef(doc, response);
    const content = resolved && resolved.content && typeof resolved.content === 'object' ? resolved.content : {};
    const json = content['application/json'] || content['application/*+json'];
    if (json && json.schema) out[status] = resolveRef(doc, json.schema);
  }
  return out;
}

function openApiParameters(doc, pathItem, operation) {
  const values = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  return values
    .map((parameter) => resolveRef(doc, parameter))
    .filter((parameter) => parameter && typeof parameter === 'object' && !Array.isArray(parameter))
    .map((parameter) => ({
      name: typeof parameter.name === 'string' ? parameter.name : '',
      in: typeof parameter.in === 'string' ? parameter.in : '',
      required: parameter.required === true,
      schema: parameter.schema ? resolveRef(doc, parameter.schema) : null,
    }))
    .filter((parameter) => parameter.name && parameter.in);
}

function parseOpenApiOperations(cwd, schemaFiles) {
  const operations = [];
  for (const rel of schemaFiles.filter((file) => /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i.test(file))) {
    const absolute = path.resolve(cwd, rel);
    const doc = parseYamlOrJson(readText(absolute), rel);
    if (!doc || !doc.paths || typeof doc.paths !== 'object') continue;
    for (const [routePath, pathItem] of Object.entries(doc.paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
        const operation = pathItem[method];
        if (!operation || typeof operation !== 'object') continue;
        const responseSchemas = openApiResponseSchemas(doc, operation);
        operations.push({
          id: operation.operationId || `${method}-${routePath}`.replace(/[^a-zA-Z0-9_.-]+/g, '-'),
          method: method.toUpperCase(),
          path: routePath,
          source: rel,
          summary: typeof operation.summary === 'string' ? operation.summary : '',
          tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
          parameters: openApiParameters(doc, pathItem, operation),
          request_schema: openApiRequestSchema(doc, operation),
          response_schemas: responseSchemas,
          response_statuses: Object.keys(operation.responses || {}).sort(),
          security: operation.security || doc.security || [],
        });
      }
    }
  }
  return operations.sort((a, b) => a.id.localeCompare(b.id));
}

function splitGraphqlArgs(text) {
  const args = [];
  let current = '';
  let depth = 0;
  for (const ch of String(text || '')) {
    if (ch === '[' || ch === '(' || ch === '{') depth += 1;
    if (ch === ']' || ch === ')' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (current.trim()) args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function parseGraphqlField(line) {
  const clean = String(line || '').replace(/#.*/, '').trim();
  if (!clean || clean.startsWith('@')) return null;
  const match = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:\s*([^@]+)/);
  if (!match) return null;
  const args = splitGraphqlArgs(match[2]).map((arg) => {
    const argMatch = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=]+)(?:=.*)?$/);
    if (!argMatch) return null;
    const type = argMatch[2].trim();
    return {
      name: argMatch[1],
      type,
      required: /!$/.test(type.trim()),
    };
  }).filter(Boolean);
  return {
    field: match[1],
    args,
    return_type: match[3].trim(),
  };
}

function parseGraphqlOperations(cwd, schemaFiles) {
  const operations = [];
  for (const rel of schemaFiles.filter((file) => /\.graphql$/i.test(file))) {
    const text = readText(path.resolve(cwd, rel));
    for (const typeName of ['Query', 'Mutation', 'Subscription']) {
      const match = text.match(new RegExp(`type\\s+${typeName}\\s*\\{([\\s\\S]*?)\\}`, 'm'));
      if (!match) continue;
      for (const line of match[1].split(/\r?\n/)) {
        const field = parseGraphqlField(line);
        if (!field) continue;
        operations.push({
          id: `${typeName}.${field.field}`,
          operation_type: typeName.toLowerCase(),
          field: field.field,
          args: field.args,
          return_type: field.return_type,
          source: rel,
        });
      }
    }
  }
  return operations.sort((a, b) => a.id.localeCompare(b.id));
}

function scanApiRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkg = readJson(path.join(root, 'package.json'));
  const schemas = detectSchemas(root);
  const routeFiles = detectRouteFiles(root);
  const openapiOperations = parseOpenApiOperations(root, schemas);
  const graphqlOperations = parseGraphqlOperations(root, schemas);
  const databaseAdapters = detectDatabaseAdapters(root, pkg);
  const authHints = detectAuthHints(root, routeFiles);
  const artifacts = [
    pkg ? 'package.json' : null,
    ...schemas,
    ...routeFiles,
  ].filter(Boolean);
  const gaps = [];
  if (schemas.length === 0) gaps.push('no OpenAPI/GraphQL/schema files detected');
  if (routeFiles.length === 0) gaps.push('no obvious API route/controller files detected');
  if (detectSafeCommands(pkg).filter((command) => command.kind === 'serve').length === 0) gaps.push('no obvious local API serve command found');
  if (databaseAdapters.length > 0) gaps.push('database adapter detected; declare adapter-aware db_snapshot or db_snapshot_command for side-effect checks');
  if (authHints.roles.length > 0 || authHints.tenant_headers.length > 0) gaps.push('auth/tenant hints detected; declare role/tenant auth matrix for exhaustive permission checks');
  return {
    schema: 'xoloop.api_scan.v0.1',
    cwd: root,
    frameworks: detectFrameworks(root, pkg),
    safe_commands: detectSafeCommands(pkg),
    route_files: routeFiles,
    schema_files: schemas,
    openapi_operations: openapiOperations,
    graphql_operations: graphqlOperations,
    database_adapters: databaseAdapters,
    auth_hints: authHints,
    artifact_paths: artifacts,
    gaps,
  };
}

module.exports = {
  scanApiRepo,
};
