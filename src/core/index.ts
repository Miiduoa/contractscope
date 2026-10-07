import { parseDocument } from 'yaml';

export const MAX_INPUT_BYTES = 512 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 40;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
type Obj = Record<string, unknown>;
type Direction = 'request' | 'response';
export type Severity = 'breaking' | 'compatible';
export interface Change {
  id: string;
  severity: Severity;
  operation: string;
  location: string;
  rule: string;
  title: string;
  rationale: string;
  before?: string;
  after?: string;
}
export interface Warning {
  source: 'baseline' | 'candidate';
  location: string;
  message: string;
}
export interface Report {
  reportVersion: 1;
  baseline: { title: string; version: string; operationCount: number };
  candidate: { title: string; version: string; operationCount: number };
  status: 'breaking' | 'compatible' | 'incomplete';
  coverage: 'complete-for-supported-rules' | 'incomplete';
  summary: { breaking: number; compatible: number; warnings: number };
  changes: Change[];
  warnings: Warning[];
}
export class ContractError extends Error {}
const obj = (value: unknown): value is Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Obj) => Object.keys(value).sort();
const pointer = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
const stringify = (value: unknown) => JSON.stringify(value);
const annotations = new Set([
  'title',
  'description',
  'example',
  'examples',
  'default',
  'deprecated',
  'externalDocs',
]);

export function parseContract(text: string, label = 'Contract'): Obj {
  if (new TextEncoder().encode(text).byteLength > MAX_INPUT_BYTES)
    throw new ContractError(`${label}: exceeds the 512 KiB input limit.`);
  if (!text.trim())
    throw new ContractError(`${label}: paste or choose an OpenAPI JSON or YAML document.`);
  let value: unknown;
  try {
    const doc = parseDocument(text, { uniqueKeys: true, version: '1.2', strict: true });
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    if (doc.warnings.length) throw new Error(doc.warnings[0].message);
    value = doc.toJS({ maxAliasCount: 40, mapAsMap: true });
  } catch (error) {
    throw new ContractError(
      `${label}: ${error instanceof Error ? error.message : 'cannot parse document'}`,
    );
  }
  let count = 0;
  const ancestors = new Set<object>();
  function visit(node: unknown, depth: number): unknown {
    if (typeof node === 'number' && !Number.isFinite(node)) {
      throw new ContractError(`${label}: non-finite numeric values are not valid JSON values.`);
    }
    if (++count > MAX_NODES || depth > MAX_DEPTH)
      throw new ContractError(`${label}: document exceeds the structural complexity limit.`);
    if (node && typeof node === 'object') {
      if (ancestors.has(node))
        throw new ContractError(`${label}: cyclic YAML aliases are not supported.`);
      ancestors.add(node);
      if (node instanceof Map) {
        const converted = Object.create(null) as Obj;
        for (const [key, child] of node.entries()) {
          if (typeof key !== 'string' && typeof key !== 'number')
            throw new ContractError(`${label}: mapping keys must be strings or numbers.`);
          const normalized = String(key);
          if (Object.hasOwn(converted, normalized))
            throw new ContractError(`${label}: duplicate mapping key ${normalized}.`);
          converted[normalized] = visit(child, depth + 1);
        }
        ancestors.delete(node);
        return converted;
      }
      const converted = Array.isArray(node) ? node.map((child) => visit(child, depth + 1)) : node;
      ancestors.delete(node);
      return converted;
    }
    return node;
  }
  value = visit(value, 0);
  if (!obj(value)) throw new ContractError(`${label}: the document root must be an object.`);
  if (typeof value.openapi !== 'string' || !/^3\.[01]\.\d+$/.test(value.openapi))
    throw new ContractError(`${label}: only OpenAPI 3.0.x and 3.1.x documents are supported.`);
  if (
    !obj(value.info) ||
    typeof value.info.title !== 'string' ||
    typeof value.info.version !== 'string'
  )
    throw new ContractError(`${label}: info.title and info.version must be strings.`);
  if (!obj(value.paths)) throw new ContractError(`${label}: paths must be an object.`);
  return value;
}

interface Schema {
  types: string[];
  enum?: unknown[];
  properties: Map<string, Schema>;
  required: Set<string>;
  closed: boolean;
  items?: Schema;
}
interface Parameter {
  name: string;
  required: boolean;
  schema?: Schema;
  raw: Obj;
}
interface Operation {
  id: string;
  parameters: Map<string, Parameter>;
  body?: { required: boolean; content: Map<string, Schema> };
  responses: Map<string, Map<string, Schema>>;
}

