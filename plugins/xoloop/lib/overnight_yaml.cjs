const fs = require('node:fs');
const path = require('node:path');

const { AdapterError } = require('./errors.cjs');

function loadYamlPackage() {
  try { return require('yaml'); } catch (_err) { return null; }
}

function parseConfigText(text, absolutePath) {
  try {
    return JSON.parse(text);
  } catch (_jsonErr) {
    const YAML = loadYamlPackage();
    if (!YAML) {
      throw new AdapterError(
        'YAML_PACKAGE_MISSING',
        'yamlPath',
        `Cannot parse non-JSON YAML without the optional yaml package: ${absolutePath}`,
        { fixHint: 'Install the yaml package or write this config as JSON-compatible YAML.' },
      );
    }
    return YAML.parse(text);
  }
}

function readYamlFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  const document = parseConfigText(text, absolutePath);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new AdapterError('YAML_NOT_OBJECT', 'yamlPath', `YAML document must be an object: ${absolutePath}`, { fixHint: `Rewrite ${absolutePath} so its top-level is a mapping (key/value object), not a scalar, list, or null.` });
  }
  return {
    absolutePath,
    text,
    document,
  };
}

function writeYamlFile(filePath, payload) {
  const absolutePath = path.resolve(filePath);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AdapterError('YAML_PAYLOAD_NOT_OBJECT', 'payload', `YAML payload must be a plain object: ${absolutePath}`, { fixHint: `Pass a key/value object (not null, an array, or a scalar) to writeYamlFile when writing ${absolutePath}.` });
  }
  const YAML = loadYamlPackage();
  const text = YAML
    ? YAML.stringify(payload, {
        lineWidth: 0,
        minContentWidth: 0,
      })
    : `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(absolutePath, text, 'utf8');
  return absolutePath;
}

module.exports = {
  readYamlFile,
  writeYamlFile,
};