class Reader {
  warnings: Warning[] = [];
  operations = new Map<string, Operation>();
  schemaVisits = 0;
  constructor(
    readonly document: Obj,
    readonly source: Warning['source'],
  ) {}
  warn(location: string, message: string) {
    this.warnings.push({ source: this.source, location, message });
  }
  unexpected(raw: Obj, accepted: string[], location: string) {
    const allowed = new Set([...accepted, ...annotations]);
    for (const key of keys(raw)) {
      if (!allowed.has(key) && !key.startsWith('x-'))
        this.warn(
          `${location}/${pointer(key)}`,
          `The ${key} keyword is outside the supported rules.`,
        );
    }
  }
  resolve(value: unknown, location: string, trail: string[] = []): { raw?: Obj; trail: string[] } {
    if (!obj(value)) {
      this.warn(location, 'Expected an object; this part of the contract was not compared.');
      return { trail };
    }
    if (value.$ref === undefined) return { raw: value, trail };
    if (keys(value).some((key) => key !== '$ref' && !annotations.has(key)))
      this.warn(location, '$ref siblings are not evaluated.');
    const ref = value.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
      this.warn(
        location,
        'Only local JSON Pointer references are resolved. External references are never fetched.',
      );
      return { trail };
    }
    if (trail.includes(ref) || trail.length >= MAX_DEPTH) {
      this.warn(location, `Cyclic or excessively deep reference: ${ref}.`);
      return { trail };
    }
    let target: unknown = this.document;
    try {
      for (const part of decodeURIComponent(ref.slice(2)).split('/')) {
        if (/~(?:[^01]|$)/.test(part)) throw new Error('Invalid JSON pointer escape');
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
        if (!obj(target) || !Object.hasOwn(target, key)) {
          target = undefined;
          break;
        }
        target = target[key];
      }
    } catch {
      target = undefined;
    }
    if (target === undefined) {
      this.warn(location, `Unresolved local reference: ${ref}.`);
      return { trail };
    }
    return this.resolve(target, location, [...trail, ref]);
  }
  schema(value: unknown, location: string, trail: string[] = [], depth = 0): Schema | undefined {
    if (++this.schemaVisits > 10_000) {
      if (this.schemaVisits === 10_001)
        this.warn(
          location,
          'Schema expansion exceeds the 10,000-node budget. Remaining schemas were not compared.',
        );
      return;
    }
    if (depth > MAX_DEPTH) {
      this.warn(location, 'Schema nesting exceeds the supported depth.');
      return;
    }
    const resolved = this.resolve(value, location, trail);
    const raw = resolved.raw;
    if (!raw) return;
    this.unexpected(
      raw,
      ['type', 'nullable', 'enum', 'properties', 'required', 'additionalProperties', 'items'],
      location,
    );
    const validationKeys = keys(raw).filter(
      (key) => !annotations.has(key) && !key.startsWith('x-'),
    );
    if (!validationKeys.length)
      return { types: ['any'], properties: new Map(), required: new Set(), closed: false };
    let types: string[] =
      typeof raw.type === 'string'
        ? [raw.type]
        : Array.isArray(raw.type) && raw.type.every((x) => typeof x === 'string')
          ? (raw.type as string[])
          : [];
    if (
      !types.length ||
      types.some(
        (type) =>
          !['null', 'string', 'boolean', 'integer', 'number', 'object', 'array'].includes(type),
      )
    ) {
      this.warn(location, 'An explicit supported type is needed to compare this schema.');
      return;
    }
    if (
      (Array.isArray(raw.type) || types.includes('null')) &&
      String(this.document.openapi).startsWith('3.0')
    )
      this.warn(location, 'Type arrays and the null type are not valid OpenAPI 3.0 schema types.');
    if (raw.nullable !== undefined) {
      if (String(this.document.openapi).startsWith('3.1'))
        this.warn(
          location,
          'nullable is not a 3.1 validation keyword; use a type array including null.',
        );
      else if (raw.nullable === true) types = [...types, 'null'];
      else if (raw.nullable !== false) this.warn(location, 'nullable must be a boolean.');
    }
    types = [...new Set(types)].sort();
    const result: Schema = {
      types,
      properties: new Map(),
      required: new Set(),
      closed: raw.additionalProperties === false,
    };
    if (raw.enum !== undefined) {
      if (
        !Array.isArray(raw.enum) ||
        raw.enum.length === 0 ||
        raw.enum.some((v) => v !== null && typeof v === 'object')
      )
        this.warn(location, 'Only nonempty enums of primitive values are compared.');
      else
        result.enum = [...new Set(raw.enum.map(stringify))]
          .sort()
          .map((value) => JSON.parse(value));
    }
    if (raw.required !== undefined) {
      if (
        !Array.isArray(raw.required) ||
        !raw.required.every((v) => typeof v === 'string') ||
        new Set(raw.required).size !== raw.required.length
      )
        this.warn(location, 'required must contain unique property names.');
      else result.required = new Set(raw.required as string[]);
    }
    if (types.includes('object')) {
      if (!result.closed)
        this.warn(
          location,
          'Open objects and additionalProperties schemas are outside the closed-object comparison rules.',
        );
      if (raw.properties !== undefined && !obj(raw.properties))
        this.warn(location, 'properties must be an object.');
      const properties = obj(raw.properties) ? raw.properties : {};
      for (const name of keys(properties)) {
        const child = this.schema(
          properties[name],
          `${location}/properties/${pointer(name)}`,
          resolved.trail,
          depth + 1,
        );
        if (child) result.properties.set(name, child);
      }
      for (const name of result.required)
        if (!Object.hasOwn(properties, name))
          this.warn(location, `Required property ${name} has no supported property declaration.`);
    } else if (
      raw.properties !== undefined ||
      raw.required !== undefined ||
      raw.additionalProperties !== undefined
    )
      this.warn(location, 'Object keywords on a non-object schema are not compared.');
    if (types.includes('array')) {
      if (raw.items === undefined)
        this.warn(location, 'Arrays without a supported items schema are not compared.');
      else result.items = this.schema(raw.items, `${location}/items`, resolved.trail, depth + 1);
    } else if (raw.items !== undefined)
      this.warn(location, 'items on a non-array schema is not compared.');
    return result;
  }
  content(value: unknown, location: string): Map<string, Schema> {
    const result = new Map<string, Schema>();
    if (!obj(value)) {
      this.warn(location, 'A content object is required for media type comparison.');
      return result;
    }
    for (const media of keys(value)) {
      const entry = value[media];
      if (!obj(entry)) {
        this.warn(`${location}/${pointer(media)}`, 'Media type declaration must be an object.');
        continue;
      }
      this.unexpected(entry, ['schema'], `${location}/${pointer(media)}`);
      const schema = this.schema(entry.schema ?? {}, `${location}/${pointer(media)}/schema`);
      if (schema) result.set(media, schema);
    }
    return result;
  }
  parameters(value: unknown, location: string): Map<string, Parameter> {
    const result = new Map<string, Parameter>();
    if (value === undefined) return result;
    if (!Array.isArray(value)) {
      this.warn(location, 'parameters must be an array.');
      return result;
    }
    for (const [index, entry] of value.entries()) {
      const at = `${location}/${index}`;
      const { raw } = this.resolve(entry, at);
      if (!raw) continue;
      this.unexpected(raw, ['name', 'in', 'required', 'schema', 'style', 'explode'], at);
      if (
        typeof raw.name !== 'string' ||
        !['path', 'query', 'header', 'cookie'].includes(String(raw.in))
      ) {
        this.warn(at, 'Parameters need a name and a supported location.');
        continue;
      }
      if (raw.required !== undefined && typeof raw.required !== 'boolean')
        this.warn(at, 'Parameter required must be a boolean.');
      if (raw.in === 'path' && raw.required !== true)
        this.warn(at, 'Path parameters must explicitly set required: true.');
      const defaultStyle = raw.in === 'query' || raw.in === 'cookie' ? 'form' : 'simple';
      if (raw.style !== undefined && raw.style !== defaultStyle) {
        this.warn(at, 'Nondefault parameter serialization is outside the supported rules.');
      }
      if (raw.explode !== undefined && typeof raw.explode !== 'boolean') {
        this.warn(at, 'Parameter explode must be a boolean.');
      }
      const name = `${raw.in}:${raw.in === 'header' ? raw.name.toLowerCase() : raw.name}`;
      if (result.has(name))
        this.warn(at, `Duplicate parameter ${name}; the contract is ambiguous.`);
      const schema = this.schema(raw.schema, `${at}/schema`);
      result.set(name, { name, required: raw.required === true || raw.in === 'path', schema, raw });
    }
    return result;
  }
  read(): this {
    this.unexpected(
      this.document,
      ['openapi', 'info', 'paths', 'components', 'servers', 'tags', 'jsonSchemaDialect'],
      '#',
    );
    if (this.document.servers !== undefined)
      this.warn('#/servers', 'Server URL and server-variable compatibility is not evaluated.');
    if (
      this.document.jsonSchemaDialect !== undefined &&
      this.document.jsonSchemaDialect !== 'https://spec.openapis.org/oas/3.1/dialect/base'
    )
      this.warn('#/jsonSchemaDialect', 'This JSON Schema dialect is not supported.');
    const paths = this.document.paths as Obj;
    const pathShapes = new Set<string>();
    for (const path of keys(paths)) {
      if (path.startsWith('x-')) continue;
      const at = `#/paths/${pointer(path)}`;
      if (!path.startsWith('/')) {
        this.warn(at, 'Path keys must start with /.');
        continue;
      }
      const shape = path.replace(/\{[^}]+\}/g, '{}');
      if (pathShapes.has(shape))
        this.warn(at, 'Another path has the same template shape; routing is ambiguous.');
      pathShapes.add(shape);
      const { raw: item } = this.resolve(paths[path], at);
      if (!item) continue;
      this.unexpected(item, [...METHODS, 'parameters', 'summary'], at);
      const shared = this.parameters(item.parameters, `${at}/parameters`);
      for (const method of METHODS) {
        if (item[method] === undefined) continue;
        const raw = item[method];
        if (!obj(raw)) {
          this.warn(`${at}/${method}`, 'Operation must be an object.');
          continue;
        }
        const id = `${method.toUpperCase()} ${path}`;
        const location = `${at}/${method}`;
        this.unexpected(
          raw,
          ['summary', 'operationId', 'tags', 'parameters', 'requestBody', 'responses'],
          location,
        );
        const parameters = new Map([
          ...shared,
          ...this.parameters(raw.parameters, `${location}/parameters`),
        ]);
        for (const match of path.matchAll(/\{([^}]+)\}/g))
          if (!parameters.has(`path:${match[1]}`))
            this.warn(location, `Path template ${match[1]} has no declared path parameter.`);
        for (const parameter of parameters.values())
          if (parameter.raw.in === 'path' && !path.includes(`{${parameter.raw.name}}`))
            this.warn(
              location,
              `Path parameter ${parameter.raw.name} is absent from the path template.`,
            );
        let body: Operation['body'];
        if (raw.requestBody !== undefined) {
          const { raw: request } = this.resolve(raw.requestBody, `${location}/requestBody`);
          if (request) {
            this.unexpected(request, ['required', 'content'], `${location}/requestBody`);
            if (request.required !== undefined && typeof request.required !== 'boolean')
              this.warn(`${location}/requestBody`, 'Request body required must be a boolean.');
            body = {
              required: request.required === true,
              content: this.content(request.content, `${location}/requestBody/content`),
            };
          }
        }
        if (!obj(raw.responses) || !keys(raw.responses).length)
          throw new ContractError(`${this.source}: ${id} needs a nonempty responses object.`);
        const responses = new Map<string, Map<string, Schema>>();
        for (const status of keys(raw.responses)) {
          if (status.startsWith('x-')) continue;
          if (!/^[1-5][0-9]{2}$/.test(status))
            this.warn(
              `${location}/responses/${status}`,
              'Only explicit HTTP status codes are compared; default and status ranges are not evaluated.',
            );
          const { raw: response } = this.resolve(
            raw.responses[status],
            `${location}/responses/${status}`,
          );
          if (!response) continue;
          this.unexpected(response, ['content'], `${location}/responses/${status}`);
          if (typeof response.description !== 'string')
            this.warn(
              `${location}/responses/${status}`,
              'Response description is required by OpenAPI.',
            );
          responses.set(
            status,
            response.content === undefined
              ? new Map()
              : this.content(response.content, `${location}/responses/${status}/content`),
          );
        }
        this.operations.set(id, { id, parameters, body, responses });
      }
    }
    return this;
  }
}

export function compareContracts(baselineText: string, candidateText: string): Report {
  const baseline = new Reader(parseContract(baselineText, 'Baseline'), 'baseline').read();
  const candidate = new Reader(parseContract(candidateText, 'Candidate'), 'candidate').read();
  const changes: Change[] = [];
  const add = (
    operation: string,
    location: string,
    severity: Severity,
    rule: string,
    title: string,
    rationale: string,
    before?: string,
    after?: string,
  ) => {
    changes.push({
      id: '',
      operation,
      location,
      severity,
      rule,
      title,
      rationale,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    });
  };
  const severity = (narrowed: boolean, direction: Direction): Severity =>
    (direction === 'request' ? narrowed : !narrowed) ? 'breaking' : 'compatible';
  function compareSchema(
    a: Schema,
    b: Schema,
    operation: string,
    location: string,
    direction: Direction,
  ) {
    const expanded = (types: string[]) =>
      new Set(
        types.flatMap((type) => (type === 'number' ? ['integer', 'fractional-number'] : [type])),
      );
    const aTypes = expanded(a.types),
      bTypes = expanded(b.types);
    const subset = (left: Set<string>, right: Set<string>) =>
      right.has('any') || (!left.has('any') && [...left].every((type) => right.has(type)));
    if (stringify(a.types) !== stringify(b.types)) {
      const safe = direction === 'request' ? subset(aTypes, bTypes) : subset(bTypes, aTypes);
      add(
        operation,
        location,
        safe ? 'compatible' : 'breaking',
        'schema.type',
        `${direction === 'request' ? 'Request' : 'Response'} type changed`,
        direction === 'request'
          ? safe
            ? 'The candidate keeps every previously accepted type and accepts a wider set.'
            : 'The candidate no longer accepts every previously allowed request type.'
          : safe
            ? 'The candidate returns a narrower set of types within the previous contract.'
            : 'The candidate can return a type outside the previous response contract.',
        a.types.join(' | '),
        b.types.join(' | '),
      );
    }
    if (stringify(a.enum) !== stringify(b.enum)) {
      const subsetEnum = (left?: unknown[], right?: unknown[]) =>
        !right ||
        (!!left &&
          left.every((value) => right.some((other) => stringify(value) === stringify(other))));
      const safe =
        direction === 'request' ? subsetEnum(a.enum, b.enum) : subsetEnum(b.enum, a.enum);
      add(
        operation,
        `${location}/enum`,
        safe ? 'compatible' : 'breaking',
        'schema.enum',
        `${direction === 'request' ? 'Accepted' : 'Returned'} values changed`,
        direction === 'request'
          ? safe
            ? 'The candidate accepts additional values while keeping every previously accepted value.'
            : 'The candidate rejects at least one previously accepted value.'
          : safe
            ? 'The candidate returns fewer possible values, all already allowed by the previous contract.'
            : 'The candidate can return a value that existing clients were not promised to handle.',
        a.enum ? stringify(a.enum) : 'unrestricted',
        b.enum ? stringify(b.enum) : 'unrestricted',
      );
    }
    if (a.types.includes('object') && b.types.includes('object')) {
      for (const name of [...new Set([...a.properties.keys(), ...b.properties.keys()])].sort()) {
        const oldProperty = a.properties.get(name),
          newProperty = b.properties.get(name);
        const at = `${location}/properties/${pointer(name)}`;
        if (!oldProperty && newProperty) {
          const breaking = direction === 'request' ? b.required.has(name) : a.closed;
          add(
            operation,
            at,
            breaking ? 'breaking' : 'compatible',
            'schema.property.added',
            `Property ${name} added`,
            direction === 'request'
              ? breaking
                ? 'Existing requests do not supply this newly required property.'
                : 'Existing requests can omit this optional property.'
              : breaking
                ? 'The previous response object forbids additional properties, so this new property is outside its contract.'
                : 'Coverage for open response objects is incomplete.',
            'absent',
            b.required.has(name) ? 'required' : 'optional',
          );
        } else if (oldProperty && !newProperty) {
          const breaking = direction === 'request' ? b.closed : a.required.has(name);
          add(
            operation,
            at,
            breaking ? 'breaking' : 'compatible',
            'schema.property.removed',
            `Property ${name} removed`,
            direction === 'request'
              ? breaking
                ? 'The candidate forbids additional properties and now rejects this formerly accepted property.'
                : 'Coverage for open request objects is incomplete.'
              : breaking
                ? 'Existing clients are promised this property on every response.'
                : 'Existing clients already need to handle the absence of this optional property.',
            a.required.has(name) ? 'required' : 'optional',
            'absent',
          );
        } else if (oldProperty && newProperty) {
          if (a.required.has(name) !== b.required.has(name)) {
            add(
              operation,
              `${at}/required`,
              severity(b.required.has(name), direction),
              'schema.required',
              `Property ${name} is now ${b.required.has(name) ? 'required' : 'optional'}`,
              direction === 'request'
                ? b.required.has(name)
                  ? 'Existing requests were allowed to omit this property; the candidate requires it.'
                  : 'Existing requests remain valid, and callers can now omit this property.'
                : b.required.has(name)
                  ? 'Responses now guarantee a property that was previously optional.'
                  : 'The candidate can omit a property that existing clients were guaranteed to receive.',
              a.required.has(name) ? 'required' : 'optional',
              b.required.has(name) ? 'required' : 'optional',
            );
          }
          compareSchema(oldProperty, newProperty, operation, at, direction);
        }
      }
    }
    if (a.items && b.items)
      compareSchema(a.items, b.items, operation, `${location}/items`, direction);
  }
  function compareContent(
    a: Map<string, Schema>,
    b: Map<string, Schema>,
    operation: string,
    location: string,
    direction: Direction,
  ) {
    for (const media of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const oldSchema = a.get(media),
        newSchema = b.get(media);
      if (!oldSchema)
        add(
          operation,
          `${location}/${pointer(media)}`,
          direction === 'request' ? 'compatible' : 'breaking',
          'media.added',
          `${direction === 'request' ? 'Accepted' : 'Returned'} media type added`,
          direction === 'request'
            ? 'The endpoint accepts an additional representation.'
            : 'Clients can receive a representation not declared by the previous contract.',
          'absent',
          media,
        );
      else if (!newSchema)
        add(
          operation,
          `${location}/${pointer(media)}`,
          'breaking',
          'media.removed',
          `${direction === 'request' ? 'Accepted' : 'Returned'} media type removed`,
          direction === 'request'
            ? 'Clients using this representation may no longer be accepted.'
            : 'Clients expecting this response representation, including a previously promised body, can no longer rely on it.',
          media,
          'absent',
        );
      else
        compareSchema(
          oldSchema,
          newSchema,
          operation,
          `${location}/${pointer(media)}/schema`,
          direction,
        );
    }
  }
  for (const id of [
    ...new Set([...baseline.operations.keys(), ...candidate.operations.keys()]),
  ].sort()) {
    const a = baseline.operations.get(id),
      b = candidate.operations.get(id);
    if (!a) {
      add(
        id,
        id,
        'compatible',
        'operation.added',
        'Operation added',
        'An additional endpoint does not remove any existing operation.',
        'absent',
        'available',
      );
      continue;
    }
    if (!b) {
      add(
        id,
        id,
        'breaking',
        'operation.removed',
        'Operation removed',
        'Existing clients can no longer call this declared operation.',
        'available',
        'absent',
      );
      continue;
    }
    for (const name of [...new Set([...a.parameters.keys(), ...b.parameters.keys()])].sort()) {
      const oldParam = a.parameters.get(name),
        newParam = b.parameters.get(name);
      const location = `parameters/${name}`;
      if (!oldParam && newParam)
        add(
          id,
          location,
          newParam.required ? 'breaking' : 'compatible',
          'parameter.added',
          `Parameter ${name} added`,
          newParam.required
            ? 'Existing callers do not supply the new required parameter.'
            : 'Existing callers can omit the new optional parameter.',
          'absent',
          newParam.required ? 'required' : 'optional',
        );
      else if (oldParam && !newParam)
        add(
          id,
          location,
          'breaking',
          'parameter.removed',
          `Parameter ${name} removed`,
          'The candidate no longer declares support for a parameter existing callers may send.',
          oldParam.required ? 'required' : 'optional',
          'absent',
        );
      else if (oldParam && newParam) {
        if (oldParam.required !== newParam.required)
          add(
            id,
            location,
            newParam.required ? 'breaking' : 'compatible',
            'parameter.required',
            `Parameter ${name} is now ${newParam.required ? 'required' : 'optional'}`,
            newParam.required
              ? 'Existing callers were allowed to omit this parameter; the candidate requires it.'
              : 'Existing callers remain valid, and can now omit this parameter.',
            oldParam.required ? 'required' : 'optional',
            newParam.required ? 'required' : 'optional',
          );
        const defaultStyle = (p: Parameter) =>
          p.raw.in === 'query' || p.raw.in === 'cookie' ? 'form' : 'simple';
        const style = (p: Parameter) => p.raw.style ?? defaultStyle(p);
        const explode = (p: Parameter) => p.raw.explode ?? style(p) === 'form';
        if (style(oldParam) !== style(newParam) || explode(oldParam) !== explode(newParam))
          candidate.warn(
            `${id}/${location}`,
            'Parameter serialization changed; wire compatibility is not evaluated.',
          );
        if (oldParam.schema && newParam.schema)
          compareSchema(oldParam.schema, newParam.schema, id, `${location}/schema`, 'request');
      }
    }
    if (!a.body && b.body)
      add(
        id,
        'requestBody',
        b.body.required ? 'breaking' : 'compatible',
        'body.added',
        'Request body added',
        b.body.required
          ? 'Existing callers do not send a newly required body.'
          : 'Existing callers can continue without a body.',
        'absent',
        b.body.required ? 'required' : 'optional',
      );
    else if (a.body && !b.body)
      add(
        id,
        'requestBody',
        'breaking',
        'body.removed',
        'Request body removed',
        'The candidate no longer declares support for bodies existing callers may send.',
        'accepted',
        'absent',
      );
    else if (a.body && b.body) {
      if (a.body.required !== b.body.required)
        add(
          id,
          'requestBody/required',
          b.body.required ? 'breaking' : 'compatible',
          'body.required',
          `Request body is now ${b.body.required ? 'required' : 'optional'}`,
          b.body.required
            ? 'Existing callers were allowed to send no body; the candidate requires one.'
            : 'Existing callers remain valid, and can now send a request without a body.',
          a.body.required ? 'required' : 'optional',
          b.body.required ? 'required' : 'optional',
        );
      compareContent(a.body.content, b.body.content, id, 'requestBody/content', 'request');
    }
    for (const status of [...new Set([...a.responses.keys(), ...b.responses.keys()])].sort()) {
      const oldResponse = a.responses.get(status),
        newResponse = b.responses.get(status);
      if (!oldResponse)
        add(
          id,
          `responses/${status}`,
          'breaking',
          'response.added',
          `Response ${status} added`,
          'Existing clients may now receive a status not declared by the previous contract.',
          'absent',
          status,
        );
      else if (!newResponse)
        add(
          id,
          `responses/${status}`,
          'compatible',
          'response.removed',
          `Response ${status} removed`,
          'The set of possible declared response statuses is narrower.',
          status,
          'absent',
        );
      else compareContent(oldResponse, newResponse, id, `responses/${status}/content`, 'response');
    }
  }
  changes.sort(
    (a, b) =>
      a.operation.localeCompare(b.operation, 'en') ||
      a.location.localeCompare(b.location, 'en') ||
      a.rule.localeCompare(b.rule, 'en'),
  );
  changes.forEach((change, index) => (change.id = `change-${String(index + 1).padStart(3, '0')}`));
  const warnings = [...baseline.warnings, ...candidate.warnings].sort(
    (a, b) =>
      a.source.localeCompare(b.source, 'en') ||
      a.location.localeCompare(b.location, 'en') ||
      a.message.localeCompare(b.message, 'en'),
  );
  const summary = {
    breaking: changes.filter((c) => c.severity === 'breaking').length,
    compatible: changes.filter((c) => c.severity === 'compatible').length,
    warnings: warnings.length,
  };
  const metadata = (reader: Reader) => ({
    title: (reader.document.info as Obj).title as string,
    version: (reader.document.info as Obj).version as string,
    operationCount: reader.operations.size,
  });
  return {
    reportVersion: 1,
    baseline: metadata(baseline),
    candidate: metadata(candidate),
    status: summary.breaking ? 'breaking' : warnings.length ? 'incomplete' : 'compatible',
    coverage: warnings.length ? 'incomplete' : 'complete-for-supported-rules',
    summary,
    changes,
    warnings,
  };
}
